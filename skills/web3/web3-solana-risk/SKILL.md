---
name: web3-solana-risk
description: RiskManager component for Solana DEX trading bot — position sizing, safety gate, circuit breaker, and swap request validation. Use this whenever the user is building or debugging the RiskManager layer, including: position size calculation, max concurrent positions, daily loss circuit breaker, per-strategy size multipliers, slippage derivation from liquidity tier, or the full signal-to-swap pipeline. Trigger even when the user mentions one specific area (e.g. "how to size position by confidence", "why is bot rejecting signals", "how to set stop loss at entry", "circuit breaker not triggering"). Reads from stream.signals, writes to stream.swaps.
requires:
  - web3-solana
  - web3-solana-architecture
---

# web3-solana-risk

RiskManager is the **safety gate** between Strategy and Execution. It consumes buy/sell decisions from `stream.signals`, validates every decision against a layered set of safety rules, sizes positions, derives slippage, and publishes approved swap requests to `stream.swaps`.

RiskManager never touches the wallet, never calls Jupiter, never writes to PostgreSQL. Its only inputs are `stream.signals` and Redis state. Its only output is `stream.swaps`.

## Role in the Pipeline

```
Strategy
  └── XADD stream.signals  →  { action=BUY|SELL, mint, confidence, liquidity_usdc, ... }

RiskManager  ← this skill
  ├── XREADGROUP stream.signals  (consumer group: risk-group / risk-manager-1)
  ├── Safety gate (all checks in sequence — first failure rejects the signal)
  ├── Position sizing  (confidence × strategy_multiplier, capped at MAX_POSITION_USDC)
  ├── Slippage derivation  (liquidity tier → bps)
  └── XADD stream.swaps  →  { side, amount_usdc|amount_tokens, slippage_bps, stop_loss_price, ... }
      XACK stream.signals

Execution
  └── XREADGROUP stream.swaps  →  signs + sends Jupiter swap
```

## Hard-Coded Constants

These are **code constants**, not config values. Config cannot override them.

```python
MAX_POSITION_USDC        = Decimal("500")   # absolute ceiling per trade
MAX_CONCURRENT_POSITIONS = 5                # max open positions at any time
MIN_SOL_RESERVE          = Decimal("0.05")  # SOL kept for transaction fees
```

`MAX_POSITION_USDC` and `MAX_CONCURRENT_POSITIONS` are the two invariants RiskManager enforces regardless of what `config.risk` says.

## Per-Strategy Size Multipliers

Each strategy carries a risk multiplier applied on top of the base position size. Riskier strategies receive a smaller fraction of the calculated size.

| Strategy | Multiplier | Rationale |
|---|---|---|
| `kol_copy_trade` | 1.0 | Highest signal quality — real money on the line |
| `graduation_trade` | 1.0 | Proven demand milestone, lower velocity risk |
| `smart_money_confluence` | 1.0 | 2+ independent smart money signals |
| `momentum_spike` | 0.8 | Volume/price spike can be manipulated |
| `new_launch_snipe` | 0.5 | Extreme novelty risk — unproven token |
| `social_alpha` | 0.5 | Highest noise-to-signal ratio of all sources |

## Slippage Tiers

Slippage is derived from `liquidity_usdc` in the signal. Deeper pools tolerate tighter slippage.

| Liquidity (USDC) | Slippage (bps) | Notes |
|---|---|---|
| >= 500,000 | 50 | Deep pool — tight slippage safe |
| >= 50,000 | 100 | Healthy pool — standard |
| >= 10,000 | 200 | Thin pool — wider required |
| < 10,000 | 500 | Very thin — high impact expected |
| Emergency SELL | 1000 | `stop_loss` or `emergency_stop` reason — fill at any cost |

## Safety Gate Sequence

All checks run in order. First failure rejects the signal and ACKs the message.

```
1. Position exists?         → reject BUY if state.position.{mint} exists
2. Max concurrent?          → reject if len(state.position.*) >= MAX_CONCURRENT_POSITIONS
3. Circuit breaker?         → reject if stats.daily_pnl <= -config.risk.max_daily_loss_usdc
4. Bot status?              → reject if state.bot.status != "running"
5. USDC balance?            → reject if wallet_usdc < minimum viable size
6. SOL reserve?             → reject if SOL balance < MIN_SOL_RESERVE
7. Size calculation         → compute final amount_usdc; reject if <= 0
```

## stream.swaps Message (BUY)

```json
{
  "swap_id":          "swp_abc12345",
  "signal_id":        "sig_abc123",
  "mint":             "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol":           "BONK",
  "side":             "BUY",
  "amount_usdc":      "45.50",
  "slippage_bps":     "100",
  "strategy":         "kol_copy_trade",
  "stop_loss_price":  "0.00001048",
  "take_profit_price": "0.00001850",
  "entry_price":      "0.00001233",
  "ts":               "1718000000100"
}
```

Stop loss and take profit prices are calculated at approval time and embedded in the swap message so Execution passes them through to `stream.fills`, and PositionTracker seeds `state.position.{mint}` with them directly — no second calculation needed.

## stream.swaps Message (SELL)

```json
{
  "swap_id":       "swp_def67890",
  "signal_id":     "sig_def456",
  "mint":          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol":        "BONK",
  "side":          "SELL",
  "amount_tokens": "4056000",
  "slippage_bps":  "1000",
  "reason":        "stop_loss",
  "ts":            "1718000050000"
}
```

## Reference Files

| Building… | Read |
|---|---|
| Full RiskManager class with XREADGROUP loop, `_handle_buy`, `_handle_sell` | `references/risk-manager.md` |
| Circuit breaker, safety gate, SOL reserve check, manual reset | `references/circuit-breaker.md` |
| Position sizing formula, multipliers, stop loss/take profit calculation, state seeding | `references/position-sizing.md` |
