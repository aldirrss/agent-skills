---
name: crypto-futures
description: Senior-level guidance for building cryptocurrency perpetual/futures trading systems in Python. Use this whenever the user is writing code that touches crypto futures or perpetual contracts — order execution, position sizing, liquidation math, leverage handling, exchange API integration (Binance/Bybit/OKX via ccxt), strategy logic, backtesting, or real-time market data pipelines. Trigger this even when the user doesn't say "futures" explicitly but mentions perps, funding rate, liquidation price, TP/SL orders, leverage, position sizing, margin (isolated/cross), reduce-only orders, ccxt, fetch_ohlcv, place_order, or backtesting a crypto strategy. Money is at stake in this domain — a float-precision bug or a missing stop loss is a financial loss, not a cosmetic one — so apply the safety rules here rigorously rather than producing naive example code.
---

# Crypto Futures Trading Development

Building futures/perpetual trading systems is unlike normal CRUD work: a subtle bug doesn't throw an error, it silently loses money. A `float` rounding error places the wrong quantity. A missing reduce-only flag flips a close into an accidental reverse. A stop loss set *after* entry leaves a window of unprotected exposure. Treat every order-path change as if real capital flows through it, because in production it does.

## Non-negotiable safety rules

These apply to ALL generated code in this domain. Do not relax them for "just an example."

1. **Never use `float` for price, quantity, or PnL.** Use `decimal.Decimal`. Floats accumulate error and exchanges reject malformed quantities. Convert to float only at the API boundary if the library demands it, and round to the instrument's precision first.
2. **A stop loss must exist before or atomically with entry exposure.** Never open a position and "add the stop later" in a separate, unguarded step. If the exchange supports bracket/OCO/TP-SL on entry, use it; otherwise place the SL immediately and verify it landed.
3. **Leverage is capped in code, not just config.** A config typo should not be able to set 125x. Enforce a hard ceiling constant in the code path that sends the order.
4. **Closing orders are `reduce_only=True`.** This prevents a close from accidentally opening a new position in the opposite direction (a classic and expensive bug).
5. **Every order response is verified, never assumed.** Check the returned status/filled qty. Network success ≠ order filled. Reconcile against `fetch_order` / `fetch_position` before acting on the assumption that state changed.
6. **Position sizing respects a max-risk-per-trade.** Size from the stop distance and account equity, not from a fixed notional. Default 1–2% risk per trade unless the user overrides.
7. **Default to testnet/sandbox.** Live trading is opt-in and explicit. Generated code should make it obvious and hard to flip to live by accident.

If a user request conflicts with one of these (e.g. "just open a market position, skip the stop"), implement what they ask but flag the risk in a comment and in your reply — don't silently produce unsafe code.

## How to use this skill

Read the relevant reference file(s) before writing code for that area. Each is dense with concrete, copy-ready patterns:

| When the task involves… | Read |
|---|---|
| Connecting to an exchange, rate limits, ws vs rest, credentials | `references/exchange-integration.md` |
| Placing/cancelling orders, TP/SL, order state, slippage | `references/order-execution.md` |
| Position sizing, liquidation price, leverage guards, circuit breakers | `references/risk-management.md` |
| Fetching OHLCV/funding, indicators, real-time candles | `references/data-pipeline.md` |
| Validating a strategy before going live | `references/backtesting-patterns.md` |

For anything that places or modifies a live order, read both `order-execution.md` AND `risk-management.md` — they are two halves of the same safety story.

## Recommended dependencies

- **`ccxt`** (or `ccxt.pro` for unified websockets) — exchange abstraction. Prefer it over hand-rolling REST clients unless you have a specific reason.
- **`pandas`** + **`pandas-ta`** (or `ta-lib` if available) — indicators and data wrangling.
- **`vectorbt`** or **`backtesting.py`** — backtesting. `vectorbt` for vectorized parameter sweeps, `backtesting.py` for readable event-driven logic.
- **`pydantic`** — validate config (leverage caps, risk limits) at load time so bad values fail fast.

## Architecture orientation

A robust system separates concerns so the risky parts are small and auditable:

```
data layer      → fetch/normalize OHLCV, funding, ticks (read-only, safe)
strategy layer  → pure functions: data in → signal out (no side effects, easy to test)
risk layer      → sizing, leverage guard, circuit breaker (gate before any order)
execution layer → the ONLY place that sends orders; smallest, most-tested code
```

Keep the strategy layer side-effect-free. A signal generator that also places orders is impossible to backtest honestly and dangerous to change. The execution layer should be the only code that can move money, and every safety rule above lives there.

## Quick self-check before finishing any order-path code

- [ ] No `float` anywhere in price/qty/PnL math — `Decimal` throughout
- [ ] Quantity & price rounded to the instrument's precision before sending
- [ ] Stop loss guaranteed present alongside entry exposure
- [ ] Leverage hard-capped by a code constant
- [ ] Closing orders use `reduce_only=True`
- [ ] Order response status checked, not assumed
- [ ] Sandbox/testnet is the default; live is explicit opt-in
- [ ] Network/rate-limit errors handled with backoff, not bare try/except pass
