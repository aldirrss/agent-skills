# DataCollector

Exchange WebSocket subscription, candle normalization, Redis publish, and reconnect logic.

## Table of contents
- Implementation
- Candle normalization
- Reconnect strategy
- Multi-timeframe support

---

## Implementation

```python
# components/data_collector.py
import asyncio
import json
import time
from decimal import Decimal

import ccxt.pro as ccxtpro
from loguru import logger

from config import settings
from logger_setup import component_logger


async def run_data_collector(symbol: str, redis,
                              stop_event: asyncio.Event) -> None:
    """
    One DataCollector per symbol. Subscribes to exchange WebSocket,
    publishes closed candles to Redis Pub/Sub.
    Exchange credentials come from account config in Redis.
    """
    log = component_logger("data_collector", symbol)
    log.info("Starting")

    ex = await _make_exchange(redis, symbol)
    timeframes = ["1h", "15m"]   # subscribe to all TFs used by strategies

    try:
        while not stop_event.is_set():
            try:
                await _watch_loop(ex, symbol, redis, timeframes, stop_event, log)
            except ccxtpro.NetworkError as e:
                log.warning("WebSocket network error, reconnecting", error=str(e))
                await asyncio.sleep(2)
            except ccxtpro.ExchangeNotAvailable as e:
                log.warning("Exchange unavailable, waiting", error=str(e))
                await asyncio.sleep(10)
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Unexpected error in data collector")
                await asyncio.sleep(5)
    finally:
        await ex.close()
        log.info("Stopped")


async def _watch_loop(ex, symbol: str, redis,
                       timeframes: list[str], stop_event: asyncio.Event, log) -> None:
    """Inner loop — re-entered on reconnect."""
    # Subscribe all timeframes concurrently
    tasks = [
        asyncio.create_task(
            _watch_ohlcv(ex, symbol, tf, redis, stop_event, log),
            name=f"ohlcv.{symbol}.{tf}",
        )
        for tf in timeframes
    ]
    try:
        await asyncio.gather(*tasks)
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def _watch_ohlcv(ex, symbol: str, tf: str, redis,
                        stop_event: asyncio.Event, log) -> None:
    """Watch one timeframe, publish closed candles only."""
    tf_ms = ex.parse_timeframe(tf) * 1000

    while not stop_event.is_set():
        candles = await asyncio.wait_for(
            ex.watch_ohlcv(symbol, tf),
            timeout=45.0,   # exchange should send at least a heartbeat in 45s
        )
        for ts, o, h, l, c, v in candles:
            # Only publish CLOSED candles (current bar is still forming)
            candle_close_ts = ts + tf_ms
            if int(time.time() * 1000) < candle_close_ts:
                continue   # forming candle — skip

            payload = json.dumps({
                "open":   str(o), "high": str(h),
                "low":    str(l), "close": str(c),
                "vol":    str(v), "ts":   ts,
                "tf":     tf,     "closed": True,
            })
            channel = f"market.{symbol}.candle.{tf}"
            await redis.publish(channel, payload)

            # Update latest price cache (TTL 10s)
            await redis.set(f"state.price.{symbol}", str(c), ex=10)

            log.debug("Candle published", tf=tf, close=c)


async def _make_exchange(redis, symbol: str):
    """
    Build ccxt.pro exchange instance from account config stored in Redis.
    Supports testnet via config flag.
    """
    config_raw = await redis.get(f"config.worker.{symbol}")
    config = json.loads(config_raw) if config_raw else {}

    account_id   = config.get("account_id")
    is_testnet   = config.get("is_testnet", False)
    exchange_name = config.get("exchange", "binance")

    # Resolve API key from env (never stored in Redis directly)
    import os
    api_key_ref = config.get("api_key_ref", "")
    api_key     = os.getenv(api_key_ref, "")
    api_secret  = os.getenv(api_key_ref.replace("KEY", "SECRET"), "")

    ExClass = getattr(ccxtpro, exchange_name)
    ex = ExClass({
        "apiKey":          api_key,
        "secret":          api_secret,
        "enableRateLimit": True,
        "options":         {"defaultType": "future"},
    })
    if is_testnet:
        ex.set_sandbox_mode(True)

    await ex.load_markets()
    return ex
```

---

## Candle normalization

When consuming candles from Redis, always normalize to Decimal immediately:

```python
# In StrategyWorker — receiving from pub/sub
def parse_candle(raw: str) -> dict:
    data = json.loads(raw)
    return {
        "open":   Decimal(data["open"]),
        "high":   Decimal(data["high"]),
        "low":    Decimal(data["low"]),
        "close":  Decimal(data["close"]),
        "vol":    Decimal(data["vol"]),
        "ts":     int(data["ts"]),
        "tf":     data["tf"],
        "closed": data["closed"],
    }
```

Never pass raw floats from JSON into strategy calculations — JSON floats lose precision silently.

---

## Reconnect strategy

The outer `while not stop_event.is_set()` loop in `run_data_collector` handles reconnect automatically. ccxt.pro manages the WebSocket connection internally — on `NetworkError`, just sleep briefly and re-enter `_watch_loop`. The exchange class creates a fresh WebSocket connection on the next `watch_ohlcv` call.

Reconnect backoff:
- `NetworkError`: 2s (transient)
- `ExchangeNotAvailable`: 10s (maintenance)
- Unexpected exceptions: 5s

Do not implement exponential backoff here — if the exchange is consistently down, the bot should keep trying at a steady rate, not give up after a few attempts.

---

## Multi-timeframe support

Each timeframe runs as a separate `_watch_ohlcv` task within the same `_watch_loop`. They share the same ccxt exchange instance (safe — ccxt.pro handles internal multiplexing per timeframe).

To add a new timeframe globally, add it to the `timeframes` list in `run_data_collector`. To configure per-symbol timeframes, store them in `config.worker.{symbol}` under the `"timeframes"` key and read from there:

```python
config    = json.loads(await redis.get(f"config.worker.{symbol}") or "{}")
timeframes = config.get("timeframes", ["1h", "15m"])
```
