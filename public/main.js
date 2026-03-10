function formatNumber(n) {
  if (n === null || n === undefined) return "-";
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(
    num
  );
}

function setGlobalStatus(ok, text) {
  const dot = document.getElementById("globalDot");
  const label = document.getElementById("globalText");
  dot.classList.remove("ok", "bad");
  dot.classList.add(ok ? "ok" : "bad");
  label.textContent = text;
}

function getToken() {
  return localStorage.getItem("dash_token") || "";
}

function setToken(value) {
  localStorage.setItem("dash_token", value || "");
}

function authHeaders() {
  const token = getToken().trim();
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

async function jsonFetch(url, options) {
  const resp = await fetch(url, options);
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const message =
      (json && (json.error || json.details)) ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new Error(message);
  }
  return json;
}

function renderKv(el, entries) {
  el.innerHTML = "";
  for (const [k, v] of entries) {
    const kEl = document.createElement("div");
    kEl.className = "k";
    kEl.textContent = k;
    const vEl = document.createElement("div");
    vEl.className = "v";
    vEl.textContent = v;
    el.appendChild(kEl);
    el.appendChild(vEl);
  }
}

function minerStatsToEntries(summaryPayload) {
  const summary = summaryPayload?.summary;
  const proc = summaryPayload?.process;
  const entries = [];

  entries.push([
    "Process",
    proc?.running ? `Running (pid ${proc.pid})` : "Not running"
  ]);

  if (!summary) {
    entries.push(["API", "Not reachable"]);
    if (proc?.lastExit) entries.push(["Last exit", JSON.stringify(proc.lastExit)]);
    return entries;
  }

  const hashrateTotal = summary?.hashrate?.total;
  const h10s = Array.isArray(hashrateTotal) ? hashrateTotal[0] : null;
  const h60s = Array.isArray(hashrateTotal) ? hashrateTotal[1] : null;
  const h15m = Array.isArray(hashrateTotal) ? hashrateTotal[2] : null;

  entries.push(["Version", String(summary.version || "-")]);
  entries.push(["Uptime (s)", formatNumber(summary.uptime)]);
  entries.push(["Pool", String(summary?.connection?.pool || "-")]);
  entries.push(["Hashrate 10s (H/s)", formatNumber(h10s)]);
  entries.push(["Hashrate 60s (H/s)", formatNumber(h60s)]);
  entries.push(["Hashrate 15m (H/s)", formatNumber(h15m)]);
  entries.push([
    "Shares",
    `${summary?.results?.shares_good ?? "-"} / ${summary?.results?.shares_total ?? "-"}`
  ]);
  entries.push(["Diff", formatNumber(summary?.results?.diff_current)]);
  return entries;
}

async function refreshMiner() {
  const kv = document.getElementById("minerKv");
  const raw = document.getElementById("minerRaw");
  try {
    const data = await jsonFetch("/api/miner/summary");
    renderKv(kv, minerStatsToEntries(data));
    raw.hidden = true;
    setGlobalStatus(true, "OK");
  } catch (err) {
    renderKv(kv, minerStatsToEntries({ summary: null, process: null }));
    raw.hidden = false;
    raw.textContent = err instanceof Error ? err.message : String(err);
    setGlobalStatus(false, "Miner API unavailable");
  }
}

async function refreshWallet() {
  const kv = document.getElementById("walletKv");
  try {
    const data = await jsonFetch("/api/wallet/balance");
    renderKv(kv, [
      ["Balance (XMR)", formatNumber(data.balance_xmr)],
      ["Unlocked (XMR)", formatNumber(data.unlocked_balance_xmr)],
      ["Balance (atomic)", String(data.balance)],
      ["Unlocked (atomic)", String(data.unlocked_balance)]
    ]);
  } catch (err) {
    renderKv(kv, [["Wallet", "RPC unavailable"]]);
  }
}

async function startMiner() {
  await jsonFetch("/api/miner/start", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: "{}"
  });
}

async function stopMiner() {
  await jsonFetch("/api/miner/stop", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: "{}"
  });
}

async function transfer({ address, amountXmr, sweepAll, priority }) {
  return jsonFetch("/api/wallet/transfer", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ address, amountXmr, sweepAll, priority })
  });
}

function showTransferResult(value) {
  const el = document.getElementById("transferResult");
  el.hidden = false;
  el.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function init() {
  const tokenInput = document.getElementById("tokenInput");
  tokenInput.value = getToken();
  tokenInput.addEventListener("change", () => setToken(tokenInput.value));

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    await refreshMiner();
    await refreshWallet();
  });

  document.getElementById("startBtn").addEventListener("click", async () => {
    try {
      await startMiner();
      await refreshMiner();
    } catch (err) {
      setGlobalStatus(false, err instanceof Error ? err.message : "Start failed");
    }
  });

  document.getElementById("stopBtn").addEventListener("click", async () => {
    try {
      await stopMiner();
      await refreshMiner();
    } catch (err) {
      setGlobalStatus(false, err instanceof Error ? err.message : "Stop failed");
    }
  });

  document.getElementById("balanceBtn").addEventListener("click", refreshWallet);

  document.getElementById("sendBtn").addEventListener("click", async () => {
    const address = document.getElementById("toAddress").value.trim();
    const amountXmr = document.getElementById("amountXmr").value.trim();
    const priority = Number.parseInt(
      document.getElementById("priority").value,
      10
    );

    try {
      const result = await transfer({
        address,
        amountXmr,
        sweepAll: false,
        priority
      });
      showTransferResult(result);
      await refreshWallet();
    } catch (err) {
      showTransferResult(err instanceof Error ? err.message : String(err));
    }
  });

  document.getElementById("sweepBtn").addEventListener("click", async () => {
    const address = document.getElementById("toAddress").value.trim();
    const priority = Number.parseInt(
      document.getElementById("priority").value,
      10
    );

    try {
      const result = await transfer({
        address,
        amountXmr: null,
        sweepAll: true,
        priority
      });
      showTransferResult(result);
      await refreshWallet();
    } catch (err) {
      showTransferResult(err instanceof Error ? err.message : String(err));
    }
  });

  refreshMiner();
  refreshWallet();
  setInterval(() => refreshMiner(), 5000);
}

init();

