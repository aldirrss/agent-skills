# Breakout

Valid when: `BREAKOUT` regime, or compression detected within `RANGING` regime.
Key insight: most breakouts fail. Trade the confirmation, not the candle that breaks.

## Core concept

Price compresses (lower ATR, tightening range) → energy builds → explosive expansion. The edge is identifying genuine breakouts from fakeouts. Volume and structure are the differentiators.

## Compression detection

```python
import pandas_ta as ta
import pandas as pd
from decimal import Decimal

def detect_compression(df: pd.DataFrame, lookback=20, threshold=0.6) -> bool:
    """
    True when current ATR is significantly below its recent average.
    Compression = volatility contraction = potential breakout setup.
    """
    atr     = ta.atr(df["high"], df["low"], df["close"], length=14)
    atr_now = atr.iloc[-1]
    atr_avg = atr.iloc[-lookback:].mean()
    return (atr_now / atr_avg) < threshold    # current ATR < 60% of avg = compressed

def range_boundaries(df: pd.DataFrame, lookback=20) -> tuple[Decimal, Decimal]:
    """Returns (range_high, range_low) of the compression zone."""
    recent = df.iloc[-lookback:]
    return Decimal(str(recent["high"].max())), Decimal(str(recent["low"].min()))
```

## Fakeout vs genuine breakout

This is the core challenge. Most breakouts fail on first attempt.

```python
def breakout_confirmation(df: pd.DataFrame, level: Decimal,
                          direction: str, confirm_bars=2) -> bool:
    """
    Requires N closed bars BEYOND the level before treating it as real.
    direction: 'up' or 'down'
    """
    closes = df["close"].iloc[-confirm_bars:]
    if direction == "up":
        return all(Decimal(str(c)) > level for c in closes)
    return all(Decimal(str(c)) < level for c in closes)

def volume_breakout_valid(df: pd.DataFrame, breakout_bar_idx=-1,
                           multiplier=1.5) -> bool:
    """Breakout bar volume must be >= 1.5x 20-bar average. No volume = suspect."""
    vol_avg = df["volume"].iloc[-21:-1].mean()
    return df["volume"].iloc[breakout_bar_idx] >= vol_avg * multiplier
```

**Fakeout signals (abort / do not enter):**
- Break bar has low volume (< avg)
- Price closes back inside range within 1–2 bars
- Wick extends beyond level but candle body stays inside
- HTF shows major resistance exactly at breakout level

**Genuine signals:**
- Break bar has 1.5x+ average volume
- Closes clearly beyond level (body, not just wick)
- Retests broken level and holds (best entry point)
- HTF structure supports continuation

## Entry strategy: retest > chase

```
Bad:  enter on the breakout candle itself (high risk, wide stop)
Good: wait for retest of the broken level, enter on confirmation hold
Best: enter on retest + rejection candle (pin bar, engulfing) at broken level
```

```python
def breakout_entry_type(df: pd.DataFrame, broken_level: Decimal,
                        direction: str) -> str:
    """Classify current price position relative to retest."""
    price = Decimal(str(df["close"].iloc[-1]))
    tolerance = broken_level * Decimal("0.002")   # 0.2% tolerance zone

    if direction == "up":
        at_retest = abs(price - broken_level) <= tolerance
        held      = price > broken_level - tolerance
        return "retest_hold" if (at_retest and held) else "extended"
    else:
        at_retest = abs(price - broken_level) <= tolerance
        held      = price < broken_level + tolerance
        return "retest_hold" if (at_retest and held) else "extended"
```

Prefer `retest_hold` entries — tighter stops, better R:R. Avoid `extended` entries unless strong momentum with volume.

## Stop placement

```python
def breakout_stops(broken_level: Decimal, atr: Decimal,
                   direction: str) -> tuple[Decimal, Decimal]:
    """
    Stop: just inside the broken level (a close back through = failed breakout).
    TP: measured move = height of the range that just broke.
    """
    buffer = atr * Decimal("0.3")   # small buffer inside broken level

    if direction == "up":
        sl = broken_level - buffer
        # Measured move: range height projected upward
        # Caller should pass range_high - range_low as range_height
    else:
        sl = broken_level + buffer

    # TP calculated from range height (measured move technique):
    # tp = broken_level + range_height  (up)
    # tp = broken_level - range_height  (down)
    return sl, None  # tp requires range_height from caller
```

Stop below the broken level (for longs) means: if price closes back inside the range, the breakout failed and you're out. Do not place stops deep inside the range — that's hoping, not managing risk.

## Confluence checklist

```python
breakout_confluence = {
    "compression_detected":  True,   # ATR contracted before break
    "volume_on_break":       True,   # 1.5x+ volume on breakout bar
    "closed_beyond_level":   True,   # body closed beyond, not just wick
    "retest_entry":          True,   # waiting for/entering at retest
    "htf_no_resistance":     False,  # no major HTF level blocking the move
    "regime_supports":       True,   # BREAKOUT or transition from RANGING
}
# Minimum 4/6 to trade. Skip if volume_on_break is False — it's the most critical.
```
