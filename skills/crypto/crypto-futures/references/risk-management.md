# Risk Management

The safety net that lives in code, not in good intentions. Position sizing, liquidation math, leverage guards, and circuit breakers. Read alongside `order-execution.md`.

## Table of contents
- Position sizing from stop distance
- Leverage guard (hard cap in code)
- Liquidation price (isolated vs cross)
- Circuit breaker / max drawdown
- Funding-rate awareness

## Position sizing from stop distance

Size from risk, not from a fixed notional. The amount you can lose is `equity * risk_pct`; the per-unit loss is the distance to your stop. Quantity follows.

```python
from decimal import Decimal

def position_size(equity: Decimal, risk_pct: Decimal,
                  entry: Decimal, stop: Decimal) -> Decimal:
    """Fixed-fractional sizing. risk_pct e.g. Decimal('0.01') for 1%."""
    if risk_pct <= 0 or risk_pct > Decimal("0.05"):
        raise ValueError("risk_pct must be in (0, 0.05] — refuse reckless sizing")
    risk_amount = equity * risk_pct
    stop_distance = abs(entry - stop)
    if stop_distance == 0:
        raise ValueError("stop equals entry — no risk distance defined")
    return risk_amount / stop_distance      # quantity in base units
```

Default risk per trade is 1–2%. The `> 0.05` guard refuses absurd inputs — a sizing function should never be the thing that blows up an account because of a config typo. Round the result to the instrument's amount precision before ordering.

Kelly criterion exists (`f = W - (1-W)/R` for win rate W and win/loss ratio R) but full-Kelly is too aggressive for real trading. If a user wants it, use fractional Kelly (¼ to ½) and still cap by the fixed-fractional limit above.

## Leverage guard (hard cap in code)

Leverage must be bounded by a constant in the code path, independent of config. Config can be wrong; the code path is the last line of defense.

```python
MAX_LEVERAGE = 10        # hard ceiling — do not make this config-only

def set_leverage(ex, symbol, requested: int):
    lev = max(1, min(int(requested), MAX_LEVERAGE))
    if lev != requested:
        # surface the clamp — silent clamping hides bugs
        print(f"[risk] leverage {requested}x clamped to {lev}x")
    ex.set_leverage(lev, symbol)
    return lev
```

## Liquidation price (isolated vs cross)

Know your liquidation level *before* entering. The simplified isolated-margin approximation (ignoring fees and maintenance-margin tiers):

```python
def liq_price_isolated(entry: Decimal, leverage: Decimal,
                       side: str, mmr: Decimal = Decimal("0.005")) -> Decimal:
    """Approximate. mmr = maintenance margin rate (tier-dependent, ~0.4–0.5%)."""
    if side == "long":
        return entry * (1 - 1/leverage + mmr)
    else:  # short
        return entry * (1 + 1/leverage - mmr)
```

This is an approximation — real liquidation depends on the exchange's tiered maintenance margin, accumulated funding, and unrealized PnL on other positions (under cross margin). For anything beyond a sanity check, read the actual liquidation price from `fetch_positions()` (`liquidationPrice` field) rather than trusting a formula. Under **cross margin**, one position's liquidation can be affected by your whole account — never compute it in isolation.

A practical rule: your stop loss should trigger comfortably before the liquidation price. If your stop is past liquidation, your leverage is too high for that stop distance — reduce leverage or widen nothing, lower size.

## Circuit breaker / max drawdown

A bot that keeps trading through a losing streak can ruin an account fast. Enforce a daily/peak drawdown halt.

```python
class CircuitBreaker:
    def __init__(self, max_daily_loss: Decimal, max_drawdown_pct: Decimal):
        self.max_daily_loss = max_daily_loss
        self.max_drawdown_pct = max_drawdown_pct
        self.day_start_equity: Decimal | None = None
        self.peak_equity: Decimal | None = None
        self.halted = False

    def check(self, equity: Decimal) -> bool:
        """Call before every new entry. Returns True if trading is allowed."""
        if self.day_start_equity is None:
            self.day_start_equity = self.peak_equity = equity
        self.peak_equity = max(self.peak_equity, equity)

        daily_loss = self.day_start_equity - equity
        drawdown = (self.peak_equity - equity) / self.peak_equity

        if daily_loss >= self.max_daily_loss or drawdown >= self.max_drawdown_pct:
            self.halted = True
        return not self.halted
```

Gate every new entry behind `check()`. A breaker should stop *opening* new risk but still allow *closing* existing positions (you always want to be able to exit).

## Funding-rate awareness

Perpetuals charge/pay funding periodically (typically every 8h). Holding through funding when the rate is heavily against you erodes PnL silently.

```python
def funding_is_adverse(ex, symbol, side: str, threshold=Decimal("0.0005")) -> bool:
    fr = Decimal(str(ex.fetch_funding_rate(symbol)["fundingRate"]))
    # longs pay when funding positive; shorts pay when negative
    paying = fr if side == "long" else -fr
    return paying > threshold
```

Before opening or holding through a funding timestamp, check the rate. For short-horizon scalps it rarely matters; for swing holds it compounds. Factor realized funding into PnL accounting, not just entry/exit price.
