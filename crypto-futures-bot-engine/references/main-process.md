# Main Process

Entry point, signal handling, task orchestration, and graceful shutdown.

## Table of contents
- Directory layout
- main.py entry point
- Signal handling (SIGTERM / SIGINT)
- Task orchestration
- Graceful shutdown

---

## Directory layout

```
bot_engine/
├── main.py                  ← entry point
├── config.py                ← Pydantic Settings
├── logger_setup.py          ← Loguru setup
├── health.py                ← heartbeat
├── registry.py              ← WorkerRegistry
├── components/
│   ├── data_collector.py
│   ├── strategy_worker.py
│   ├── risk_manager.py
│   ├── order_executor.py
│   ├── position_tracker.py
│   ├── db_writer.py
│   ├── command_listener.py
│   └── llm_signal_agent.py
├── db/                      ← SQLModel models + engine (from db-schema skill)
└── .env
```

---

## main.py entry point

```python
# main.py
import asyncio
import signal
import sys

import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from loguru import logger

from config import settings
from logger_setup import setup_logger, component_logger
from registry import WorkerRegistry
from health import run_health_heartbeat

from components.command_listener  import CommandListener
from components.risk_manager      import RiskManager
from components.order_executor    import OrderExecutor
from components.position_tracker  import PositionTracker
from components.db_writer         import DBWriter
from components.llm_signal_agent  import LLMSignalAgent
from components.data_collector    import run_data_collector
from components.strategy_worker   import run_strategy_worker


log = component_logger("main")


async def main() -> None:
    setup_logger()
    log.info("Bot engine starting", version="1.0.0")

    # ── Infrastructure ──────────────────────────────────────────────
    redis = await aioredis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=30,
    )
    await redis.ping()
    log.info("Redis connected")

    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession,
                                     expire_on_commit=False)
    async with engine.connect() as conn:
        await conn.execute("SELECT 1")
    log.info("PostgreSQL connected")

    # ── Consumer groups (idempotent) ────────────────────────────────
    await _ensure_consumer_groups(redis)

    # ── Shared state ────────────────────────────────────────────────
    registry    = WorkerRegistry()
    stop_event  = asyncio.Event()   # global: set to trigger graceful shutdown

    # ── Shared components ────────────────────────────────────────────
    db_writer        = DBWriter(AsyncSessionLocal)
    position_tracker = PositionTracker(redis, db_writer)
    order_executor   = OrderExecutor(redis, AsyncSessionLocal, settings)
    risk_manager     = RiskManager(redis, AsyncSessionLocal, settings)
    position_manager = PositionManager(redis, registry, order_executor)
    liq_collector    = LiquidationCollector(redis, registry)
    llm_agent        = LLMSignalAgent(redis, registry, settings.llm_providers(),
                                      settings.llm_refresh_interval_s)
    cmd_listener     = CommandListener(redis, registry, order_executor,
                                       position_tracker, settings)

    # ── Register SIGTERM/SIGINT ──────────────────────────────────────
    _register_signals(stop_event)

    # ── Crash recovery: drain pending stream messages ────────────────
    log.info("Draining pending stream messages")
    await position_tracker.drain_pending()
    await db_writer.drain_pending()

    # ── Restore workers that were active before last shutdown ────────
    await _restore_workers(redis, registry, stop_event)

    # ── Mark as running ──────────────────────────────────────────────
    await redis.set("state.bot.status", "running")
    log.info("Bot engine running")

    # ── Launch all tasks ─────────────────────────────────────────────
    tasks = [
        asyncio.create_task(risk_manager.run(stop_event),       name="risk_manager"),
        asyncio.create_task(order_executor.run(stop_event),     name="order_executor"),
        asyncio.create_task(position_tracker.run(stop_event),   name="position_tracker"),
        asyncio.create_task(position_manager.run(stop_event),   name="position_manager"),
        asyncio.create_task(liq_collector.run(stop_event),      name="liquidation_collector"),
        asyncio.create_task(db_writer.run(stop_event),          name="db_writer"),
        asyncio.create_task(cmd_listener.run(stop_event),       name="command_listener"),
        asyncio.create_task(llm_agent.run(stop_event),          name="llm_agent"),
        asyncio.create_task(
            run_health_heartbeat(redis, registry, stop_event),  name="health_heartbeat"
        ),
        asyncio.create_task(
            _wait_for_shutdown(stop_event),                      name="shutdown_watcher"
        ),
    ]

    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        for task in done:
            if task.exception():
                log.error("Critical task failed", task=task.get_name(),
                          error=str(task.exception()))
    finally:
        await _shutdown(stop_event, registry, redis, tasks)
        await redis.aclose()
        await engine.dispose()
        log.info("Bot engine stopped cleanly")


async def _wait_for_shutdown(stop_event: asyncio.Event) -> None:
    """Keeps main alive until stop_event is set."""
    await stop_event.wait()


def _register_signals(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()

    def _handler(sig):
        log.info("Signal received, initiating graceful shutdown", signal=sig.name)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handler, sig)


async def _restore_workers(redis, registry, stop_event) -> None:
    """Re-spawn workers that were active before the last shutdown."""
    active = await redis.smembers("state.bot.workers")
    if not active:
        log.info("No previous workers to restore")
        return
    log.info("Restoring workers", count=len(active), symbols=list(active))
    for symbol in active:
        config_raw = await redis.get(f"config.worker.{symbol}")
        if config_raw:
            import json
            from registry import spawn_worker
            await spawn_worker(symbol, json.loads(config_raw), redis, registry, stop_event)


async def _shutdown(stop_event: asyncio.Event, registry, redis, tasks: list) -> None:
    log.info("Shutdown sequence started")
    stop_event.set()
    await redis.set("state.bot.status", "paused")

    # Cancel all remaining tasks gracefully
    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    log.info("All tasks stopped")


async def _ensure_consumer_groups(redis) -> None:
    groups = [
        ("stream.signals",  "risk-manager"),
        ("stream.orders",   "order-executor"),
        ("stream.fills",    "fill-processors"),
        ("stream.commands", "command-listener"),
    ]
    for stream, group in groups:
        try:
            await redis.xgroup_create(stream, group, id="0", mkstream=True)
        except Exception as e:
            if "BUSYGROUP" not in str(e):
                raise


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    sys.exit(0)
```

---

## Task orchestration rules

```python
# registry.py — spawn helper used by CommandListener and _restore_workers
import asyncio
import json
from dataclasses import dataclass, field
from typing import Optional
from logger_setup import component_logger

log = component_logger("registry")


@dataclass
class WorkerSet:
    symbol:         str
    strategy:       str
    collector_task: asyncio.Task
    strategy_task:  asyncio.Task
    stop_event:     asyncio.Event = field(default_factory=asyncio.Event)


class WorkerRegistry:
    def __init__(self):
        self._workers: dict[str, WorkerSet] = {}
        self._lock = asyncio.Lock()

    async def add(self, ws: WorkerSet) -> None:
        async with self._lock:
            self._workers[ws.symbol] = ws

    async def remove(self, symbol: str) -> Optional[WorkerSet]:
        async with self._lock:
            return self._workers.pop(symbol, None)

    def get(self, symbol: str) -> Optional[WorkerSet]:
        return self._workers.get(symbol)

    def all_symbols(self) -> list[str]:
        return list(self._workers.keys())


async def spawn_worker(symbol: str, config: dict, redis,
                        registry: WorkerRegistry,
                        global_stop: asyncio.Event) -> WorkerSet:
    from components.data_collector  import run_data_collector
    from components.strategy_worker import run_strategy_worker

    if registry.get(symbol):
        raise ValueError(f"Worker {symbol} already running")

    await redis.set(f"config.worker.{symbol}", json.dumps(config))

    worker_stop = asyncio.Event()

    collector = asyncio.create_task(
        run_data_collector(symbol, redis, worker_stop),
        name=f"collector.{symbol}",
    )
    worker = asyncio.create_task(
        run_strategy_worker(symbol, config, redis, worker_stop),
        name=f"strategy.{symbol}",
    )

    ws = WorkerSet(symbol=symbol, strategy=config["strategy"],
                   collector_task=collector, strategy_task=worker,
                   stop_event=worker_stop)

    for task in (collector, worker):
        task.add_done_callback(
            lambda t, s=symbol: _on_task_done(t, s, registry, redis, global_stop)
        )

    await registry.add(ws)
    await redis.sadd("state.bot.workers", symbol)
    log.info("Worker spawned", symbol=symbol, strategy=config["strategy"])
    return ws


def _on_task_done(task: asyncio.Task, symbol: str,
                  registry: WorkerRegistry, redis, global_stop: asyncio.Event) -> None:
    if task.cancelled() or global_stop.is_set():
        return
    exc = task.exception()
    if exc:
        log.error("Worker task crashed, scheduling restart",
                  task=task.get_name(), error=str(exc))
        asyncio.get_running_loop().create_task(
            _restart_worker(symbol, registry, redis, global_stop)
        )


async def _restart_worker(symbol: str, registry: WorkerRegistry,
                           redis, global_stop: asyncio.Event,
                           delay: float = 5.0) -> None:
    await asyncio.sleep(delay)
    if global_stop.is_set():
        return
    config_raw = await redis.get(f"config.worker.{symbol}")
    if not config_raw:
        log.warning("No config for crashed worker, skipping restart", symbol=symbol)
        return
    import json
    await spawn_worker(symbol, json.loads(config_raw), redis, registry, global_stop)
```
