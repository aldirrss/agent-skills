# Trend Following

Valid when: `TRENDING_BULL` or `TRENDING_BEAR` regime. HTF bias must align.
Absorbs: EMA Ribbon (9/21/50), VWAP trend confirmation.

## Core concept

Ride the dominant move. Enter on pullbacks to key EMAs during an established trend, not on breakouts into unknown territory. The trend is your filter — the pullback is your entry timing.

## Signal stack

```python
import pandas_ta as ta
import pandas as pd

def trend_signals(df: pd.DataFrame) -> dict:
    close = df["close"]

    # EMA Ribbon
    ema9   = ta.ema(close, length=9)
    ema21  = ta.ema(close, length=21)
    ema50  = ta.ema(close, length=50)

    # Ribbon aligned = trend healthy
    ribbon_bull = (ema9.iloc[-1] > ema21.iloc[-1] > ema50.iloc[-1])
    ribbon_bear = (ema9.iloc[-1] < ema21.iloc[-1] < ema50.iloc[-1])

    # Price pulled back to ribbon (entry zone, not chasing)
    price = close.iloc[-1]
    in_bull_zone = ribbon_bull and (ema21.iloc[-1] <= price <= ema9.iloc[-1] * 1.005)
    in_bear_zone = ribbon_bear and (ema21.iloc[-1] >= price >= ema9.iloc[-1] * 0.995)

    # ATR for stop distance
    atr = ta.atr(df["high"], df["low"], close, length=14).iloc[-1]

    # RSI: avoid overbought/oversold entries (chasing)
    rsi = ta.rsi(close, length=14).iloc[-1]
    rsi_ok_long  = 40 < rsi < 70    # not overbought
    rsi_ok_short = 30 < rsi < 60    # not oversold

    # Volume confirmation: entry bar volume > 20-bar avg
    vol_confirm = df["volume"].iloc[-1] > df["volume"].rolling(20).mean().iloc[-1]

    return {
        "ribbon_bull": ribbon_bull,
        "ribbon_bear": ribbon_bear,
        "in_bull_zone": in_bull_zone,
        "in_bear_zone": in_bear_zone,
        "atr": atr,
        "rsi": rsi,
        "rsi_ok_long": rsi_ok_long,
        "rsi_ok_short": rsi_ok_short,
        "vol_confirm": vol_confirm,
    }
```

## Entry rules

**Long entry (TRENDING_BULL):**
- HTF bias = bull ✓
- EMA ribbon aligned bullishly (9 > 21 > 50) ✓
- Price pulls back into ribbon zone (between EMA9 and EMA21) ✓
- RSI 40–70 (not overbought) ✓
- Entry candle closes above EMA9 after touching it ✓
- Volume on entry bar above 20-bar average ✓

**Short entry (TRENDING_BEAR):** mirror of above, ribbon inverted.

**Do NOT enter:**
- Price far above ribbon (chasing) — wait for pullback
- Ribbon compressing / crossing (trend losing strength — potential reversal)
- Opposing HTF bias

## Exit rules

```python
from decimal import Decimal

def trend_exit_levels(entry: Decimal, atr: Decimal, side: str,
                      risk_reward: float = 2.0) -> tuple[Decimal, Decimal]:
    """Returns (stop_loss, take_profit)."""
    # Stop: 1.5x ATR behind entry — gives room without being too wide
    stop_dist = atr * Decimal("1.5")
    tp_dist   = stop_dist * Decimal(str(risk_reward))

    if side == "long":
        sl = entry - stop_dist
        tp = entry + tp_dist
    else:
        sl = entry + stop_dist
        tp = entry - tp_dist
    return sl, tp
```

Trailing stop: once in profit by 1R (stop distance), move stop to breakeven. At 1.5R, trail stop to 0.5R profit. This locks gains while letting trend run.

```python
def trail_stop(entry: Decimal, current_price: Decimal,
               initial_stop: Decimal, side: str) -> Decimal:
    """Returns updated stop level. Call on each closed candle."""
    initial_risk = abs(entry - initial_stop)
    profit       = (current_price - entry) if side == "long" else (entry - current_price)
    pnl_r        = profit / initial_risk    # profit in R multiples

    if side == "long":
        if pnl_r >= 1.5:
            return max(initial_stop, current_price - initial_risk * Decimal("0.5"))
        if pnl_r >= 1.0:
            return max(initial_stop, entry)  # breakeven
    else:
        if pnl_r >= 1.5:
            return min(initial_stop, current_price + initial_risk * Decimal("0.5"))
        if pnl_r >= 1.0:
            return min(initial_stop, entry)
    return initial_stop
```

## VWAP as intraday trend filter

On lower timeframes (15m, 1h), VWAP acts as dynamic S/R within the trend:

```python
def vwap(df: pd.DataFrame) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    return (tp * df["volume"]).cumsum() / df["volume"].cumsum()

# Long bias: price > VWAP, longs on dips to VWAP
# Short bias: price < VWAP, shorts on bounces to VWAP
# Avoid: price oscillating around VWAP (no conviction)
```

## Confluence checklist for trend entry

```python
trend_confluence = {
    "htf_bias_aligned":   True,    # 4h+ trend matches direction
    "ribbon_aligned":     True,    # EMA 9/21/50 stacked correctly
    "in_pullback_zone":   True,    # price at EMA, not extended
    "rsi_not_extreme":    True,    # not overbought/oversold
    "volume_confirms":    False,   # entry bar volume check
    "vwap_side_correct":  True,    # price on correct side of VWAP
}
# Minimum 4/6 to trade. 5–6 → full size. 3 → half size or skip.
```
