const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = path.join(__dirname, "strategy.json");

const DEFAULTS = {
  mode: "dip",
  buySol: 0.005,
  maxBuys: 3,
  cooldownSec: 10,
  windowSec: 60,
  minTicks: 5,
  dropPct: 5,
  abovePct: 1,
  risePct: 3,
  stepPct: 5,
  intervalSec: 30,
};

const MODES = {
  dip: "Buy when price falls dropPct% below its high of the last windowSec seconds.",
  breakout: "Buy when price rises abovePct% above its high of the last windowSec seconds.",
  momentum: "Buy when price is up risePct% versus windowSec seconds ago.",
  ladder: "Buy at the first price, then again each time price falls stepPct% below the last buy.",
  dca: "Buy buySol every intervalSec seconds regardless of price.",
};

function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") console.error(`strategy.json ignored: ${e.message}`);
  }
  return normalize({ ...DEFAULTS, ...saved });
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function normalize(cfg) {
  if (!MODES[cfg.mode]) throw new Error(`Unknown mode "${cfg.mode}". Modes: ${Object.keys(MODES).join(", ")}`);
  for (const [key, def] of Object.entries(DEFAULTS)) {
    if (typeof def === "number") {
      const v = Number(cfg[key]);
      if (!Number.isFinite(v) || v <= 0) throw new Error(`${key} must be a positive number`);
      cfg[key] = v;
    }
  }
  cfg.maxBuys = Math.floor(cfg.maxBuys);
  cfg.minTicks = Math.floor(cfg.minTicks);
  return cfg;
}

// Pure decision logic: feed it prices, it says when to buy. No network, no orders.
class Strategy {
  constructor(cfg) {
    this.cfg = cfg;
    this.reset();
  }

  reset() {
    this.history = [];
    this.buys = 0;
    this.lastBuyAt = null;
    this.lastBuyPrice = null;
    this.lastPrice = null;
    this.startedAt = null;
  }

  record(now, price) {
    if (this.startedAt === null) this.startedAt = now;
    this.lastPrice = price;
    this.history.push({ t: now, p: price });
    this.trim(now);
  }

  trim(now) {
    const cutoff = now - this.cfg.windowSec * 1000;
    while (this.history.length && this.history[0].t < cutoff) this.history.shift();
  }

  get done() {
    return this.buys >= this.cfg.maxBuys;
  }

  // Returns { reason } when a buy should fire now, otherwise null.
  check(now) {
    const c = this.cfg;
    const price = this.lastPrice;
    if (price === null || this.done) return null;
    if (this.lastBuyAt !== null && now - this.lastBuyAt < c.cooldownSec * 1000) return null;
    this.trim(now);

    const h = this.history;
    const ready = h.length >= c.minTicks;

    switch (c.mode) {
      case "dip": {
        if (!ready) return null;
        const high = Math.max(...h.map((x) => x.p));
        const drop = (1 - price / high) * 100;
        if (drop >= c.dropPct) return { reason: `dip ${drop.toFixed(1)}% below ${c.windowSec}s high` };
        return null;
      }
      case "breakout": {
        if (!ready) return null;
        const prior = Math.max(...h.slice(0, -1).map((x) => x.p));
        const gain = (price / prior - 1) * 100;
        if (gain >= c.abovePct) return { reason: `breakout ${gain.toFixed(1)}% above ${c.windowSec}s high` };
        return null;
      }
      case "momentum": {
        if (!ready) return null;
        const gain = (price / h[0].p - 1) * 100;
        if (gain >= c.risePct) return { reason: `momentum +${gain.toFixed(1)}% over ${c.windowSec}s` };
        return null;
      }
      case "ladder": {
        if (this.lastBuyPrice === null) return { reason: "ladder entry" };
        const drop = (1 - price / this.lastBuyPrice) * 100;
        if (drop >= c.stepPct) return { reason: `ladder step ${drop.toFixed(1)}% below last buy` };
        return null;
      }
      case "dca": {
        const ref = this.lastBuyAt ?? this.startedAt;
        if (now - ref >= c.intervalSec * 1000) return { reason: `dca every ${c.intervalSec}s` };
        return null;
      }
    }
    return null;
  }

  // Call after an order was actually attempted so the strategy re-arms.
  markBought(now) {
    this.buys += 1;
    this.lastBuyAt = now;
    this.lastBuyPrice = this.lastPrice;
    // Start a fresh window so one move cannot trigger back-to-back buys.
    this.history = this.lastPrice === null ? [] : [{ t: now, p: this.lastPrice }];
  }
}

// Streams token trades from PumpPortal and reports each price (marketCapSol).
class PriceFeed {
  constructor({ apiKey, mint, onPrice, onStatus }) {
    this.apiKey = apiKey;
    this.mint = mint;
    this.onPrice = onPrice;
    this.onStatus = onStatus;
    this.stopped = false;
    this.retry = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (this.ws) this.ws.close();
  }

  connect() {
    const url = `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(this.apiKey)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.retry = 0;
      ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [this.mint] }));
      this.onStatus("Price feed connected.");
    };
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.message) return this.onStatus(m.message);
      if (m.mint === this.mint && Number.isFinite(m.marketCapSol)) this.onPrice(m.marketCapSol, m);
    };
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** this.retry++, 15_000);
      this.onStatus(`Price feed disconnected. Reconnecting in ${delay / 1000}s...`);
      this.timer = setTimeout(() => this.connect(), delay);
    };
  }
}

module.exports = { Strategy, PriceFeed, MODES, DEFAULTS, loadConfig, saveConfig, normalize };
