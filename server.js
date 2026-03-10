const express = require("express");
const { spawn } = require("node:child_process");
const path = require("node:path");

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", false);

app.use(express.json({ limit: "200kb" }));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "3000", 10);

const MINER_API_URL = process.env.MINER_API_URL || "http://127.0.0.1:18088";
const MINER_API_TOKEN = process.env.MINER_API_TOKEN || "";
const WALLET_RPC_URL =
  process.env.WALLET_RPC_URL || "http://127.0.0.1:18082/json_rpc";
const WALLET_RPC_USER = process.env.WALLET_RPC_USER || "";
const WALLET_RPC_PASS = process.env.WALLET_RPC_PASS || "";

const DASH_USER = process.env.DASH_USER || "";
const DASH_PASS = process.env.DASH_PASS || "";
const DASH_TOKEN = process.env.DASH_TOKEN || "";

const XMRIG_PATH = process.env.XMRIG_PATH || "";
const XMRIG_ARGS_JSON = process.env.XMRIG_ARGS_JSON || "";

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

app.use(requireDashboardAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.get("/api/miner/summary", async (req, res) => {
  try {
    const summary = await fetchMinerSummary();
    res.json({ summary, process: getXmrigStatus() });
  } catch (err) {
    res.status(503).json({
      error: "Miner API not reachable",
      details: err instanceof Error ? err.message : String(err),
      process: getXmrigStatus()
    });
  }
});

app.post("/api/miner/start", requireLocalOrToken, (req, res) => {
  if (xmrigProcess && xmrigProcess.exitCode === null) {
    return res.status(409).json({ error: "Miner already running" });
  }
  if (!XMRIG_PATH) {
    return res.status(400).json({ error: "XMRIG_PATH not set" });
  }

  let extraArgs = [];
  try {
    extraArgs = parseXmrigArgsJson();
  } catch (err) {
    return res.status(400).json({
      error: err instanceof Error ? err.message : "Invalid XMRIG_ARGS_JSON"
    });
  }

  const args = [
    "--http-enabled",
    "--http-host",
    "127.0.0.1",
    "--http-port",
    "18088",
    ...extraArgs
  ];

  xmrigLastExit = null;
  xmrigProcess = spawn(XMRIG_PATH, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  xmrigProcess.on("exit", (code, signal) => {
    xmrigLastExit = { code, signal, at: new Date().toISOString() };
  });

  xmrigProcess.on("error", (err) => {
    xmrigLastExit = { code: null, signal: null, error: err.message };
  });

  res.json({ ok: true, args, pid: xmrigProcess.pid });
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
      balance: result.balance,
      unlocked_balance: result.unlocked_balance,
      balance_xmr: atomicToXmr(result.balance),
      unlocked_balance_xmr: atomicToXmr(result.unlocked_balance)
    });
  } catch (err) {
    res.status(503).json({
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

app.listen(PORT, HOST, () => {
  console.log(`Dashboard running on http://${HOST}:${PORT}`);
  console.log(`Miner API: ${MINER_API_URL}`);
  console.log(`Wallet RPC: ${WALLET_RPC_URL}`);
});
