# Position Sizing

How RiskManager calculates the USDC amount for each trade, applies per-strategy multipliers, derives stop loss and take profit prices, and seeds position state for Execution to pass through to PositionTracker.

## Core Formula

```
size = base_position_usdc × confidence × strategy_multiplier
size = min(size, wallet_usdc × max_wallet_pct, MAX_POSITION_USDC)
```

Three caps applied in order:
1. **Confidence scaling** — high confidence signals get a larger slice of the base size
2. **Wallet percentage cap** — never risk more than `max_wallet_pct` of total wallet in one trade
3. **Hard code ceiling** — `MAX_POSITION_USDC` is a code constant, not a config value

## Full Implementation

```python
# utils/position_sizing.py
from decimal import Decimal, ROUND_DOWN

from loguru import logger

# ── Code constants ────────────────────────────────────────────────────────────
MAX_POSITION_USDC = Decimal("500")   # absolute ceiling — config cannot raise this

# Per-strategy multipliers applied on top of confidence-scaled base size
STRATEGY_MULTIPLIERS: dict[str, Decimal] = {
    # Reliable strategies get full size
    "kol_copy_trade":          Decimal("1.0"),
    "graduation_trade":        Decimal("1.0"),
    "smart_money_confluence":  Decimal("1.0"),
    # Riskier strategies receive a smaller fraction
    "momentum_spike":          Decimal("0.8"),
    "new_launch_snipe":        Decimal("0.5"),
    "social_alpha":            Decimal("0.5"),
}


def calculate_position_size(
    wallet_usdc: Decimal,
    confidence: Decimal,
    strategy: str,
    cfg: dict,
) -> Decimal:
    """
    Calculate approved position size in USDC.

    Args:
        wallet_usdc:  Current wallet USDC balance from state.wallet.usdc_balance
        confidence:   Signal confidence score from Strategy (0.0 – 1.0)
        strategy:     Strategy name (must match STRATEGY_MULTIPLIERS keys)
        cfg:          Parsed config.risk dict from Redis

    Returns:
        Approved position size rounded to 2 decimal places.
        Returns Decimal("0.00") if no viable size can be computed.

    config.risk parameters used:
        base_position_usdc      (default: 50)    — base trade size before scaling
        max_wallet_pct          (default: 0.10)  — max fraction of wallet per trade

    MAX_POSITION_USDC (500 USDC) is a hard ceiling enforced in code, not config.
    """
    log = logger.bind(component="risk_manager")

    base       = Decimal(str(cfg.get("base_position_usdc", 50)))
    max_pct    = Decimal(str(cfg.get("max_wallet_pct", 0.10)))
    multiplier = STRATEGY_MULTIPLIERS.get(strategy, Decimal("1.0"))

    # Step 1: scale base by confidence and strategy multiplier
    sized = base * confidence * multiplier

    # Step 2: apply wallet percentage cap
    wallet_cap = wallet_usdc * max_pct

    # Step 3: apply hard code ceiling
    result = min(sized, wallet_cap, MAX_POSITION_USDC)

    if result < sized:
        log.debug(
            f"Position size capped: "
            f"raw={sized:.4f} → approved={result:.2f} USDC "
            f"[wallet_cap={wallet_cap:.2f}, MAX={MAX_POSITION_USDC}] "
            f"strategy={strategy} confidence={confidence}"
        )

    return result.quantize(Decimal("0.01"))
```

## Per-Strategy Multiplier Rationale

| Strategy | Multiplier | Why |
|---|---|---|
| `kol_copy_trade` | 1.0 | Real capital at risk from a tracked wallet — strongest signal. Full size appropriate. |
| `graduation_trade` | 1.0 | Pump.fun graduation means sustained demand and successful price discovery. Lower velocity risk. |
| `smart_money_confluence` | 1.0 | Two or more independent smart-money wallets agreeing is the highest-confidence signal available. |
| `momentum_spike` | 0.8 | Volume spikes can be wash-traded or coordinated pump setups. 20% reduction hedges against false breakouts. |
| `new_launch_snipe` | 0.5 | Token is minutes old — no track record, no holder history, extreme rug risk. Half-size keeps exposure survivable. |
| `social_alpha` | 0.5 | Telegram/Twitter signals have the highest noise-to-signal ratio. Half-size and require a higher confidence threshold (75). |

## Confidence Scaling Examples

With `base_position_usdc = 50`, `wallet_usdc = 1000`, `max_wallet_pct = 0.10`:

| Strategy | Confidence | Raw Size | Multiplied | Wallet Cap | Final |
|---|---|---|---|---|---|
| `kol_copy_trade` | 0.90 | 45.00 | 45.00 | 100.00 | **45.00** |
| `kol_copy_trade` | 0.50 | 25.00 | 25.00 | 100.00 | **25.00** |
| `momentum_spike` | 0.85 | 42.50 | 34.00 | 100.00 | **34.00** |
| `new_launch_snipe` | 0.80 | 40.00 | 20.00 | 100.00 | **20.00** |
| `social_alpha` | 0.90 | 45.00 | 22.50 | 100.00 | **22.50** |

With `wallet_usdc = 200` (small wallet, wallet cap kicks in):

| Strategy | Confidence | Raw Size | Multiplied | Wallet Cap (10%) | Final |
|---|---|---|---|---|---|
| `kol_copy_trade` | 0.90 | 45.00 | 45.00 | **20.00** | **20.00** |
| `kol_copy_trade` | 0.50 | 25.00 | 25.00 | **20.00** | **20.00** |

With `wallet_usdc = 10000` (large wallet, MAX_POSITION_USDC kicks in):

| Strategy | Confidence | Raw Size | Multiplied | Wallet Cap (10%) | MAX | Final |
|---|---|---|---|---|---|---|
| `kol_copy_trade` | 0.90 | 45.00 | 45.00 | 1000.00 | **500.00** | **45.00** |
| `kol_copy_trade` | 0.90 | 500.00 | 500.00 | 1000.00 | **500.00** | **500.00** |

## Stop Loss and Take Profit Calculation

Stop loss and take profit prices are computed at **signal approval time** in RiskManager, not at fill time. This ensures the prices are based on the signal's observed price, not the (potentially worse) fill price.

```python
# utils/position_sizing.py  (continued)

def calculate_stop_loss_price(entry_price: Decimal, stop_loss_pct: Decimal) -> Decimal:
    """
    Price at which the position should be force-closed to limit downside.

    Args:
        entry_price:    Signal price_usdc at approval time
        stop_loss_pct:  From config.risk.stop_loss_pct (default: 0.15 = 15%)

    Example: entry=0.00001233, sl_pct=0.15 → stop=0.00001048
    """
    return (entry_price * (1 - stop_loss_pct)).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )


def calculate_take_profit_price(entry_price: Decimal, take_profit_pct: Decimal) -> Decimal:
    """
    Price at which the position should be closed for profit.

    Args:
        entry_price:      Signal price_usdc at approval time
        take_profit_pct:  From config.risk.take_profit_pct (default: 0.50 = 50%)

    Example: entry=0.00001233, tp_pct=0.50 → target=0.00001850
    """
    return (entry_price * (1 + take_profit_pct)).quantize(Decimal("0.00000001"))
```

## Position State Seeding

RiskManager embeds stop loss and take profit into the `stream.swaps` message. Execution passes these fields through to `stream.fills`. PositionTracker reads them from the fill and seeds `state.position.{mint}` directly — no recalculation needed downstream.

**Flow:**

```
RiskManager calculates SL + TP at approval time
  └── embeds in stream.swaps: { stop_loss_price, take_profit_price, entry_price }

Execution
  └── copies SL/TP from swap data into stream.fills (pass-through, no modification)

PositionTracker reads stream.fills
  └── writes state.position.{mint}:
      {
        "mint":             "...",
        "symbol":           "BONK",
        "entry_price":      "0.00001233",
        "stop_loss_price":  "0.00001048",
        "take_profit_price": "0.00001850",
        "amount_tokens":    "4056000",
        "amount_usdc":      "50.00",
        "strategy":         "kol_copy_trade",
        "entry_ts":         1718000001200
      }

Strategy's position monitor loop
  └── reads state.position.{mint}
  └── compares current price against stop_loss_price / take_profit_price
  └── publishes SELL signal to stream.signals when threshold crossed
```

**Why seed at RiskManager instead of Execution?**

Execution is intentionally kept as a thin signing layer — it should not contain business logic. By the time a signal reaches Execution, the trade has already been approved and sized. Embedding SL/TP at approval time also means they reflect the pre-trade market view (the signal price), not the actual fill price which may have slipped.

## config.risk Reference

Full schema for `config.risk` Redis key (stored as JSON string):

```json
{
  "base_position_usdc":       50,
  "max_wallet_pct":           0.10,
  "stop_loss_pct":            0.15,
  "take_profit_pct":          0.50,
  "trailing_stop":            false,
  "max_concurrent_positions": 5,
  "max_daily_loss_usdc":      200,
  "max_hold_time_seconds":    3600,
  "min_liquidity_usdc":       30000,
  "min_viable_position_usdc": 5
}
```

Validated by pydantic at startup. The bot will not start with an invalid risk config. `max_concurrent_positions` and `max_daily_loss_usdc` are read from config — but `MAX_POSITION_USDC = 500` in code cannot be raised by config, only lowered implicitly by a small wallet balance.

## Updating config.risk at Runtime

RiskManager reads `config.risk` on every signal — hot reload is free.

```bash
# Update base position size to 75 USDC without restarting the bot
redis-cli SET config.risk '{"base_position_usdc": 75, "max_wallet_pct": 0.10, "stop_loss_pct": 0.15, "take_profit_pct": 0.50, "trailing_stop": false, "max_concurrent_positions": 5, "max_daily_loss_usdc": 200, "max_hold_time_seconds": 3600, "min_liquidity_usdc": 30000, "min_viable_position_usdc": 5}'
```

Changes take effect on the next signal processed — no restart required.
