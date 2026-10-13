# Bat Brain

<p align="center">
  <img src="./Cute%20Blue%20Mechanical%20Bat%20Drone.png" alt="Cute blue mechanical bat drone" width="240">
</p>

A small Node.js command-line tool that sends buy/sell orders to the PumpPortal trade API.

By default it runs in **simulation mode**: it validates your input and prints the order, but sends nothing.

## Requirements

- [Node.js](https://nodejs.org/) 18 or newer (uses built-in `fetch`)
- A PumpPortal API key (only needed for live trading)

## Quick start (Windows)

Double-click [start.bat](./start.bat). It asks whether to trade live, then opens the fast interactive mode.

**First-time setup:** copy [keys.example.bat](./keys.example.bat) to `keys.local.bat` and put your PumpPortal API key in it. `start.bat` loads that file. `keys.local.bat` is listed in `.gitignore`, so your key stays out of the repo; only the placeholder template is committed.

## Fast interactive mode

Run `node script.js` with no arguments. The bot stays open with a persistent, pre-warmed HTTPS connection (kept alive every 20 s), so orders skip the TLS handshake. Each live order prints its round-trip time.

| Command | Action |
|---------|--------|
| `<MINT>` (just paste it) | Set it as the session's current mint (no order sent) |
| `buy [SOL]` | Buy the current mint (default `DEFAULT_BUY_SOL`, 0.005; max 0.01 SOL per order) |
| `sell` | Sell 100% of the current mint |
| `buy <MINT> [SOL]` / `sell <MINT>` | Same, and also sets the current mint |
| `mint` | Show the current mint |
| `strategy` / `strategy modes` | Show strategy settings / list buying modes |
| `strategy mode <name>` | Choose the buying mode |
| `set <key> <value>` | Change a strategy setting (saved to `strategy.json`) |
| `watch` / `unwatch` | Start / stop watching the current mint's price and buying per the strategy |
| `price` | Show the latest price and buy count |
| `arm` | Enable live orders for the session (type `TRADE` once) |
| `disarm` | Disable live orders (also stops a running watch) |
| `status` | Show mode, armed state, SOL spent, watch state |
| `quit` | Exit |

In live mode nothing is sent until you run `arm`. After that, orders fire instantly with no per-order prompt. A session spend cap (`MAX_SESSION_SOL`, default 0.05 SOL) limits total buys; restart to reset it.

## Strategy (automatic buying)

`watch` streams the current mint's trades from PumpPortal and uses its market cap in SOL as the price. The strategy decides when to buy; the per-order and session caps still apply. In simulation mode it only prints the orders it would send. In live mode you must `arm` before `watch`.

The price feed needs the API key's wallet funded with at least 0.02 SOL.

Buying modes (built for a token already in an uptrend):

| Mode | Buys when |
|------|-----------|
| `dip` | Price falls `dropPct`% below its high of the last `windowSec` seconds |
| `breakout` | Price rises `abovePct`% above its high of the last `windowSec` seconds |
| `momentum` | Price is up `risePct`% versus `windowSec` seconds ago |
| `ladder` | Immediately, then each time price falls `stepPct`% below the last buy |
| `dca` | Every `intervalSec` seconds, regardless of price |

Settings (defaults): `buySol` 0.005, `maxBuys` 3, `cooldownSec` 10, `windowSec` 60, `minTicks` 5 (trades needed before price modes act), `dropPct` 5, `abovePct` 1, `risePct` 3, `stepPct` 5, `intervalSec` 30. `buySol` cannot exceed 0.01. Watching stops after `maxBuys` buys, after 3 failed orders in a row, or if you change the current mint.

Example:

```
> 11111111111111111111111111111111
> strategy mode dip
> set dropPct 8
> arm
> watch
```

The strategy only buys. Sell manually with `sell`.

Latency tips: run it on a fast, wired connection or a VPS near PumpPortal, and keep the window open so the connection stays warm. A higher `priorityFee` in [script.js](./script.js) helps land transactions faster but costs more.

## Command line usage (one-shot)

```
node script.js <buy|sell> <MINT> <AMOUNT>
```

| Argument | Description |
|----------|-------------|
| `buy` / `sell` | Order type |
| `MINT` | Token mint address (32-44 characters) |
| `AMOUNT` | Buy: SOL amount, greater than 0 and at most `0.01`. Sell: must be exactly `100%` |

Examples (PowerShell):

```powershell
node script.js buy <MINT> 0.005
node script.js sell <MINT> 100%
```

## Live trading

Live trading is off unless you set `LIVE_TRADING=1`. You also need your API key in `PUMPPORTAL_API_KEY`.

PowerShell:

```powershell
$env:LIVE_TRADING = "1"
$env:PUMPPORTAL_API_KEY = "your-api-key"
node script.js buy <MINT> 0.005
```

Command Prompt:

```bat
set LIVE_TRADING=1
set PUMPPORTAL_API_KEY=your-api-key
node script.js buy <MINT> 0.005
```

In one-shot mode the script asks you to type `TRADE` before sending the order. Anything else cancels it. In interactive mode you type `TRADE` once via `arm`.

Back to simulation: `$env:LIVE_TRADING = "0"` (or close the terminal; variables set this way only last for that session).

## Built-in safety limits

- Buys are capped at 0.01 SOL per order.
- Sells are always 100% of the position.
- Slippage 5%, priority fee 0.00005 SOL, pool `auto`.
- Live orders need typed confirmation.

To change these, edit [script.js](./script.js).

## Keep your keys safe

Never put your API key or wallet private key in the script, in this README, or in any file you share. Use environment variables, and revoke any key that has been exposed.
