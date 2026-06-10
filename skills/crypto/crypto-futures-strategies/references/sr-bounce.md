# Support / Resistance Bounce

Valid when: `RANGING` regime with identifiable horizontal levels.
Warning: Mean reversion at range extremes is included here — read the risk note.

## Core concept

In a ranging market, price oscillates between defined supply (resistance) and demand (support) zones. The edge is identifying which levels are *strong* (multiple touches, high volume, clear rejection history) vs *weak* (single touch, low volume). Fade price at strong levels; let it pass through weak ones.

## Level identification

Not all levels are equal. Score them before trusting them.

```python
import pandas as pd
import numpy as np
from decimal import Decimal

def find_swing_levels(df: pd.DataFrame, order=5) -> dict[str, list[Decimal]]:
    """
    Identify swing highs (resistance) and swing lows (support).
    order: how many bars each side must be lower/higher to qualify.
    """
    highs, lows = [], []
    for i in range(order, len(df) - order):
        if df["high"].iloc[i] == df["high"].iloc[i-order:i+order+1].max():
            highs.append(Decimal(str(df["high"].iloc[i])))
        if df["low"].iloc[i] == df["low"].iloc[i-order:i+order+1].min():
            lows.append(Decimal(str(df["low"].iloc[i])))
    return {"resistance": highs, "support": lows}

def level_strength(df: pd.DataFrame, level: Decimal,
                   tolerance_pct=0.002) -> dict:
    """Score a level by touches, volume at touches, and recency."""
    tol = level * Decimal(str(tolerance_pct))
    touches, volumes = [], []

    for i, row in df.iterrows():
        near_level = (abs(Decimal(str(row["high"])) - level) <= tol or
                      abs(Decimal(str(row["low"]))  - level) <= tol)
        if near_level:
            touches.append(i)
            volumes.append(row["volume"])

    return {
        "touch_count": len(touches),
        "avg_volume":  np.mean(volumes) if volumes else 0,
        "most_recent": max(touches) if touches else None,
        "strong":      len(touches) >= 3,   # 3+ touches = reliable level
    }
```

**Strong level criteria:**
- 3+ distinct touches (not consecutive — each touch should have space between)
- High volume at rejection bars
- Holds on HTF (visible on 4h or daily)
- Clean price action around it (not messy/overlapping candles)

## Entry rules

**Support bounce (long):**
- Regime = RANGING ✓
- Price reaches identified support zone ✓
- Level strength: 3+ touches, high volume ✓
- Rejection candle forms at level (pin bar, bullish engulfing, hammer) ✓
- RSI oversold (< 35) at touch — adds conviction ✓
- HTF is not in downtrend (would invalidate range support) ✓

**Resistance fade (short):** mirror of above, RSI overbought (> 65).

```python
def rejection_candle(df: pd.DataFrame, side: str, min_wick_ratio=2.0) -> bool:
    """
    Checks if last candle shows rejection (long wick, small body).
    side: 'support' (bullish pin) or 'resistance' (bearish pin).
    """
    row   = df.iloc[-1]
    body  = abs(row["close"] - row["open"])
    if body == 0:
        return False

    if side == "support":
        lower_wick = row["open"] - row["low"] if row["close"] >= row["open"] \
                     else row["close"] - row["low"]
        return lower_wick / body >= min_wick_ratio and row["close"] > row["open"]

    upper_wick = row["high"] - row["open"] if row["close"] <= row["open"] \
                 else row["high"] - row["close"]
    return upper_wick / body >= min_wick_ratio and row["close"] < row["open"]
```

## Stop placement

```python
def sr_stops(level: Decimal, atr: Decimal,
             side: str) -> tuple[Decimal, Decimal]:
    """
    Stop: just beyond the level (a close through = level broken, trade invalid).
    TP: opposite side of the range.
    """
    buffer = atr * Decimal("0.5")
    if side == "long":    # bounce from support
        sl = level - buffer
    else:                 # fade from resistance
        sl = level + buffer
    # TP = opposite range boundary, passed separately
    return sl, None
```

**Critical:** If price closes THROUGH the level (not just wicks), exit immediately. The level is broken and what was support is now resistance (and vice versa). Do not hold and hope.

## ⚠️ Mean Reversion Warning

Mean reversion (fading extended moves) is included here as a special case of S/R bounce — but only at the **range extremes**, not arbitrary levels.

**Additional risk rules for mean reversion in futures:**
- Maximum leverage 3x (this is a counter-move trade)
- Position size 50% of normal (wider stops needed)
- Must have a hard stop — no "wait for it to come back"
- Do NOT hold through funding if rate is against you
- If the move extends 1.5x ATR beyond the extreme, cut — it may be a breakout

Mean reversion in a trending market is not a strategy — it is a losing trade. Confirm `RANGING` regime before any fade.

## Confluence checklist

```python
sr_confluence = {
    "regime_ranging":        True,   # confirmed RANGING, not trending
    "level_strength_3plus":  True,   # 3+ historical touches
    "rejection_candle":      True,   # pin bar / engulfing at level
    "rsi_extreme":           False,  # RSI oversold/overbought at touch
    "htf_level_visible":     True,   # level holds on 4h or daily
    "volume_at_touch":       True,   # above-average volume at rejection
}
# Minimum 4/6. rejection_candle + level_strength are non-negotiable.
# Never trade mean reversion without rejection_candle confirmed.
```
