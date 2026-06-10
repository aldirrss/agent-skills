# Worker Lifecycle

How workers are spawned, run, gracefully stopped, and recovered after crash. All workers are asyncio Tasks within the single bot engine process.

## Table of contents
- Worker registry
- Spawning a worker pair (DataCollector + StrategyWorker)
- Graceful stop
- Crash detection and recovery
- Startup sequence
- Shutdown sequence

## Worker registry

The bot engine maintains a registry of all running tasks. This is the ground truth for what is active — not Redis (Redis reflects desired state; registry reflects actual state).

```python
import asyncio
from dataclasses import dataclass, field
from typing import Optional

@dataclass
class WorkerSet:
    symbol: str
    strategy: str
    collector_task: asyncio.Task
    strategy_task:  asyncio.Task
    stop_event:     asyncio.Event = field(default_factory=asyncio.Event)

class WorkerRegistry:
    def __init__(self):
        self._workers: dict[str, WorkerSet] = {}   # symbol → WorkerSet
        self._lock = asyncio.Lock()

    async def add(self, ws: WorkerSet):
        async with self._lock:
            self._workers[ws.symbol] = ws

    async def remove(self, symbol: str) -> Optional[WorkerSet]:
        async with self._lock:
            return self._workers.pop(symbol, None)

    def get(self, symbol: str) -> Optional[WorkerSet]:
        return self._workers.get(symbol)

    def all_symbols(self) -> list[str]:
        return list(self._workers.keys())
```

## Spawning a worker pair

Each symbol gets exactly two tasks: a DataCollector and a StrategyWorker. They share a `stop_event` for coordinated shutdown.

```python
async def spawn_worker(symbol: str, config: dict,
                       redis, registry: WorkerRegistry) -> WorkerSet:
    """
    Called by CommandListener on ADD_SYMBOL command.
    config: {"strategy": "trend", "leverage": 5, "risk_pct": 0.01, ...}
    """
    # Guard: do not spawn if already exists
    if registry.get(symbol):
        raise ValueError(f"Worker for {symbol} already running")

    # Persist config to Redis (survives restart)
    await redis.set(f"config.worker.{symbol}", json.dumps(config))

    stop_event = asyncio.Event()

    collector = asyncio.create_task(
        run_data_collector(symbol, redis, stop_event),
        name=f"collector.{symbol}",
    )
    worker = asyncio.create_task(
        run_strategy_worker(symbol, config, redis, stop_event),
        name=f"strategy.{symbol}",
    )

    # Attach crash handler to both tasks
    for task in (collector, worker):
        task.add_done_callback(
            lambda t, s=symbol: _on_task_done(t, s, registry, redis)
        )

    ws = WorkerSet(symbol=symbol, strategy=config["strategy"],
                   collector_task=collector, strategy_task=worker,
                   stop_event=stop_event)
    await registry.add(ws)
    await redis.sadd("state.bot.workers", symbol)
    return ws
```

## DataCollector pattern

```python
async def run_data_collector(symbol: str, redis, stop_event: asyncio.Event):
    """Subscribes to exchange WebSocket, publishes to Redis Pub/Sub."""
    import ccxt.pro as ccxtpro
    ex = ccxtpro.binance({"options": {"defaultType": "future"}})

    try:
        while not stop_event.is_set():
            try:
                candles = await asyncio.wait_for(
                    ex.watch_ohlcv(symbol, "1h"),
                    timeout=30.0,
                )
                for ts, o, h, l, c, v in candles:
                    closed = (ts + 3_600_000) <= int(time.time() * 1000)
                    if closed:
                        await redis.publish(f"market.{symbol}.candle.1h",
                            json.dumps({"open": o, "high": h, "low": l,
                                        "close": c, "vol": v, "ts": ts,
                                        "closed": True}))
                        await redis.set(f"state.price.{symbol}",
                                        str(c), ex=10)
            except asyncio.TimeoutError:
                continue    # no data in 30s, loop and try again
            except ccxtpro.NetworkError:
                await asyncio.sleep(2)   # reconnect backoff
    finally:
        await ex.close()
```

## StrategyWorker pattern

```python
async def run_strategy_worker(symbol: str, config: dict,
                               redis, stop_event: asyncio.Event):
    """Subscribes to candle pub/sub, publishes signals to stream."""
    r_sub = await aioredis.from_url(REDIS_URL, decode_responses=True)
    async with r_sub.pubsub() as ps:
        await ps.subscribe(f"market.{symbol}.candle.1h",
                           f"market.{symbol}.candle.15m")
        async for msg in ps.listen():
            if stop_event.is_set():
                break
            if msg["type"] != "message":
                continue
            candle = json.loads(msg["data"])
            if not candle.get("closed"):
                continue                         # only act on closed candles

            signal = await evaluate_strategy(symbol, config, redis, candle)
            if signal:
                await redis.xadd("stream.signals", signal, maxlen=100_000)
```

## Graceful stop

```python
async def stop_worker(symbol: str, registry: WorkerRegistry, redis,
                      timeout: float = 10.0):
    """
    Called by CommandListener on REMOVE_SYMBOL or STOP_ALL command.
    Does NOT close open positions — PositionTracker handles that separately.
    """
    ws = await registry.remove(symbol)
    if not ws:
        return

    ws.stop_event.set()   # signal both tasks to exit their loops

    try:
        await asyncio.wait_for(
            asyncio.gather(ws.collector_task, ws.strategy_task,
                           return_exceptions=True),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        ws.collector_task.cancel()
        ws.strategy_task.cancel()

    await redis.srem("state.bot.workers", symbol)
    await redis.delete(f"config.worker.{symbol}")
```

## Crash detection and recovery

```python
def _on_task_done(task: asyncio.Task, symbol: str,
                  registry: WorkerRegistry, redis):
    """Callback attached to every worker task."""
    if task.cancelled():
        return   # intentional stop — do nothing

    exc = task.exception()
    if exc is None:
        return   # clean exit

    # Unhandled exception — log and schedule restart
    logger.error(f"Worker {task.get_name()} crashed: {exc!r}")
    asyncio.get_event_loop().create_task(
        _restart_worker(symbol, registry, redis)
    )

async def _restart_worker(symbol: str, registry: WorkerRegistry,
                           redis, delay: float = 5.0):
    """Restart crashed worker after a short delay."""
    await asyncio.sleep(delay)
    config_raw = await redis.get(f"config.worker.{symbol}")
    if not config_raw:
        logger.warning(f"No config found for {symbol}, skipping restart")
        return
    config = json.loads(config_raw)
    await spawn_worker(symbol, config, redis, registry)
    logger.info(f"Worker {symbol} restarted successfully")
```

## Startup sequence

```python
async def bot_engine_startup(redis):
    """On process start, restore workers that were active before shutdown."""
    await ensure_consumer_groups(redis)   # from redis-topology.md

    # Drain pending stream messages first (crash recovery)
    await drain_pending(redis, "stream.signals",  "risk-manager",    "risk-1",    process_signal)
    await drain_pending(redis, "stream.orders",   "order-executor",  "executor-1", process_order)
    await drain_pending(redis, "stream.fills",    "fill-processors", "tracker-1", process_fill)
    await drain_pending(redis, "stream.commands", "command-listener","cmd-1",     process_command)

    # Restore active workers from Redis
    active = await redis.smembers("state.bot.workers")
    for symbol in active:
        config_raw = await redis.get(f"config.worker.{symbol}")
        if config_raw:
            await spawn_worker(symbol, json.loads(config_raw), redis, registry)

    await redis.set("state.bot.status", "running")
```

## Shutdown sequence

```python
async def bot_engine_shutdown(registry: WorkerRegistry, redis):
    """Graceful shutdown: stop all workers, do NOT close positions."""
    await redis.set("state.bot.status", "paused")   # stop new entries first

    symbols = registry.all_symbols()
    await asyncio.gather(*[
        stop_worker(s, registry, redis) for s in symbols
    ])

    # Note: open positions remain open — they are managed by exchange SL/TP orders
    # Emergency close is a separate explicit command (see control-interface.md)
    await redis.set("state.bot.status", "stopped")
```
