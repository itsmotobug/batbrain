const https = require("node:https");
const readline = require("node:readline");
const { performance } = require("node:perf_hooks");
const strat = require("./strategy");

const API_KEY = process.env.PUMPPORTAL_API_KEY;
const LIVE = process.env.LIVE_TRADING === "1";
const HOST = "pumpportal.fun";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const DEFAULT_WALLET = process.env.PUBLIC_WALLET_KEY || process.env.PUMPPORTAL_WALLET_PUBLIC_KEY;
const DEFAULT_SOL_USD = Number(process.env.SOL_TO_USDC || process.env.SOL_USD_PRICE || 150);
let solUsdRate = Number.isFinite(DEFAULT_SOL_USD) && DEFAULT_SOL_USD > 0 ? DEFAULT_SOL_USD : 150;
const MAX_BUY = 0.01;
const DEFAULT_BUY = Number(process.env.DEFAULT_BUY_SOL || 0.005);
const MAX_SESSION_SOL = Number(process.env.MAX_SESSION_SOL || 0.05);
const KEEPALIVE_MS = 20_000;
const SOL_RATE_REFRESH_MS = 30_000;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// One persistent TLS connection, reused for every order.
const agent = new https.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 30_000 });

let armed = false;
let spentSol = 0;

function validate(action, mint, amount) {
  if (action !== "buy" && action !== "sell") {
    throw new Error("Action must be buy or sell");
  }
  if (typeof mint !== "string" || mint.length < 32 || mint.length > 44) {
    throw new Error("Invalid token address length");
  }

  if (action === "buy") {
    const sol = Number(amount);
    if (!Number.isFinite(sol) || sol <= 0 || sol > MAX_BUY) {
      throw new Error(`Buy limit: ${MAX_BUY} SOL`);
    }
    return { amount: sol, denominated: "true" };
  }

  if (amount !== "100%") {
    throw new Error("Only 100% sells supported");
  }
  return { amount, denominated: "false" };
}

function buildPayload(action, mint, amount) {
  const { amount: amt, denominated } = validate(action, mint, amount);
  return {
    action,
    mint,
    amount: amt,
    denominatedInSol: denominated,
    slippage: 5,
    priorityFee: 0.00005,
    pool: "auto",
    skipPreflight: "false",
  };
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request(
      {
        host: HOST,
        method,
        path,
        agent,
        timeout: 30_000,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") })
        );
      }
    );
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Opens the TLS connection ahead of time so the first order skips the handshake.
async function warmUp() {
  const t = performance.now();
  try {
    await request("HEAD", "/");
    return performance.now() - t;
  } catch {
    return null;
  }
}

async function solanaRpc(method, params) {
  const res = await fetch(SOLANA_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    throw new Error(`Solana RPC failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`Solana RPC error: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data.result;
}

async function fetchWalletBalances(publicKey) {
  const key = (publicKey || DEFAULT_WALLET || "").trim();
  if (!key) {
    throw new Error("No wallet configured. Set PUBLIC_WALLET_KEY.");
  }

  const lamports = Number((await solanaRpc("getBalance", [key])).value || 0);
  const sol = lamports / 1e9;

  let usdc = 0;
  try {
    const tokenAccounts = await solanaRpc("getTokenAccountsByOwner", [key, { mint: USDC_MINT }, { encoding: "jsonParsed" }]);
    for (const entry of tokenAccounts.value || []) {
      const amount = Number(entry.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
      usdc += amount;
    }
  } catch (err) {
    usdc = 0;
  }

  return {
    publicKey: key,
    sol,
    usdc,
    raw: {
      balance: lamports,
      usdcMint: USDC_MINT,
      rpc: SOLANA_RPC_URL,
    },
  };
}

async function refreshSolUsdRate() {
  const override = Number(process.env.SOL_TO_USDC || process.env.SOL_USD_PRICE);
  if (Number.isFinite(override) && override > 0) {
    solUsdRate = override;
    return solUsdRate;
  }

  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const next = Number(data?.solana?.usd);
    if (Number.isFinite(next) && next > 0) solUsdRate = next;
  } catch {
    // Keep the last known rate; if nothing is configured, fall back to the default approximation.
  }
  return solUsdRate;
}

function usdValue(solValue) {
  return (Number(solValue) || 0) * solUsdRate;
}

function deriveTokenPriceSol(marketRecord) {
  const marketCapSol = Number(marketRecord?.marketCapSol);
  const supply = Number(marketRecord?.totalSupply ?? marketRecord?.supply ?? marketRecord?.circulatingSupply ?? 0);
  if (!Number.isFinite(marketCapSol) || marketCapSol <= 0) return null;
  if (!Number.isFinite(supply) || supply <= 0) return null;
  return marketCapSol / supply;
}

function compactNumber(value, digits = 2) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(digits).replace(/\.?0+$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${(n / 1_000).toFixed(digits).replace(/\.?0+$/, "")}K`;
  }
  return Number.isInteger(n) ? String(n) : n.toFixed(digits).replace(/\.?0+$/, "");
}

async function sendOrder(payload) {
  const t0 = performance.now();
  const res = await request("POST", `/api/trade?api-key=${encodeURIComponent(API_KEY)}`, payload);
  const ms = performance.now() - t0;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Trade request failed: HTTP ${res.status} ${res.text.slice(0, 800)}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(res.text);
  } catch {
    parsed = res.text;
  }
  return { parsed, ms };
}

async function execute(action, mint, amount) {
  const payload = buildPayload(action, mint, amount);

  if (!LIVE) {
    console.log("SIMULATION: no trade sent");
    console.log(payload);
    return;
  }
  if (!API_KEY) throw new Error("Missing API key");
  if (!armed) throw new Error("Not armed. Type: arm");

  if (action === "buy") {
    if (spentSol + payload.amount > MAX_SESSION_SOL) {
      throw new Error(
        `Session cap reached (${spentSol.toFixed(4)}/${MAX_SESSION_SOL} SOL spent). Restart to reset.`
      );
    }
    spentSol += payload.amount;
  }

  try {
    const { parsed, ms } = await sendOrder(payload);
    console.log(parsed);
    console.log(`Order round-trip: ${ms.toFixed(0)} ms`);
  } catch (err) {
    if (action === "buy") spentSol -= payload.amount;
    throw err;
  }
}

function printHelp() {
  console.log(`Commands:
  <MINT>              set the current mint for this session (no order sent)
  buy [SOL]           buy current mint (default ${DEFAULT_BUY} SOL, max ${MAX_BUY} per order)
  sell                sell 100% of current mint
  buy/sell <MINT>     same, and also sets the current mint
  mint                show current mint
  balance             show SOL + USDC balance for the linked wallet
  strategy            show strategy settings; "strategy modes" lists buying modes
  strategy mode <m>   choose buying mode (dip, breakout, momentum, ladder, dca)
  set <key> <value>   change a strategy setting (saved to strategy.json)
  watch               watch the current mint's price and buy per the strategy
  unwatch             stop watching
  mcap                show latest market-cap estimate + token price estimate
  pnl                 show average cost, position qty, and unrealized PnL
  arm                 enable live orders for this session (asks for TRADE)
  disarm              disable live orders
  status              show mode, armed state, spend, current mint
  help, quit`);
}

let currentMint = null;
const config = strat.loadConfig();
let engine = null;
let feed = null;
let watchTimer = null;
let solRateTimer = null;
let busy = false;
let failures = 0;
let lastPrintAt = 0;

function looksLikeMint(s) {
  return typeof s === "string" && s.length >= 32 && s.length <= 44;
}

function setMint(mint) {
  if (mint !== currentMint && feed) {
    stopWatch();
    console.log("Watch stopped because the current mint changed.");
  }
  currentMint = mint;
  console.log(`Current mint: ${mint}`);
}

// Accepts "[MINT] [SOL]" or "[SOL]"; a mint argument also becomes the current mint.
function resolveTarget(a, b) {
  let amount = b;
  if (looksLikeMint(a)) {
    if (a !== currentMint) setMint(a);
  } else if (a !== undefined) {
    amount = a;
  }
  if (!currentMint) throw new Error("No current mint. Paste a mint first.");
  return { mint: currentMint, amount };
}

function showStrategy() {
  console.log(`Mode: ${config.mode} - ${strat.MODES[config.mode]}`);
  console.log(config);
}

function stopWatch() {
  if (feed) feed.stop();
  clearInterval(watchTimer);
  clearInterval(solRateTimer);
  feed = null;
  watchTimer = null;
  solRateTimer = null;
  engine = null;
}

async function maybeBuy(now) {
  if (!engine || busy) return;
  const signal = engine.check(now);
  if (!signal) return;

  busy = true;
  try {
    console.log(`\n[strategy] BUY signal: ${signal.reason} @ ${compactNumber(usdValue(engine.lastPrice), 2)} USDC mcap`);
    await execute("buy", currentMint, config.buySol);
    failures = 0;
    engine.markBought(now);
    if (engine.done) {
      console.log(`[strategy] maxBuys (${config.maxBuys}) reached. Watch stopped.`);
      stopWatch();
    }
  } catch (e) {
    console.error(`[strategy] order failed: ${e.message}`);
    if (engine) engine.lastBuyAt = now;
    if (++failures >= 3) {
      console.error("[strategy] 3 failures in a row. Watch stopped.");
      stopWatch();
    }
  } finally {
    busy = false;
  }
}

async function startWatch() {
  if (feed) throw new Error("Already watching. Type unwatch first.");
  if (!currentMint) throw new Error("No current mint. Paste a mint first.");
  if (!API_KEY) throw new Error("Missing API key (needed for the price feed).");
  if (config.buySol > MAX_BUY) throw new Error(`buySol exceeds the ${MAX_BUY} SOL per-order limit.`);
  if (LIVE && !armed) throw new Error("Not armed. Type: arm");

  await refreshSolUsdRate();
  engine = new strat.Strategy(config);
  failures = 0;
  solRateTimer = setInterval(() => void refreshSolUsdRate(), SOL_RATE_REFRESH_MS);
  feed = new strat.PriceFeed({
    apiKey: API_KEY,
    mint: currentMint,
    onStatus: (m) => {
      console.log(`[feed] ${m}`);
      if (/only available/i.test(m)) {
        stopWatch();
        console.error("[feed] Price data needs the API key's wallet funded with at least 0.02 SOL. Watch stopped.");
      }
    },
    onPrice: (price, marketRecord) => {
      const now = Date.now();
      if (!engine) return;
      engine.record(now, price, marketRecord);
      if (now - lastPrintAt > 5000) {
        lastPrintAt = now;
        const p = engine.positionSummary;
        const priceUsdc = usdValue(p.markPrice || 0);
        const avgUsdc = usdValue(p.avgCostSol || 0);
        const pnlUsdc = usdValue(p.pnlSol || 0);
        const tokenPriceSol = deriveTokenPriceSol(marketRecord);
        const tokenPriceUsdc = tokenPriceSol === null ? null : usdValue(tokenPriceSol);
        const priceText = tokenPriceUsdc === null ? "price=n/a" : `price=${compactNumber(tokenPriceUsdc, 2)} USDC`;
        console.log(
          `[mcap] mcap=${compactNumber(priceUsdc, 2)} USDC ${priceText} ` +
            `qty=${p.qty.toFixed(4)} ` +
            `avg=${compactNumber(avgUsdc, 2)} USDC ` +
            `pnl=${compactNumber(pnlUsdc, 2)} USDC`
        );
      }
      maybeBuy(now);
    },
  });
  feed.start();
  // Drives time-based modes (dca) and re-checks when no trades arrive.
  watchTimer = setInterval(() => maybeBuy(Date.now()), 1000);
  console.log(
    `Watching ${currentMint} in ${config.mode} mode (${LIVE ? "LIVE" : "SIMULATION"}). ` +
      `${config.maxBuys > 0 ? `Max ${config.maxBuys} buys` : "Unlimited buys"} of ${config.buySol} SOL each.`
  );
}

function handleStrategy(a, b) {
  if (!a) return showStrategy();
  if (a === "modes") {
    for (const [m, d] of Object.entries(strat.MODES)) console.log(`  ${m.padEnd(9)} ${d}`);
    return;
  }
  if (a === "mode") {
    applyConfig({ mode: b });
    return showStrategy();
  }
  throw new Error("Usage: strategy | strategy modes | strategy mode <name>");
}

function applyConfig(change) {
  const next = strat.normalize({ ...config, ...change });
  Object.assign(config, next);
  strat.saveConfig(config);
}

async function handle(line, rl) {
  if (!line) return;
  const [cmd, a, b] = line.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case "help":
      return printHelp();
    case "quit":
    case "exit":
      stopWatch();
      return rl.close();
    case "mint":
      return console.log(currentMint ? `Current mint: ${currentMint}` : "No current mint set.");
    case "balance": {
      try {
        const wallet = await fetchWalletBalances(a || DEFAULT_WALLET);
        console.log(`wallet=${wallet.publicKey}`);
        console.log(`SOL=${compactNumber(wallet.sol, 2)}`);
        console.log(`USDC=${compactNumber(wallet.usdc, 2)}`);
        console.log(`rawBalanceLamports=${wallet.raw.balance}`);
        console.log(`rpc=${wallet.raw.rpc}`);
        return;
      } catch (e) {
        throw new Error(`Balance lookup failed: ${e.message}`);
      }
    }
    case "strategy":
      return handleStrategy(a, b);
    case "set": {
      if (!(a in strat.DEFAULTS) || a === "mode") throw new Error(`Unknown setting. Options: ${Object.keys(strat.DEFAULTS).filter((k) => k !== "mode").join(", ")}`);
      applyConfig({ [a]: b });
      if (config.buySol > MAX_BUY) {
        applyConfig({ buySol: DEFAULT_BUY });
        throw new Error(`buySol cannot exceed ${MAX_BUY} SOL per order. Reset to ${DEFAULT_BUY}.`);
      }
      return console.log(`${a} = ${config[a]}`);
    }
    case "watch":
      return startWatch();
    case "unwatch":
      stopWatch();
      return console.log("Watch stopped.");
    case "mcap": {
      if (!engine) return console.log("No market cap yet. Use watch.");
      const lastRecord = engine.lastRecord || null;
      const tokenPriceSol = deriveTokenPriceSol(lastRecord);
      const tokenPriceUsdc = tokenPriceSol === null ? null : usdValue(tokenPriceSol);
      const priceText = tokenPriceUsdc === null ? "price=n/a" : `price=${compactNumber(tokenPriceUsdc, 2)} USDC`;
      return console.log(
        `mcap=${engine.lastPrice === null ? "n/a" : `${compactNumber(usdValue(engine.lastPrice), 2)} USDC`} ${priceText} buys=${engine.buys}/${config.maxBuys || "unlimited"} ticks=${engine.history.length}`
      );
    }
    case "price": {
      if (!engine || engine.lastPrice === null) return console.log("No market cap yet. Use watch.");
      const lastRecord = engine.lastRecord || null;
      const tokenPriceSol = deriveTokenPriceSol(lastRecord);
      const tokenPriceUsdc = tokenPriceSol === null ? null : usdValue(tokenPriceSol);
      const priceText = tokenPriceUsdc === null ? "price=n/a" : `price=${compactNumber(tokenPriceUsdc, 2)} USDC`;
      return console.log(
        `mcap=${compactNumber(usdValue(engine.lastPrice), 2)} USDC ${priceText} buys=${engine.buys}/${config.maxBuys || "unlimited"} ticks=${engine.history.length}`
      );
    }
    case "pnl": {
      if (!engine || engine.lastPrice === null) return console.log("No price yet. Use watch.");
      const p = engine.positionSummary;
      const priceUsdc = usdValue(p.markPrice || 0);
      const avgUsdc = usdValue(p.avgCostSol || 0);
      const pnlUsdc = usdValue(p.pnlSol || 0);
      return console.log(
        `qty=${p.qty.toFixed(4)} avg=${compactNumber(avgUsdc, 2)} USDC ` +
          `mcap=${compactNumber(priceUsdc, 2)} USDC pnl=${compactNumber(pnlUsdc, 2)} USDC`
      );
    }
    case "status":
      return console.log(
        `mode=${LIVE ? "LIVE" : "SIMULATION"} armed=${armed} spent=${spentSol.toFixed(4)}/${MAX_SESSION_SOL} SOL mint=${currentMint ?? "none"} watching=${feed ? config.mode : "no"}`
      );
    case "disarm":
      armed = false;
      if (feed) {
        stopWatch();
        console.log("Watch stopped.");
      }
      return console.log("Disarmed.");
    case "arm": {
      if (!LIVE) return console.log("Simulation mode: nothing to arm.");
      const answer = await new Promise((r) => rl.question("Type TRADE to arm live orders: ", r));
      armed = answer.trim() === "TRADE";
      return console.log(armed ? "ARMED. Orders now send immediately." : "Not armed.");
    }
    case "buy": {
      const t = resolveTarget(a, b);
      return execute("buy", t.mint, t.amount ?? DEFAULT_BUY);
    }
    case "sell": {
      const t = resolveTarget(a);
      return execute("sell", t.mint, "100%");
    }
    default:
      if (looksLikeMint(line) && !line.includes(" ")) {
        return setMint(line);
      }
      console.log("Unknown command. Type help.");
  }
}

async function interactive() {
  console.log(`Moto Bug Bot - ${LIVE ? "LIVE" : "SIMULATION"} mode`);
  if (LIVE && !API_KEY) {
    throw new Error("LIVE_TRADING=1 but PUMPPORTAL_API_KEY is not set.");
  }

  if (LIVE) {
    const ms = await warmUp();
    console.log(ms === null ? "Warm-up failed (will retry)." : `Connection warmed in ${ms.toFixed(0)} ms.`);
    setInterval(() => warmUp(), KEEPALIVE_MS).unref();
  }
  printHelp();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.prompt();

  // Serialize commands so orders never interleave.
  let queue = Promise.resolve();
  let closed = false;
  rl.on("line", (line) => {
    queue = queue
      .then(() => handle(line.trim(), rl))
      .catch((e) => console.error(e.message))
      .then(() => {
        if (!closed) rl.prompt();
      });
  });
  rl.on("close", () => {
    closed = true;
    queue.then(() => {
      agent.destroy();
      process.exit(0);
    });
  });
}

// One-shot mode keeps the old behaviour, including the TRADE prompt.
async function oneShot([action, mint, amount]) {
  const payload = buildPayload(action, mint, amount);
  if (!LIVE) {
    console.log("SIMULATION: no trade sent");
    console.log(payload);
    return;
  }
  if (!API_KEY) throw new Error("Missing API key");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question("Type TRADE to execute: ", r));
  rl.close();
  if (answer.trim() !== "TRADE") return;

  const { parsed, ms } = await sendOrder(payload);
  console.log(parsed);
  console.log(`Order round-trip: ${ms.toFixed(0)} ms`);
  agent.destroy();
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) return interactive();
  if (args.length === 3) return oneShot(args);
  throw new Error("Usage: node script.js            (interactive)\n       node script.js buy|sell MINT AMOUNT");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
