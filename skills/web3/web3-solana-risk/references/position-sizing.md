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

### Take Profit — 2× Modal Rule

TP is fixed at **2× the position size** (100% gain). If you put in 50 USDC, the position closes when value reaches 100 USDC.

```
take_profit_pct = 1.0  (100% gain = price doubles = 2× modal)
```

This is a code constant, not a config value. Meme token trading requires asymmetric R/R — a 2× TP combined with a tiered SL keeps the expected value positive even with a 40–50% win rate.

### Stop Loss — Liquidity Tier Rule

SL percentage is derived from the token's liquidity depth. Thinner liquidity requires a wider SL for two reasons:
1. Exit slippage is larger — the real exit price is worse than the stop price
2. Thin pools are more volatile — premature stops fire more often on noise

```python
# Stop loss percentage per liquidity tier
SL_TIERS: list[tuple[int, Decimal]] = [
    (500_000, Decimal("0.15")),   # Deep pool   — tight SL achievable
    ( 50_000, Decimal("0.20")),   # Healthy     — moderate buffer
    ( 10_000, Decimal("0.30")),   # Thin        — wide buffer for noise
    (      0, Decimal("0.40")),   # Very thin   — extreme volatility
]
```

| Liquidity (USDC) | SL % | Rationale |
|---|---|---|
| >= 500,000 | 15% | Deep pool — exit slippage < 1%, tight SL safe |
| >= 50,000 | 20% | Healthy — moderate slippage on exit |
| >= 10,000 | 30% | Thin — high exit slippage + noisy price action |
| < 10,000 | 40% | Very thin — position likely illiquid, wide buffer |

### Implementation

```python
# utils/position_sizing.py  (continued)

# ── TP/SL constants ───────────────────────────────────────────────────────────

TAKE_PROFIT_PCT = Decimal("1.0")   # 2× modal — price must double to hit TP

SL_TIERS: list[tuple[int, Decimal]] = [
    (500_000, Decimal("0.15")),
    ( 50_000, Decimal("0.20")),
    ( 10_000, Decimal("0.30")),
    (      0, Decimal("0.40")),
]


def get_stop_loss_pct(liquidity_usdc: float) -> Decimal:
    """
    Derive stop loss percentage from liquidity depth.
    Returns the first tier whose threshold is <= liquidity_usdc.
    """
    for threshold, pct in SL_TIERS:
        if liquidity_usdc >= threshold:
            return pct
    return Decimal("0.40")   # fallback — never reached due to threshold=0 sentinel


def calculate_stop_loss_price(entry_price: Decimal, liquidity_usdc: float) -> Decimal:
    """
    Price at which the position should be force-closed to limit downside.
    Stop loss % is derived from liquidity tier, not a fixed config value.

    Args:
        entry_price:     Signal price_usdc at approval time
        liquidity_usdc:  Token liquidity from stream.agent.approved / state.price.{mint}

    Examples:
        entry=0.00001233, liquidity=600_000  → sl_pct=0.15 → stop=0.00001048
        entry=0.00001233, liquidity= 30_000  → sl_pct=0.20 → stop=0.00000986
        entry=0.00001233, liquidity=  5_000  → sl_pct=0.40 → stop=0.00000740
    """
    sl_pct = get_stop_loss_pct(liquidity_usdc)
    return (entry_price * (1 - sl_pct)).quantize(
        Decimal("0.00000001"), rounding=ROUND_DOWN
    )


def calculate_take_profit_price(entry_price: Decimal) -> Decimal:
    """
    Price at which the position should be closed for profit.
    Fixed at 2× modal (TAKE_PROFIT_PCT = 1.0 = 100% gain).

    Args:
        entry_price:  Signal price_usdc at approval time

    Example: entry=0.00001233 → target=0.00002466
    """
    return (entry_price * (1 + TAKE_PROFIT_PCT)).quantize(Decimal("0.00000001"))
```

### R/R Summary by Liquidity Tier

| Liquidity | SL % | TP % | R/R Ratio | Min win rate to break even |
|---|---|---|---|---|
| >= 500,000 | 15% | 100% | 6.7 : 1 | ~13% |
| >= 50,000 | 20% | 100% | 5.0 : 1 | ~17% |
| >= 10,000 | 30% | 100% | 3.3 : 1 | ~23% |
| < 10,000 | 40% | 100% | 2.5 : 1 | ~29% |

Even at the worst tier (40% SL / 100% TP), a 30% win rate produces positive expected value.

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
  "max_concurrent_positions": 5,
  "max_daily_loss_usdc":      200,
  "max_hold_time_seconds":    3600,
  "min_liquidity_usdc":       30000,
  "min_viable_position_usdc": 5
}
```

**Removed from config (now code constants):**
- `stop_loss_pct` — replaced by `SL_TIERS` (liquidity-tiered, not configurable at runtime)
- `take_profit_pct` — replaced by `TAKE_PROFIT_PCT = 1.0` (2× modal, not configurable at runtime)

`MAX_POSITION_USDC = 500`, `TAKE_PROFIT_PCT = 1.0`, and `SL_TIERS` are code constants that cannot be overridden by config. This prevents accidental misconfiguration of the core R/R rules.

Validated by pydantic at startup. The bot will not start with an invalid risk config.

## Updating config.risk at Runtime

RiskManager reads `config.risk` on every signal — hot reload is free.

```bash
# Update base position size to 75 USDC without restarting the bot
redis-cli SET config.risk '{"base_position_usdc": 75, "max_wallet_pct": 0.10, "max_concurrent_positions": 5, "max_daily_loss_usdc": 200, "max_hold_time_seconds": 3600, "min_liquidity_usdc": 30000, "min_viable_position_usdc": 5}'
```

Changes take effect on the next signal processed — no restart required.
