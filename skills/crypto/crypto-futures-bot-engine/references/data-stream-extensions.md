# Data Stream Extensions

CVD trade stream and liquidation events — additional data sources required by
`momentum` and `liquidation` strategies. Read alongside `data-collector.md`.

## Table of contents
- New Redis keys
- CVD: extend DataCollector with `_watch_trades_cvd`
- LiquidationCollector: new shared component
- main.py integration
- StrategyWorker helper functions
- Graceful degradation

---

## New Redis keys

```
# CVD (per symbol, per timeframe)
cvd.candles.{symbol}.{tf}       # Redis LIST, last 500 closed-candle deltas
                                 # each item JSON: {ts, delta, buy_vol, sell_vol}

# Liquidation events (per symbol)
liq.events.{symbol}             # Redis Stream, last 1000 events
                                 # fields: ts, side, qty, price, notional
liq.summary.{symbol}.5m         # JSON aggregate: {long_vol, short_vol, window_start}
liq.summary.{symbol}.30m        # 30min aggregate (same schema)
```

Both additions are **optional at runtime**: if no data is present, strategies
degrade gracefully (CVD divergence = "none", liquidation signals = skipped).

---

## CVD: extend DataCollector

### What to change in `data-collector.md`

Add `_watch_trades_cvd` as a third task inside `_watch_loop`:

```python
# components/data_collector.py  — modified _watch_loop
async def _watch_loop(ex, symbol: str, redis,
                       timeframes: list[str], stop_event: asyncio.Event, log) -> None:
    """Inner loop — re-entered on reconnect. Extended with CVD trade stream."""
    primary_tf = timeframes[0]   # CVD aggregated on primary timeframe only

    tasks = [
        asyncio.create_task(
            _watch_ohlcv(ex, symbol, tf, redis, stop_event, log),
            name=f"ohlcv.{symbol}.{tf}",
        )
        for tf in timeframes
    ] + [
        asyncio.create_task(
            _watch_trades_cvd(ex, symbol, primary_tf, redis, stop_event, log),
            name=f"cvd.{symbol}",
        )
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
```

### `_watch_trades_cvd` implementation

```python
# components/data_collector.py — new function

async def _watch_trades_cvd(ex, symbol: str, primary_tf: str, redis,
                              stop_event: asyncio.Event, log) -> None:
    """
    Subscribe to trade stream (individual fills), accumulate CVD per candle.
    Writes to Redis LIST when a candle bucket closes.

    trade["side"] in ccxt is the TAKER side:
      "buy"  = aggressive market buy  → positive delta (buying pressure)
      "sell" = aggressive market sell → negative delta (selling pressure)

    In-memory accumulation per bucket — Redis only touched on candle close,
    not on every trade (can be thousands per minute for BTC).
    """
    tf_ms = ex.parse_timeframe(primary_tf) * 1000
    log.info("CVD trade stream starting", tf=primary_tf)

    bucket_ts:  int | None = None
    delta:      float      = 0.0
    buy_vol:    float      = 0.0
    sell_vol:   float      = 0.0

    while not stop_event.is_set():
        try:
            trades = await asyncio.wait_for(
                ex.watch_trades(symbol),
                timeout=45.0,
            )
        except asyncio.TimeoutError:
            log.warning("CVD trade stream timeout, reconnecting", symbol=symbol)
            raise   # outer loop handles reconnect

        for trade in trades:
            ts     = trade["timestamp"]
            amount = float(trade["amount"])
            side   = trade["side"]           # "buy" or "sell" (taker side)

            d      = amount if side == "buy" else -amount
            bucket = ts - (ts % tf_ms)

            if bucket_ts is None:
                bucket_ts = bucket

            if bucket > bucket_ts:
                # ── Candle closed → flush accumulator to Redis ──────
                await _push_cvd_candle(redis, symbol, primary_tf,
                                        bucket_ts, delta, buy_vol, sell_vol)
                log.debug("CVD candle pushed",
                          tf=primary_tf, delta=round(delta, 4))
                # Reset accumulator for new bucket
                bucket_ts = bucket
                delta     = 0.0
                buy_vol   = 0.0
                sell_vol  = 0.0

            delta    += d
            buy_vol  += amount if side == "buy" else 0.0
            sell_vol += amount if side == "sell" else 0.0


async def _push_cvd_candle(redis, symbol: str, tf: str,
                             ts: int, delta: float,
                             buy_vol: float, sell_vol: float) -> None:
    """Append one closed CVD candle to Redis LIST, keep last 500."""
    key   = f"cvd.candles.{symbol}.{tf}"
    entry = json.dumps({
        "ts":       ts,
        "delta":    round(delta,    6),
        "buy_vol":  round(buy_vol,  6),
        "sell_vol": round(sell_vol, 6),
    })
    pipe = redis.pipeline()
    pipe.rpush(key, entry)
    pipe.ltrim(key, -500, -1)   # rolling window of 500 candles
    await pipe.execute()
```

---

## LiquidationCollector: new shared component

Exchange-specific: Binance USDM futures. For Bybit/OKX, swap the URL and
adjust the event schema parsing (`_parse_event`).

```python
# components/liquidation_collector.py
import asyncio
import json
import time

import websockets
from loguru import logger

from logger_setup import component_logger


class LiquidationCollector:
    """
    Subscribes to Binance forced-order WebSocket stream (all symbols, one connection).
    Stores events in Redis Stream and rolling summaries for liquidation strategy.

    Shared component: one instance covers all symbols in registry.
    Exchange: Binance USDM futures. Stream: !forceOrder@arr
    """

    _WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr"

    def __init__(self, redis, registry):
        self.redis    = redis
        self.registry = registry
        self.log      = component_logger("liquidation_collector")

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        while not stop_event.is_set():
            try:
                await self._stream_loop(stop_event)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.log.warning("Stream error, reconnecting in 5s", error=str(e))
                await asyncio.sleep(5)
        self.log.info("Stopped")

    async def _stream_loop(self, stop_event: asyncio.Event) -> None:
        async with websockets.connect(
            self._WS_URL,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            self.log.info("Liquidation stream connected")
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=30.0)
                    event = json.loads(raw)
                    await self._process(event)
                except asyncio.TimeoutError:
                    await ws.ping()   # keepalive
                except websockets.ConnectionClosed:
                    raise

    async def _process(self, event: dict) -> None:
        if event.get("e") != "forceOrder":
            return

        order  = event["o"]
        symbol = order["s"]

        # Only track symbols the bot is actively running
        if symbol not in self.registry.all_symbols():
            return

        liq    = self._parse_event(event)
        ts_ms  = liq["ts"]

        # ── Write to Redis Stream ─────────────────────────────────────
        await self.redis.xadd(
            f"liq.events.{symbol}",
            {
                "ts":       str(ts_ms),
                "side":     liq["side"],
                "qty":      str(liq["qty"]),
                "price":    str(liq["price"]),
                "notional": str(liq["notional"]),
            },
            maxlen=1000,
            approximate=True,
        )

        # ── Update rolling summaries ──────────────────────────────────
        await self._update_summary(symbol, liq["side"], liq["notional"], ts_ms)

        self.log.debug("Liquidation",
                        symbol=symbol, side=liq["side"],
                        notional=round(liq["notional"], 0))

    @staticmethod
    def _parse_event(event: dict) -> dict:
        """
        Normalize Binance forceOrder event.

        Binance order side in forceOrder:
          SELL = the exchange is selling (closing a long) → long was liquidated
          BUY  = the exchange is buying  (closing a short) → short was liquidated
        We store the *liquidated position side*, not the order side.
        """
        order     = event["o"]
        order_side = order["S"].upper()               # "BUY" or "SELL"
        liq_side   = "long" if order_side == "SELL" else "short"

        qty      = float(order["q"])
        price    = float(order["ap"]) if order.get("ap") and float(order["ap"]) > 0 \
                   else float(order["p"])

        return {
            "ts":       event["E"],
            "side":     liq_side,
            "qty":      round(qty,   6),
            "price":    round(price, 4),
            "notional": round(qty * price, 2),
        }

    async def _update_summary(self, symbol: str, side: str,
                               notional: float, ts_ms: int) -> None:
        """
        Maintain 5min and 30min rolling notional volume per liquidation side.
        Window resets when elapsed time exceeds the window duration.
        """
        for window_s, suffix in [(300, "5m"), (1800, "30m")]:
            key = f"liq.summary.{symbol}.{suffix}"
            raw = await self.redis.get(key)

            if raw:
                summary = json.loads(raw)
                elapsed = (ts_ms - summary["window_start"]) / 1000
                if elapsed > window_s:
                    summary = {"long_vol": 0.0, "short_vol": 0.0,
                               "window_start": ts_ms}
            else:
                summary = {"long_vol": 0.0, "short_vol": 0.0,
                           "window_start": ts_ms}

            if side == "long":
                summary["long_vol"] += notional
            else:
                summary["short_vol"] += notional

            await self.redis.set(key, json.dumps(summary), ex=window_s + 120)
```

---

## main.py integration

Add `LiquidationCollector` to the shared components block and task list:

```python
# main.py — additions only (not a full replacement)
from components.liquidation_collector import LiquidationCollector

# ── Shared components (add after existing ones) ──────────────────────
liq_collector = LiquidationCollector(redis, registry)

# ── Task list (add one entry) ─────────────────────────────────────────
tasks = [
    ...   # existing tasks
    asyncio.create_task(liq_collector.run(stop_event), name="liquidation_collector"),
]
```

`LiquidationCollector` connects only to Binance. If the bot is configured to
trade on Bybit or OKX, skip this task or swap the implementation — it will not
crash, it will simply produce no data (strategies degrade gracefully).

### `requirements.txt` addition

```
websockets
```

`ccxt.pro` already depends on `aiohttp`/`websockets` internally, so this is
usually already present. Pin explicitly to avoid silent upgrades.

---

## StrategyWorker helper functions

Add these helpers to `components/strategy_worker.py` and call them from
`_evaluate_and_publish` before routing to strategy functions.

```python
# components/strategy_worker.py — new helper functions

import json
import time
import pandas as pd


async def get_cvd_series(redis, symbol: str, tf: str,
                          n: int = 200) -> pd.DataFrame | None:
    """
    Read the last N closed-candle CVD records from Redis.
    Returns DataFrame with columns: ts, delta, buy_vol, sell_vol, cvd.
    cvd = cumulative sum of delta (per window, not absolute).
    Returns None if insufficient history (< 20 candles).
    """
    raw_list = await redis.lrange(f"cvd.candles.{symbol}.{tf}", -n, -1)
    if len(raw_list) < 20:
        return None

    rows = [json.loads(r) for r in raw_list]
    df   = pd.DataFrame(rows)
    df["cvd"] = df["delta"].cumsum()
    return df


async def get_liquidation_summary(redis, symbol: str) -> dict:
    """
    Returns {5m: {long_vol, short_vol}, 30m: {long_vol, short_vol}}.
    Empty dicts if no data — caller must handle gracefully.
    """
    raw_5m  = await redis.get(f"liq.summary.{symbol}.5m")
    raw_30m = await redis.get(f"liq.summary.{symbol}.30m")
    return {
        "5m":  json.loads(raw_5m)  if raw_5m  else {},
        "30m": json.loads(raw_30m) if raw_30m else {},
    }


async def get_recent_liquidations(redis, symbol: str,
                                   window_s: int = 300) -> list[dict]:
    """
    Read individual liquidation events from Redis Stream for cascade detection.
    Used by _strategy_liquidation().
    Returns list of {ts, side, qty, price, notional}, newest last.
    """
    min_id  = f"{(int(time.time()) - window_s) * 1000}-0"
    entries = await redis.xrange(f"liq.events.{symbol}",
                                  min=min_id, count=500)
    return [
        {
            "ts":       int(msg_id.split("-")[0]),
            "side":     data["side"],
            "qty":      float(data["qty"]),
            "price":    float(data["price"]),
            "notional": float(data["notional"]),
        }
        for msg_id, data in entries
    ]
```

### Wire into `_evaluate_and_publish`

```python
# components/strategy_worker.py — _evaluate_and_publish (extended)

async def _evaluate_and_publish(symbol, config, buffer, latest, redis, log):
    try:
        df     = _buffer_to_df(buffer)
        tf     = config.get("timeframe", "1h")

        # ── Fetch extended data (non-blocking, degrade on miss) ───────
        cvd_df = await get_cvd_series(redis, symbol, tf)         # None if no data
        liq_s  = await get_liquidation_summary(redis, symbol)    # {} if no data

        signal = await _route_strategy(symbol, config, df, latest,
                                        redis, cvd_df, liq_s)
        if signal is None:
            return

        signal.update({
            "symbol":    symbol,
            "strategy":  config["strategy"],
            "signal_ts": str(int(time.time() * 1000)),
        })
        await redis.xadd("stream.signals", signal,
                          maxlen=100_000, approximate=True)
        log.info("Signal published",
                 direction=signal["direction"],
                 confidence=signal["confidence"])

    except Exception:
        log.exception("Error evaluating strategy")
```

Update `_route_strategy` signature to accept `cvd_df` and `liq_s`:

```python
async def _route_strategy(symbol, config, df, latest,
                           redis, cvd_df, liq_s) -> dict | None:
    strategy = config.get("strategy", "trend")
    llm      = await _get_llm_signal(redis, symbol)

    strategies = {
        "trend":       _strategy_trend,
        "breakout":    _strategy_breakout,
        "momentum":    _strategy_momentum,
        "sr_bounce":   _strategy_sr_bounce,
        "funding":     _strategy_funding_reversal,
        "liquidation": _strategy_liquidation,
    }
    fn = strategies.get(strategy)
    if not fn:
        raise ValueError(f"Unknown strategy: {strategy}")

    return await fn(symbol, config, df, llm, redis, cvd_df, liq_s)
```

### `_strategy_momentum` with real CVD

```python
async def _strategy_momentum(symbol, config, df, llm, redis,
                               cvd_df, liq_s) -> dict | None:
    """
    Momentum continuation — fib retracement + CVD divergence + VWAP reclaim.
    See crypto-futures-strategies/references/momentum.md for full logic.
    Requires cvd_df to be non-None; returns None if CVD data unavailable.
    """
    if cvd_df is None or len(cvd_df) < 20:
        return None   # CVD data not yet available — skip this candle

    import pandas_ta as ta

    close   = df["close"]
    high    = df["high"]
    low     = df["low"]
    volume  = df["vol"]

    ema50   = ta.ema(close, length=50)
    ema200  = ta.ema(close, length=200)
    atr     = ta.atr(high, low, close, length=14)
    rsi     = ta.rsi(close, length=14)

    if ema50.isna().iloc[-1] or atr.isna().iloc[-1]:
        return None

    price   = float(close.iloc[-1])
    atr_val = float(atr.iloc[-1])

    # HTF bias
    trend_bull = ema50.iloc[-1] > ema200.iloc[-1]
    trend_bear = ema50.iloc[-1] < ema200.iloc[-1]

    # VWAP (session)
    tp     = (high + low + close) / 3
    vwap   = (tp * volume).cumsum() / volume.cumsum()
    prev_close = float(close.iloc[-2])
    curr_close = float(close.iloc[-1])
    vwap_prev  = float(vwap.iloc[-2])
    vwap_curr  = float(vwap.iloc[-1])

    # VWAP reclaim signal
    vwap_reclaim_long  = prev_close < vwap_prev and curr_close > vwap_curr
    vwap_reclaim_short = prev_close > vwap_prev and curr_close < vwap_curr

    # CVD divergence (from cvd_df)
    price_col = pd.Series(df["close"].values[-len(cvd_df):])
    cvd_col   = cvd_df["cvd"].values[-len(price_col):]
    if len(price_col) < 20 or len(cvd_col) < 20:
        return None

    price_down = price_col.iloc[-1] < price_col.iloc[-20]
    cvd_up     = float(cvd_col[-1]) > float(cvd_col[-20])
    price_up   = price_col.iloc[-1] > price_col.iloc[-20]
    cvd_down   = float(cvd_col[-1]) < float(cvd_col[-20])

    bullish_divergence = price_down and cvd_up
    bearish_divergence = price_up and cvd_down

    rsi_val = float(rsi.iloc[-1])

    # ── Direction decision ────────────────────────────────────────────
    direction = None
    if trend_bull and vwap_reclaim_long and bullish_divergence and 40 < rsi_val < 65:
        direction = "long"
    elif trend_bear and vwap_reclaim_short and bearish_divergence and 35 < rsi_val < 60:
        direction = "short"
    if not direction:
        return None

    # ── Confluence score ──────────────────────────────────────────────
    signals = {
        "htf_trend_aligned":   trend_bull if direction == "long" else trend_bear,
        "vwap_reclaim":        vwap_reclaim_long if direction == "long" else vwap_reclaim_short,
        "cvd_divergence":      bullish_divergence if direction == "long" else bearish_divergence,
        "rsi_in_range":        True,
        "llm_aligned":         _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    if score < config.get("confluence_threshold", 3):
        return None

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "regime":             "momentum",
        "confluence_score":   str(score),
        "confluence_details": json.dumps(signals),
        "llm_score":          str(llm["score"])    if llm else "",
        "llm_direction":      llm["direction"]     if llm else "",
    }


async def _strategy_liquidation(symbol, config, df, llm, redis,
                                  cvd_df, liq_s) -> dict | None:
    """
    Liquidation-based — fade the stop hunt or ride the cascade.
    See crypto-futures-strategies/references/liquidation.md for full logic.
    Degrades gracefully if no liquidation data (Bybit/OKX or stream not started).
    """
    from decimal import Decimal

    # ── Try cascade signal (uses rolling summary) ─────────────────────
    cascade_threshold = config.get("liq_cascade_threshold_usd", 2_000_000)
    five_min = liq_s.get("5m", {})

    if five_min:
        long_liq  = five_min.get("long_vol", 0)
        short_liq = five_min.get("short_vol", 0)

        if long_liq > cascade_threshold:
            direction = "short"   # large long liquidations = price fell hard
        elif short_liq > cascade_threshold:
            direction = "long"    # large short liquidations = price rose hard
        else:
            direction = None

        if direction:
            atr_val = float(df["atr"].iloc[-1]) if "atr" in df.columns else \
                      float(__import__("pandas_ta").atr(
                          df["high"], df["low"], df["close"], length=14).iloc[-1])

            signals = {
                "cascade_volume_exceeded": True,
                "direction_clear": long_liq != short_liq,
                "llm_aligned": _llm_aligned(llm, direction),
            }
            score = sum(signals.values())
            if score >= 2:
                return {
                    "direction":          direction,
                    "confidence":         str(round(score / len(signals), 4)),
                    "entry_price":        str(round(float(df["close"].iloc[-1]), 4)),
                    "atr":                str(round(atr_val, 4)),
                    "regime":             "liquidation_cascade",
                    "confluence_score":   str(score),
                    "confluence_details": json.dumps(signals),
                    "llm_score":          str(llm["score"])   if llm else "",
                    "llm_direction":      llm["direction"]    if llm else "",
                }

    # ── Fallback: no liquidation data → return None ──────────────────
    # Strategy will not fire without data — safe default
    return None
```

---

## Graceful degradation

If `LiquidationCollector` is not started (non-Binance exchange) or CVD data
is not yet collected (worker just spawned), strategies behave as follows:

| Condition | Momentum | Liquidation |
|---|---|---|
| `cvd_df is None` | Returns `None` (no signal this candle) | N/A |
| `liq_s` empty dicts | N/A | Returns `None` (no signal) |
| Both missing | No signal from these two strategies | No signal |
| Other strategies | Unaffected — `cvd_df` and `liq_s` are ignored | Unaffected |

**Warm-up time:** CVD data becomes available ~1 candle after the worker starts
(first trade stream candle close). Liquidation summary becomes meaningful after
~5 minutes of events. This is acceptable — it's better to skip a few signals
at startup than to trade on incomplete data.
