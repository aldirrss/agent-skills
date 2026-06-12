# Main Process

Entry point, signal handling, task orchestration, and graceful shutdown.

## main.py

```python
import asyncio
import signal
import sys
import aiohttp
import redis.asyncio as aioredis
from solana.rpc.async_api import AsyncClient
from loguru import logger

from config import Settings
from logger_setup import setup_logger
from components.strategy.buffer import SignalBuffer
from components.risk_manager import RiskManager
from components.execution import Execution
from components.position_tracker import PositionTracker
from components.db_writer import DBWriter
from components.command_listener import CommandListener
from components.monitor import Monitor
from components.scanner import build_scanner_tasks
from components.strategy import build_strategy_tasks


async def main() -> None:
    settings = Settings()
    setup_logger(settings.log_level)
    logger.bind(component="main").info("Solana bot engine starting")

    # ── Keypair (load once, pass only to Execution) ─────────────────
    from utils.wallet import load_keypair
    keypair = load_keypair()
    pubkey_str = str(keypair.pubkey())
    logger.bind(component="main").info(f"Wallet loaded: {pubkey_str[:8]}...")

    # ── Infrastructure ──────────────────────────────────────────────
    redis = await aioredis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=20,
    )
    await redis.ping()
    logger.bind(component="main").info("Redis connected")

    rpc_primary = AsyncClient(settings.solana_rpc_url)
    rpc_fallback = AsyncClient(settings.solana_rpc_fallback_url)
    health = await rpc_primary.get_health()
    if health.value != "ok":
        raise RuntimeError(f"Solana RPC unhealthy: {health.value}")
    logger.bind(component="main").info("Solana RPC connected")

    session = aiohttp.ClientSession()

    # ── Consumer groups (idempotent) ────────────────────────────────
    await _ensure_consumer_groups(redis)

    # ── Shared objects ──────────────────────────────────────────────
    signal_buffer = SignalBuffer()
    stop_event = asyncio.Event()

    # ── Shared components ────────────────────────────────────────────
    db_writer = DBWriter(settings.database_url)
    position_tracker = PositionTracker(redis, db_writer, rpc_primary)
    execution = Execution(keypair, rpc_primary, rpc_fallback, session, redis,
                          dry_run=settings.dry_run)
    risk_manager = RiskManager(redis, settings)
    command_listener = CommandListener(redis, stop_event)
    monitor = Monitor(redis, settings)

    # ── Register SIGTERM / SIGINT ────────────────────────────────────
    _register_signals(stop_event)

    # ── Crash recovery ───────────────────────────────────────────────
    await position_tracker.reconcile_on_startup(pubkey_str)

    # ── Initial state ────────────────────────────────────────────────
    await redis.set("state.bot.status", "stopped")
    await redis.set("state.wallet.pubkey", pubkey_str)

    # ── Always-on tasks (before START) ──────────────────────────────
    always_on = [
        asyncio.create_task(command_listener.run(), name="command_listener"),
        asyncio.create_task(monitor.run(stop_event), name="monitor"),
    ]

    logger.bind(component="main").info("Waiting for START command...")
    await command_listener.wait_for_start()

    # ── Build scanner tasks ──────────────────────────────────────────
    scanner_tasks = build_scanner_tasks(redis, session, settings, stop_event)

    # ── Build strategy tasks ─────────────────────────────────────────
    strategy_tasks = build_strategy_tasks(
        redis, session, signal_buffer, settings, stop_event
    )

    # ── Core pipeline tasks ──────────────────────────────────────────
    pipeline_tasks = [
        asyncio.create_task(risk_manager.run(stop_event),       name="risk_manager"),
        asyncio.create_task(execution.run(stop_event),          name="execution"),
        asyncio.create_task(position_tracker.run(stop_event),   name="position_tracker"),
        asyncio.create_task(db_writer.run(stop_event),          name="db_writer"),
    ]

    await redis.set("state.bot.status", "running")
    logger.bind(component="main").info("Bot running")

    all_tasks = always_on + scanner_tasks + strategy_tasks + pipeline_tasks

    try:
        done, pending = await asyncio.wait(
            all_tasks, return_when=asyncio.FIRST_EXCEPTION
        )
        for task in done:
            if not task.cancelled() and task.exception():
                logger.bind(component="main").error(
                    f"Critical task failed: {task.get_name()} — {task.exception()}"
                )
    finally:
        await _shutdown(stop_event, all_tasks, redis)
        await session.close()
        await redis.aclose()
        await rpc_primary.close()
        await rpc_fallback.close()
        logger.bind(component="main").info("Bot stopped cleanly")


async def _shutdown(stop_event: asyncio.Event, tasks: list, redis) -> None:
    logger.bind(component="main").info("Shutdown sequence started")
    stop_event.set()
    await redis.set("state.bot.status", "stopped")

    for task in tasks:
        if not task.done():
            task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.bind(component="main").info("All tasks stopped")


def _register_signals(stop_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    def _handler(sig):
        logger.bind(component="main").info(f"Signal {sig.name} received — shutting down")
        stop_event.set()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, _handler, sig)


async def _ensure_consumer_groups(redis) -> None:
    groups = [
        ("stream.signals",          "aggregator-group",   "aggregator-1"),
        ("stream.agent.eligible",   "orchestrator-group", "orchestrator-1"),
        ("stream.agent.approved",   "risk-group",         "risk-manager-1"),
        ("stream.swaps",            "exec-group",         "execution-1"),
        ("stream.fills",            "tracker-group",      "position-tracker-1"),
        ("stream.fills",            "db-group",           "db-writer-1"),
        ("stream.commands",         "cmd-group",          "command-listener-1"),
    ]
    for stream, group, _ in groups:
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

## Task Supervision (per-component restart)

Individual tasks that crash are restarted automatically by a supervisor wrapper:

```python
async def supervise(name: str, coro_fn, *args, restart: bool = True, **kwargs):
    while True:
        try:
            await coro_fn(*args, **kwargs)
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.bind(component=name).error(f"Crashed: {e} — {'restarting in 5s' if restart else 'not restarting'}")
            if not restart:
                break
            await asyncio.sleep(5)
```

Wrap long-running scanner/strategy tasks with `supervise()`:

```python
asyncio.create_task(
    supervise("scanner.gmgn", poll_gmgn_trending, redis, session),
    name="scanner.gmgn"
)
```
