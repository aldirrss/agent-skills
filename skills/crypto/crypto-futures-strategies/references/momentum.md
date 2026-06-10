# Momentum Continuation

Valid when: `TRENDING_BULL` or `TRENDING_BEAR` + price pulls back to a key level during the trend.
Difference from Trend Following: Momentum targets the *next leg* after a pause, using VWAP deviation and CVD to confirm buying/selling pressure is resuming.

## Core concept

In a trending market, price does not move in a straight line — it impulses, pauses/retraces, then continues. Momentum Continuation enters at the end of the pause, when evidence shows the original momentum is resuming. It's more aggressive than pure trend following (shorter hold, higher frequency) and relies on order flow signals.

## Impulse-Pullback-Continuation structure

```
Impulse leg  ──→  Pullback (retracement)  ──→  Continuation (entry here)
               └─ 38.2% to 61.8% fib
               └─ VWAP reclaim
               └─ CVD divergence ends
```

```python
import pandas_ta as ta
import pandas as pd
from decimal import Decimal

def fib_retracement_levels(swing_high: Decimal, swing_low: Decimal,
                            direction: str) -> dict:
    """
    For a bullish impulse (direction='up'): retracement from high back toward low.
    Returns key fib levels as entry zones.
    """
    diff = swing_high - swing_low
    if direction == "up":
        return {
            "0.382": swing_high - diff * Decimal("0.382"),
            "0.500": swing_high - diff * Decimal("0.500"),
            "0.618": swing_high - diff * Decimal("0.618"),
            "0.786": swing_high - diff * Decimal("0.786"),   # deep, last chance
        }
    else:
        return {
            "0.382": swing_low + diff * Decimal("0.382"),
            "0.500": swing_low + diff * Decimal("0.500"),
            "0.618": swing_low + diff * Decimal("0.618"),
            "0.786": swing_low + diff * Decimal("0.786"),
        }
```

**Preferred entry zone:** 38.2%–61.8% retracement. Deeper than 78.6% = potential trend reversal, not continuation.

## CVD (Cumulative Volume Delta)

CVD measures net buying vs selling pressure from trade data. Divergence between price and CVD during pullback confirms the pullback is just profit-taking (weak), not genuine selling.

```python
def compute_cvd(trades: list[dict]) -> pd.Series:
    """
    trades: list of {'price': float, 'qty': float, 'side': 'buy'|'sell'}
    CVD rising during price pullback = bullish divergence = continuation likely.
    CVD falling during price rally = bearish divergence = reversal warning.
    """
    deltas = [t["qty"] if t["side"] == "buy" else -t["qty"] for t in trades]
    return pd.Series(deltas).cumsum()

def cvd_divergence(price_series: pd.Series, cvd_series: pd.Series,
                   lookback=20) -> str:
    """Returns 'bullish', 'bearish', or 'none'."""
    price_down = price_series.iloc[-1] < price_series.iloc[-lookback]
    cvd_up     = cvd_series.iloc[-1]   > cvd_series.iloc[-lookback]
    price_up   = price_series.iloc[-1] > price_series.iloc[-lookback]
    cvd_down   = cvd_series.iloc[-1]   < cvd_series.iloc[-lookback]

    if price_down and cvd_up:
        return "bullish"    # price retraced but buyers absorbing — continuation up
    if price_up and cvd_down:
        return "bearish"    # price rose but sellers absorbing — continuation down
    return "none"
```

## VWAP reclaim as trigger

VWAP acts as the "fair value" anchor within a session. During a bullish pullback:
- Price dips below VWAP (shakeout)
- Reclaims VWAP on strong volume
- This reclaim = entry trigger for continuation long

```python
def vwap(df: pd.DataFrame) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    return (tp * df["volume"]).cumsum() / df["volume"].cumsum()

def vwap_reclaim_signal(df: pd.DataFrame, side: str) -> bool:
    """
    Bullish: previous bar below VWAP, current bar closes above VWAP.
    Bearish: previous bar above VWAP, current bar closes below VWAP.
    """
    vwap_s  = vwap(df)
    prev_close = df["close"].iloc[-2]
    curr_close = df["close"].iloc[-1]
    vwap_prev  = vwap_s.iloc[-2]
    vwap_curr  = vwap_s.iloc[-1]

    if side == "long":
        return prev_close < vwap_prev and curr_close > vwap_curr
    return prev_close > vwap_prev and curr_close < vwap_curr
```

## Entry rules

**Long (continuation up):**
- HTF + MTF trend = bullish ✓
- Price retraced 38.2%–61.8% from last swing high ✓
- CVD divergence = bullish during pullback ✓
- VWAP reclaim on entry bar ✓
- RSI reset to 40–55 range during pullback (unwound overbought) ✓

**Short (continuation down):** mirror of above.

## Stop and target

```python
def momentum_levels(entry: Decimal, swing_extreme: Decimal,
                    atr: Decimal, side: str) -> tuple[Decimal, Decimal]:
    """
    Stop: below the pullback low (long) or above pullback high (short).
    Buffer of 0.3x ATR so minor wicks don't stop out.
    Target: previous swing extreme + 0.5x ATR extension (new high/low).
    """
    buffer = atr * Decimal("0.3")
    if side == "long":
        sl = entry - atr * Decimal("1.0") - buffer
        tp = swing_extreme + atr * Decimal("0.5")
    else:
        sl = entry + atr * Decimal("1.0") + buffer
        tp = swing_extreme - atr * Decimal("0.5")
    return sl, tp
```

A continuation trade that doesn't reach the prior swing extreme within a reasonable time (3–5 bars on entry timeframe) is losing momentum — consider exiting early.

## Confluence checklist

```python
momentum_confluence = {
    "htf_trend_aligned":     True,   # 4h bias matches direction
    "fib_zone_entry":        True,   # 38.2–61.8% pullback depth
    "cvd_divergence":        True,   # CVD holding while price retraced
    "vwap_reclaim":          False,  # reclaim signal on trigger bar
    "rsi_reset":             True,   # RSI unwound from extreme during pullback
    "volume_on_signal_bar":  True,   # pick-up in volume on entry candle
}
# Minimum 4/6. cvd_divergence + htf_trend_aligned are the two non-negotiables.
```
