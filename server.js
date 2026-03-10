const express = require("express");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);

app.use(express.json({ limit: "200kb" }));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

const XMRIG_HTTP_HOST = process.env.XMRIG_HTTP_HOST || "127.0.0.1";
const XMRIG_HTTP_PORT = Number.parseInt(process.env.XMRIG_HTTP_PORT || "18088", 10);
const MINER_API_URL =
  process.env.MINER_API_URL || `http://${XMRIG_HTTP_HOST}:${XMRIG_HTTP_PORT}`;
const MINER_API_TOKEN = process.env.MINER_API_TOKEN || "";
const HASHVAULT_API_BASE = process.env.HASHVAULT_API_BASE || "https://api.hashvault.pro";
const WALLET_RPC_URL =
  process.env.WALLET_RPC_URL || "http://127.0.0.1:18082/json_rpc";
const WALLET_RPC_USER = process.env.WALLET_RPC_USER || "";
const WALLET_RPC_PASS = process.env.WALLET_RPC_PASS || "";

const DASH_USER = process.env.DASH_USER || "";
const DASH_PASS = process.env.DASH_PASS || "";
const DASH_TOKEN = process.env.DASH_TOKEN || "";

const XMRIG_PATH = process.env.XMRIG_PATH || "";
const XMRIG_ARGS_JSON = process.env.XMRIG_ARGS_JSON || "";
const AUTO_START_MINER = ["1", "true", "yes", "on"].includes(
  String(process.env.AUTO_START_MINER || "").toLowerCase()
);

function isLoopback(remoteAddress) {
  if (!remoteAddress) return false;
  return (
    remoteAddress === "127.0.0.1" ||
    remoteAddress === "::1" ||
    remoteAddress === "::ffff:127.0.0.1"
  );
}

function parseBasicAuth(headerValue) {
  if (!headerValue) return null;
  const [scheme, payload] = headerValue.split(" ");
  if (scheme !== "Basic" || !payload) return null;
  try {
    const decoded = Buffer.from(payload, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1);
    return { user, pass };
  } catch {
    return null;
  }
}

function requireDashboardAuth(req, res, next) {
  if (!DASH_USER && !DASH_PASS) return next();
  const parsed = parseBasicAuth(req.headers.authorization);
  if (parsed && parsed.user === DASH_USER && parsed.pass === DASH_PASS) {
    return next();
  }
  res.setHeader("WWW-Authenticate", 'Basic realm="Monero Dashboard"');
  return res.status(401).send("Authentication required");
}

function requireLocalOrToken(req, res, next) {
  const remote = req.socket?.remoteAddress;
  if (isLoopback(remote)) return next();
  if (DASH_TOKEN) {
    const headerValue = req.headers.authorization || "";
    const [scheme, token] = headerValue.split(" ");
    if (scheme === "Bearer" && token === DASH_TOKEN) return next();
  }
  return res.status(403).json({ error: "Forbidden" });
}

function xmrToAtomic(xmr) {
  const n = Number(xmr);
  if (!Number.isFinite(n) || n <= 0) return null;
  const atomic = Math.round(n * 1e12);
  if (!Number.isSafeInteger(atomic) || atomic <= 0) return null;
  return atomic;
}

function atomicToXmr(atomic) {
  const n = Number(atomic);
  if (!Number.isFinite(n)) return null;
  return n / 1e12;
}

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx < 0) return null;
  return args[idx + 1] ?? null;
}

function getXmrigPoolAndWallet() {
  try {
    const args = parseXmrigArgsJson();
    const pool = getArgValue(args, "-o");
    const wallet = getArgValue(args, "-u");
    return { pool: typeof pool === "string" ? pool : null, wallet: typeof wallet === "string" ? wallet : null };
  } catch {
    return { pool: null, wallet: null };
  }
}

async function fetchHashvaultWalletStats(walletAddress) {
  const url =
    `${HASHVAULT_API_BASE}/v3/monero/wallet/${walletAddress}` +
    "/stats?chart=false&inactivityThreshold=10&order=name&period=daily&poolType=false&workers=false";

  const resp = await fetch(url, { headers: { accept: "application/json" } });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) {
    throw new Error(`HashVault API unavailable (HTTP ${resp.status})`);
  }
  return json;
}

function extractHashvaultUnconfirmedAtomic(unconfirmedBalance) {
  if (typeof unconfirmedBalance === "number") return unconfirmedBalance;
  if (!unconfirmedBalance || typeof unconfirmedBalance !== "object") return null;

  const collectiveTotal =
    typeof unconfirmedBalance.collective?.total === "number"
      ? unconfirmedBalance.collective.total
      : 0;
  const soloTotal =
    typeof unconfirmedBalance.solo?.total === "number"
      ? unconfirmedBalance.solo.total
      : 0;

  const sum = collectiveTotal + soloTotal;
  return sum > 0 ? sum : null;
}

async function walletRpc(method, params) {
  const body = {
    jsonrpc: "2.0",
    id: "0",
    method,
    params: params || {}
  };

  const headers = { "content-type": "application/json" };
  if (WALLET_RPC_USER || WALLET_RPC_PASS) {
    const encoded = Buffer.from(`${WALLET_RPC_USER}:${WALLET_RPC_PASS}`).toString(
      "base64"
    );
    headers.authorization = `Basic ${encoded}`;
  }

  const resp = await fetch(WALLET_RPC_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    throw new Error(
      `wallet-rpc HTTP ${resp.status}: ${json ? JSON.stringify(json) : "n/a"}`
    );
  }
  if (!json || json.error) {
    throw new Error(`wallet-rpc error: ${json ? JSON.stringify(json) : "n/a"}`);
  }
  return json.result;
}

let xmrigProcess = null;
let xmrigLastExit = null;
let xmrigLogBuffer = "";

function appendXmrigLog(chunk) {
  if (!chunk) return;
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  xmrigLogBuffer += text;
  const maxLen = 10000;
  if (xmrigLogBuffer.length > maxLen) {
    xmrigLogBuffer = xmrigLogBuffer.slice(xmrigLogBuffer.length - maxLen);
  }
}

function getXmrigStatus() {
  if (xmrigProcess && xmrigProcess.exitCode === null) {
    return { running: true, pid: xmrigProcess.pid, lastExit: xmrigLastExit };
  }
  return { running: false, pid: null, lastExit: xmrigLastExit };
}

function parseXmrigArgsJson() {
  if (!XMRIG_ARGS_JSON) return [];
  const parsed = JSON.parse(XMRIG_ARGS_JSON);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new Error("XMRIG_ARGS_JSON must be a JSON array of strings");
  }
  return parsed;
}

function validateXmrigArgs(args) {
  const joined = args.join(" ");
  const placeholderPatterns = [
    "<POOL_HOST>:<PORT>",
    "POOL_HOST:PORT",
    "<YOUR_REAL_XMR_ADDRESS>",
    "YOUR_REAL_XMR_ADDRESS"
  ];
  if (placeholderPatterns.some((p) => joined.includes(p))) {
    return {
      ok: false,
      error:
        "XMRIG_ARGS_JSON still contains placeholders. Replace POOL_HOST:PORT and YOUR_REAL_XMR_ADDRESS with real values."
    };
  }

  const poolIdx = args.indexOf("-o");
  const pool = poolIdx >= 0 ? args[poolIdx + 1] : null;
  if (!pool || typeof pool !== "string" || !pool.includes(":")) {
    return {
      ok: false,
      error:
        "Missing pool in XMRIG_ARGS_JSON. Add: \"-o\", \"pool.example.com:3333\""
    };
  }
  if (pool.includes("<") || pool.includes(">")) {
    return { ok: false, error: "Pool contains invalid characters: < or >" };
  }

  const userIdx = args.indexOf("-u");
  const wallet = userIdx >= 0 ? args[userIdx + 1] : null;
  if (!wallet || typeof wallet !== "string") {
    return {
      ok: false,
      error:
        "Missing wallet address in XMRIG_ARGS_JSON. Add: \"-u\", \"YOUR_XMR_ADDRESS\""
    };
  }
  if (wallet.includes("<") || wallet.includes(">")) {
    return { ok: false, error: "Wallet contains invalid characters: < or >" };
  }
  if (wallet.length < 90) {
    return {
      ok: false,
      error:
        "Wallet address looks too short. Use a real Monero address (usually starts with 4 or 8)."
    };
  }

  return { ok: true };
}

function validateXmrigPath() {
  if (!XMRIG_PATH) return { ok: false, error: "XMRIG_PATH not set" };
  const resolved = path.isAbsolute(XMRIG_PATH)
    ? XMRIG_PATH
    : path.resolve(process.cwd(), XMRIG_PATH);

  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `XMRIG_PATH not found: ${resolved}` };
  }

  if (!stat.isFile()) {
    return { ok: false, error: `XMRIG_PATH must be a file (binary): ${resolved}` };
  }

  try {
    fs.accessSync(resolved, fs.constants.X_OK);
  } catch {
    return { ok: false, error: `XMRIG_PATH is not executable: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

async function fetchMinerSummary() {
  const headers = { accept: "application/json" };
  if (MINER_API_TOKEN) {
    headers.authorization = `Bearer ${MINER_API_TOKEN}`;
  }
  const resp = await fetch(`${MINER_API_URL}/1/summary`, {
    headers
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) {
    throw new Error(`miner API unavailable (HTTP ${resp.status})`);
  }
  return json;
}

function spawnXmrig() {
  if (xmrigProcess && xmrigProcess.exitCode === null) {
    return { ok: false, status: 409, error: "Miner already running" };
  }
  const xmrigPath = validateXmrigPath();
  if (!xmrigPath.ok) return { ok: false, status: 400, error: xmrigPath.error };

  let extraArgs = [];
  try {
    extraArgs = parseXmrigArgsJson();
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "Invalid XMRIG_ARGS_JSON"
    };
  }

  const argsValidation = validateXmrigArgs(extraArgs);
  if (!argsValidation.ok) {
    return { ok: false, status: 400, error: argsValidation.error };
  }

  const args = [
    "--http-enabled",
    "--http-host",
    XMRIG_HTTP_HOST,
    "--http-port",
    String(XMRIG_HTTP_PORT),
    ...extraArgs
  ];

  xmrigLastExit = null;
  xmrigLogBuffer = "";
  xmrigProcess = spawn(xmrigPath.path, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  xmrigProcess.stdout?.on("data", appendXmrigLog);
  xmrigProcess.stderr?.on("data", appendXmrigLog);

  xmrigProcess.on("exit", (code, signal) => {
    xmrigLastExit = { code, signal, at: new Date().toISOString() };
  });

  xmrigProcess.on("error", (err) => {
    xmrigLastExit = { code: null, signal: null, error: err.message };
  });

  return {
    ok: true,
    status: 200,
    args,
    pid: xmrigProcess.pid,
    xmrigPath: xmrigPath.path
  };
}

app.use(requireDashboardAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/miner/summary", async (req, res) => {
  try {
    const summary = await fetchMinerSummary();
    res.json({ ok: true, summary, process: getXmrigStatus() });
  } catch (err) {
    res.json({
      ok: false,
      error: "Miner API not reachable",
      details: err instanceof Error ? err.message : String(err),
      process: getXmrigStatus(),
      xmrigLog: xmrigLogBuffer ? xmrigLogBuffer.slice(-4000) : ""
    });
  }
});

app.get("/api/pool/stats", async (req, res) => {
  const { pool, wallet } = getXmrigPoolAndWallet();
  const walletAddress =
    typeof req.query.wallet === "string" && req.query.wallet.length > 0
      ? req.query.wallet
      : wallet;

  const provider =
    typeof req.query.provider === "string" && req.query.provider.length > 0
      ? req.query.provider
      : pool && pool.includes("hashvault")
        ? "hashvault"
        : "hashvault";

  if (!walletAddress) {
    return res.json({
      ok: false,
      provider,
      pool,
      wallet: null,
      error: "Wallet address not available for pool stats"
    });
  }

  if (provider !== "hashvault") {
    return res.json({
      ok: false,
      provider,
      pool,
      wallet: walletAddress,
      error: "Unsupported pool provider"
    });
  }

  try {
    const stats = await fetchHashvaultWalletStats(walletAddress);
    const revenue = stats?.revenue || {};
    const collective = stats?.collective || {};

    const confirmedAtomic = revenue.confirmedBalance ?? null;
    const unconfirmedAtomic =
      extractHashvaultUnconfirmedAtomic(revenue.unconfirmedBalance) ??
      revenue.pendingBalance ??
      null;
    const paidAtomic =
      revenue.totalPaid ?? revenue.paid ?? revenue.totalPayments ?? null;
    const thresholdAtomic =
      revenue.payoutThreshold ?? revenue.payoutThresholdMin ?? null;

    res.json({
      ok: true,
      provider,
      pool,
      wallet: walletAddress,
      hashrate_kh:
        typeof collective.hashRate === "number"
          ? collective.hashRate / 1000
          : null,
      confirmed_xmr: atomicToXmr(confirmedAtomic),
      unconfirmed_xmr: atomicToXmr(unconfirmedAtomic),
      paid_xmr: atomicToXmr(paidAtomic),
      payout_threshold_xmr: atomicToXmr(thresholdAtomic),
      raw: {
        collective,
        revenue
      }
    });
  } catch (err) {
    res.json({
      ok: false,
      provider,
      pool,
      wallet: walletAddress,
      error: "Pool API not reachable",
      details: err instanceof Error ? err.message : String(err)
    });
  }
});

app.post("/api/miner/start", requireLocalOrToken, (req, res) => {
  const started = spawnXmrig();
  if (!started.ok) return res.status(started.status).json({ error: started.error });

  const payload = { ok: true, ...started };
  delete payload.status;

  setTimeout(() => {
    if (!xmrigProcess || xmrigProcess.exitCode !== null) {
      return res.status(502).json({
        error: "XMRig exited immediately",
        lastExit: xmrigLastExit,
        xmrigLog: xmrigLogBuffer ? xmrigLogBuffer.slice(-4000) : ""
      });
    }
    res.json(payload);
  }, 400);
});

app.post("/api/miner/stop", requireLocalOrToken, (req, res) => {
  if (!xmrigProcess || xmrigProcess.exitCode !== null) {
    return res.status(409).json({ error: "Miner not running" });
  }
  xmrigProcess.kill("SIGTERM");
  res.json({ ok: true });
});

app.get("/api/wallet/balance", async (req, res) => {
  try {
    const accountIndex = Number.parseInt(req.query.accountIndex || "0", 10);
    const result = await walletRpc("get_balance", {
      account_index: Number.isFinite(accountIndex) ? accountIndex : 0
    });
    res.json({
      ok: true,
      balance: result.balance,
      unlocked_balance: result.unlocked_balance,
      balance_xmr: atomicToXmr(result.balance),
      unlocked_balance_xmr: atomicToXmr(result.unlocked_balance)
    });
  } catch (err) {
    res.json({
      ok: false,
      error: "Wallet RPC not reachable",
      details: err instanceof Error ? err.message : String(err)
    });
  }
});

app.post("/api/wallet/transfer", requireLocalOrToken, async (req, res) => {
  const address = typeof req.body?.address === "string" ? req.body.address : "";
  const amountXmr = req.body?.amountXmr;
  const sweepAll = Boolean(req.body?.sweepAll);
  const accountIndex = Number.parseInt(req.body?.accountIndex ?? "0", 10);
  const priority = Number.parseInt(req.body?.priority ?? "0", 10);

  if (!address || address.length < 50) {
    return res.status(400).json({ error: "Invalid destination address" });
  }
  if (!Number.isFinite(accountIndex) || accountIndex < 0) {
    return res.status(400).json({ error: "Invalid accountIndex" });
  }
  if (!Number.isFinite(priority) || priority < 0 || priority > 3) {
    return res.status(400).json({ error: "Invalid priority (0-3)" });
  }

  try {
    if (sweepAll) {
      const result = await walletRpc("sweep_all", {
        address,
        account_index: accountIndex,
        priority
      });
      return res.json({ ok: true, result });
    }

    const amountAtomic = xmrToAtomic(amountXmr);
    if (!amountAtomic) {
      return res.status(400).json({ error: "Invalid amountXmr" });
    }

    const result = await walletRpc("transfer", {
      destinations: [{ address, amount: amountAtomic }],
      account_index: accountIndex,
      priority,
      get_tx_key: true
    });
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({
      error: "Transfer failed",
      details: err instanceof Error ? err.message : String(err)
    });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`Dashboard running on http://${HOST}:${PORT}`);
  console.log(`Miner API: ${MINER_API_URL}`);
  console.log(`Wallet RPC: ${WALLET_RPC_URL}`);

  if (AUTO_START_MINER) {
    const started = spawnXmrig();
    if (!started.ok) {
      console.log(`AUTO_START_MINER failed: ${started.error}`);
    } else {
      console.log(`AUTO_START_MINER pid: ${started.pid}`);
    }
  }
});

server.on("error", (err) => {
  if (err && typeof err === "object" && err.code === "EADDRINUSE") {
    console.error(
      `Port already in use: ${HOST}:${PORT}. Stop the other process or run with PORT=3001.`
    );
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
