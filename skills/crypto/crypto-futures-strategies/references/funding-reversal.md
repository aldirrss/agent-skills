# Funding Rate Reversal

Valid when: Extreme funding rate in any regime. Futures-exclusive — does not exist in spot.
Core insight: Extreme funding means the market is crowded on one side. When everyone is long (and paying high funding), the crowd is the exit liquidity.

## How funding works

Perpetual contracts have no expiry, so they stay anchored to spot via funding:
- Funding rate > 0 → longs pay shorts (market is net long / bullish bias)
- Funding rate < 0 → shorts pay longs (market is net short / bearish bias)
- Paid every 8 hours (Binance/Bybit) or 1 hour (some exchanges)

Annualized equivalent: `rate_per_8h * 3 * 365`. A 0.1% per 8h rate = 109.5% annualized cost of holding.

## Fetching funding data

```python
from decimal import Decimal
import pandas as pd

def get_funding_rate(ex, symbol) -> Decimal:
    fr = ex.fetch_funding_rate(symbol)
    return Decimal(str(fr["fundingRate"]))

def get_funding_history(ex, symbol, limit=90) -> pd.DataFrame:
    """Last N funding periods (90 = 30 days at 8h intervals)."""
    history = ex.fetch_funding_rate_history(symbol, limit=limit)
    df = pd.DataFrame([{
        "ts":   h["timestamp"],
        "rate": Decimal(str(h["fundingRate"])),
    } for h in history])
    df["dt"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df

def funding_percentile(ex, symbol, current_rate: Decimal,
                       lookback=90) -> float:
    """Where does current rate sit in the historical distribution? 0–1."""
    hist = get_funding_history(ex, symbol, limit=lookback)
    rates = [float(r) for r in hist["rate"]]
    below = sum(1 for r in rates if r < float(current_rate))
    return below / len(rates)
```

## Extreme thresholds

| Condition | Threshold | Signal |
|---|---|---|
| Extreme positive | > 0.10% per 8h | Shorts favored (longs overpaying) |
| Very extreme positive | > 0.20% per 8h | High conviction short setup |
| Extreme negative | < -0.05% per 8h | Longs favored (shorts overpaying) |
| Very extreme negative | < -0.10% per 8h | High conviction long setup |
| Neutral | -0.05% to 0.10% | No funding edge |

Raw numbers matter less than **percentile rank**. A rate at the 95th percentile of its 30-day history is more meaningful than an absolute threshold that varies by market cycle.

## Entry logic

Funding reversal is a **mean-reversion of sentiment**, not price. The trigger is not the extreme funding itself — it's price action confirming the reversal is beginning.

```python
def funding_reversal_signal(ex, symbol, df_price: pd.DataFrame) -> dict:
    rate  = get_funding_rate(ex, symbol)
    pct   = funding_percentile(ex, symbol, rate)

    # Determine favored direction
    if pct > 0.90:      # top 10% historically = extreme long crowding
        direction = "short"
        extreme   = True
    elif pct < 0.10:    # bottom 10% = extreme short crowding
        direction = "long"
        extreme   = True
    else:
        direction, extreme = None, False

    if not extreme:
        return {"signal": False}

    # Price confirmation: needs to show reversal signs, not just funding alone
    import pandas_ta as ta
    rsi = ta.rsi(df_price["close"], length=14).iloc[-1]
    # For short: overbought RSI + bearish candle = extra confirmation
    # For long:  oversold RSI + bullish candle = extra confirmation
    rsi_confirms = (rsi > 70 and direction == "short") or \
                   (rsi < 30 and direction == "long")

    return {
        "signal":        extreme,
        "direction":     direction,
        "rate":          rate,
        "percentile":    pct,
        "rsi_confirms":  rsi_confirms,
        "funding_cost":  rate * 3 * 365,   # annualized, useful for sizing context
    }
```

## Timing: funding timestamps

The reversal typically plays out **around the funding collection time**, not necessarily at the extreme rate discovery. The crowd that's been paying high funding has incentive to close before the next payment.

```python
def seconds_to_next_funding(interval_hours=8) -> int:
    import time
    interval_s = interval_hours * 3600
    return interval_s - (int(time.time()) % interval_s)

# Strategy:
# - Identify extreme funding
# - Enter 30–60 minutes BEFORE the funding timestamp (crowd starts closing)
# - Take profit quickly — this is not a trend trade
# - Avoid holding THROUGH multiple funding periods (original edge consumed)
```

## Risk characteristics

This strategy is **counter-trend by nature** — you're fading the crowd when they're most confident. Risk rules are stricter:

- Maximum leverage: 5x
- Position size: 50–75% of normal
- Take profit: 1–2% price move (quick profit, not a runner)
- Stop: 1x ATR beyond entry — if price accelerates against you, the crowd isn't reversing yet
- Do not pyramid — if initial entry is wrong, don't add

## Confluence checklist

```python
funding_confluence = {
    "rate_percentile_90plus":    True,   # top/bottom 10% historically
    "rsi_confirms_extreme":      False,  # RSI overbought/oversold at same time
    "price_reversal_candle":     True,   # rejection wick or engulfing forming
    "timing_pre_funding":        True,   # within 60min of funding timestamp
    "volume_spike_at_extreme":   False,  # capitulation volume
    "ls_ratio_extreme":          False,  # long/short ratio confirms crowding
}
# Minimum 3/6 — this is inherently a lower-confluence trade.
# rate_percentile_90plus + price_reversal_candle are non-negotiable.
```
