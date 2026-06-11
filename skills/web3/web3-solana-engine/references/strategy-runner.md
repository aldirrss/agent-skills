# Strategy Runner

How to wire all strategy tasks with shared SignalBuffer.

## build_strategy_tasks()

```python
# components/strategy/__init__.py
import asyncio
import aiohttp
from loguru import logger

from .buffer import SignalBuffer
from .kol_copy import kol_copy_trade_task
from .new_launch import new_launch_snipe_task
from .graduation import graduation_trade_task
from .momentum import momentum_spike_task
from .smart_money import smart_money_confluence_task
from .social_alpha import social_alpha_task
from .position_monitor import position_monitor_loop


STRATEGY_MAP = {
    "kol_copy_trade":        kol_copy_trade_task,
    "new_launch_snipe":      new_launch_snipe_task,
    "graduation_trade":      graduation_trade_task,
    "momentum_spike":        momentum_spike_task,
    "smart_money_confluence": smart_money_confluence_task,
    "social_alpha":          social_alpha_task,
}


def build_strategy_tasks(
    redis,
    session: aiohttp.ClientSession,
    signal_buffer: SignalBuffer,
    settings,
    stop_event: asyncio.Event,
) -> list[asyncio.Task]:
    import json

    tasks = []

    # position monitor always runs regardless of enabled strategies
    tasks.append(asyncio.create_task(
        _run_strategy("position_monitor", position_monitor_loop, redis, stop_event),
        name="strategy.position_monitor",
    ))

    for name, fn in STRATEGY_MAP.items():
        if name not in settings.enabled_strategies:
            logger.bind(component="strategy").debug(f"Strategy disabled: {name}")
            continue

        tasks.append(asyncio.create_task(
            _run_strategy(name, fn, redis, session, signal_buffer),
            name=f"strategy.{name}",
        ))
        logger.bind(component="strategy").info(f"Strategy enabled: {name}")

    logger.bind(component="strategy").info(
        f"Started {len(tasks)} strategy tasks "
        f"({len(tasks)-1} strategies + position monitor)"
    )
    return tasks


async def _run_strategy(name: str, fn, *args):
    log = logger.bind(component=f"strategy.{name}")
    while True:
        try:
            await fn(*args)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.error(f"Strategy crashed: {e} — restarting in 5s")
            await asyncio.sleep(5)
```

## Strategy Task Pattern

Every strategy task follows the same pattern — subscribe to pub/sub, process messages, evaluate confluence:

```python
# components/strategy/kol_copy.py (example pattern)
async def kol_copy_trade_task(redis, session, buffer: SignalBuffer):
    log = logger.bind(component="strategy.kol_copy")
    pubsub = redis.pubsub()
    await pubsub.subscribe(
        "scanner.wallet.buy",
        "scanner.token.trending",
        "scanner.token.new",
    )
    log.info("Listening for signals")

    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue

            status = await redis.get("state.bot.status")
            if status != "running":
                continue   # paused or stopped — don't evaluate

            await _process_message(message, redis, session, buffer, log)

    finally:
        await pubsub.unsubscribe()
        await pubsub.aclose()
```

## SignalBuffer Isolation

Each strategy reads from the **shared** SignalBuffer but uses its own `strategy_name` key in deduplication — they don't interfere:

```python
# Strategy A publishes: strategy.cooldown.kol_copy_trade.{mint}
# Strategy B publishes: strategy.cooldown.graduation_trade.{mint}
# Both can be active simultaneously for the same mint
```

The only shared state in SignalBuffer is the signal accumulation per mint — intentional, so enrichment signals from one channel benefit all strategies simultaneously.

## Hot-Reload Enabled Strategies

CommandListener can toggle strategies at runtime:

```python
# stream.commands:
{"cmd": "UPDATE_CONFIG", "payload": {"key": "config.strategy", "value": {...}}}
```

Strategy tasks check `config.strategy.enabled_strategies` from Redis on each evaluation cycle:

```python
async def _is_strategy_enabled(redis, name: str) -> bool:
    raw = await redis.get("config.strategy")
    if not raw:
        return True
    config = json.loads(raw)
    return name in config.get("enabled_strategies", [])
```

Add this check at the top of each strategy's message handler — if disabled mid-run, it stops emitting signals without restarting the task.
