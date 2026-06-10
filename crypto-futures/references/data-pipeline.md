# Data Pipeline

Clean, gap-free market data is the foundation of every strategy and backtest. Garbage data → misleading backtest → real losses. Covers OHLCV backfill, funding history, indicators, and real-time candle reconstruction.

## Table of contents
- OHLCV backfill with pagination & gap detection
- Funding rate history
- Indicator calculation
- Real-time candle reconstruction from a stream

## OHLCV backfill with pagination & gap detection

`fetch_ohlcv` returns a limited window (often 500–1500 candles). For a long history, paginate forward by timestamp and stitch.

```python
import pandas as pd
from decimal import Decimal

def fetch_history(ex, symbol, timeframe="1h", since_ms=None, limit=1000):
    all_rows, cursor = [], since_ms
    tf_ms = ex.parse_timeframe(timeframe) * 1000
    while True:
        batch = ex.fetch_ohlcv(symbol, timeframe, since=cursor, limit=limit)
        if not batch:
            break
        all_rows += batch
        cursor = batch[-1][0] + tf_ms          # advance past last candle
        if len(batch) < limit:
            break                               # reached the present
    df = pd.DataFrame(all_rows, columns=["ts", "open", "high", "low", "close", "vol"])
    df = df.drop_duplicates("ts").sort_values("ts").reset_index(drop=True)
    df["dt"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df
```

**Always check for gaps** before trusting the data — exchange downtime or rate-limit drops leave holes that silently corrupt indicators and backtests.

```python
def find_gaps(df, timeframe_ms):
    diffs = df["ts"].diff().dropna()
    gaps = df.loc[diffs[diffs > timeframe_ms].index]
    return gaps          # rows that begin AFTER a missing interval
```

If gaps exist, decide deliberately: re-fetch the window, forward-fill (rarely correct for price), or drop the affected range. Never just ignore them.

Keep raw OHLCV as `Decimal` or high-precision when doing PnL math; pandas float columns are fine for indicators but not for money.

## Funding rate history

For perpetuals, funding is part of the return. Aggregate it alongside price.

```python
def fetch_funding_history(ex, symbol, since_ms=None, limit=1000):
    rows = ex.fetch_funding_rate_history(symbol, since=since_ms, limit=limit)
    df = pd.DataFrame([{
        "ts": r["timestamp"],
        "rate": float(r["fundingRate"]),
    } for r in rows])
    df["dt"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    return df
```

In a backtest of a holding strategy, apply funding at each funding timestamp to the open position — omitting it overstates returns for carries.

## Indicator calculation

Use `pandas-ta` (or `ta-lib`) rather than hand-rolling — hand-rolled indicators are a common source of off-by-one and look-ahead bugs.

```python
import pandas_ta as ta

df["ema_fast"] = ta.ema(df["close"], length=12)
df["ema_slow"] = ta.ema(df["close"], length=26)
df["rsi"] = ta.rsi(df["close"], length=14)
df["atr"] = ta.atr(df["high"], df["low"], df["close"], length=14)  # great for stops
```

**Look-ahead guard:** a signal at candle *t* may only use data available at the close of *t* (or earlier). Never let an indicator computed on the full series leak future information into a historical decision. When backtesting, shift signals by one bar before applying them to the next bar's price (see `backtesting-patterns.md`). ATR is especially useful for volatility-scaled stops — a stop at `entry - k*ATR` adapts to market conditions instead of a fixed percentage.

## Real-time candle reconstruction from a stream

When trading live off a websocket tick/trade stream, you often need to build the current (still-forming) candle yourself, and only act on *closed* candles.

```python
class CandleAggregator:
    def __init__(self, tf_ms: int):
        self.tf_ms = tf_ms
        self.current = None      # dict with bucket ts + ohlcv

    def update(self, trade_ts_ms: int, price: float, size: float):
        """Returns a CLOSED candle when one completes, else None."""
        bucket = trade_ts_ms - (trade_ts_ms % self.tf_ms)
        if self.current is None:
            self.current = self._new(bucket, price, size)
            return None
        if bucket > self.current["ts"]:
            closed = self.current
            self.current = self._new(bucket, price, size)
            return closed         # act only on this
        c = self.current
        c["high"] = max(c["high"], price)
        c["low"] = min(c["low"], price)
        c["close"] = price
        c["vol"] += size
        return None

    @staticmethod
    def _new(ts, price, size):
        return {"ts": ts, "open": price, "high": price,
                "low": price, "close": price, "vol": size}
```

Trade on **closed** candles, not the forming one — a strategy that reacts to an in-progress candle is reacting to noise that may reverse before close. Periodically reconcile your aggregated candles against REST `fetch_ohlcv` to catch dropped messages.
