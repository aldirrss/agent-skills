# Health Check & Metrics

## Redis Keys Used for Metrics

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `state.bot.heartbeat` | String (epoch int) | 60s | Monitor | Liveness timestamp, refreshed every 30s |
| `stats.signals.{strategy}` | String (int) | none | Monitor | Total signals evaluated by strategy name |
| `stats.wins.{strategy}` | String (int) | none | Monitor | Profitable closed trades per strategy |
| `stats.losses.{strategy}` | String (int) | none | Monitor | Unprofitable closed trades per strategy |
| `stats.daily_pnl` | String (float) | none | Monitor | Accumulated USDC PnL today, reset at midnight |
| `stats.daily_trades` | String (int) | none | Monitor | Closed trades today, reset at midnight |
| `stats.best_trade` | String (JSON) | none | Monitor | Best single trade today |
| `stats.worst_trade` | String (JSON) | none | Monitor | Worst single trade today |
| `stats.report.{YYYY-MM-DD}` | String (JSON) | 30d | Monitor | Daily report archive |

Strategy name comes from `data["strategy"]` in `position.updates` pub/sub payload. Use the exact strategy slug (e.g. `kol_momentum`, `trending_breakout`) — no spaces, lowercase.

---

## Heartbeat Loop

```python
# components/monitor.py
import asyncio
import time
from loguru import logger


async def _heartbeat_loop(redis, stop_event: asyncio.Event) -> None:
    """
    Write state.bot.heartbeat every 30s with TTL 60s.
    If the process dies, the key expires in 60s and the watchdog detects it.
    """
    log = logger.bind(component="monitor")
    log.info("Heartbeat loop started (interval=30s, TTL=60s)")
    while not stop_event.is_set():
        try:
            ts = int(time.time())
            await redis.set("state.bot.heartbeat", ts, ex=60)
        except Exception as e:
            log.warning(f"Heartbeat write failed: {e}")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=30.0)
        except asyncio.TimeoutError:
            pass  # normal — means 30s elapsed, loop again
```

Spawn as a named task:

```python
asyncio.create_task(_heartbeat_loop(redis, stop_event), name="monitor.heartbeat")
```

---

## External Watchdog (Systemd or Shell Script)

The heartbeat TTL is 60s. A watchdog should poll the key every 45s and restart the process if it has expired.

### Option A — systemd with WatchdogSec

```ini
# /etc/systemd/system/solana-bot.service
[Service]
ExecStart=/usr/bin/python3 /opt/bot/main.py
Restart=always
RestartSec=5
WatchdogSec=60
NotifyAccess=main
```

The bot itself must call `sd_notify(WATCHDOG=1)` every 30s. Use the `sdnotify` Python package:

```python
import sdnotify
_notifier = sdnotify.SystemdNotifier()

async def _heartbeat_loop(redis, stop_event):
    while not stop_event.is_set():
        await redis.set("state.bot.heartbeat", int(time.time()), ex=60)
        _notifier.notify("WATCHDOG=1")   # tell systemd we are alive
        await asyncio.sleep(30)
```

### Option B — Redis-based watchdog script

```bash
#!/usr/bin/env bash
# watchdog.sh — run independently (cron every minute)
HEARTBEAT=$(redis-cli GET state.bot.heartbeat)
NOW=$(date +%s)
if [ -z "$HEARTBEAT" ] || [ $((NOW - HEARTBEAT)) -gt 60 ]; then
    echo "Bot heartbeat expired — restarting"
    systemctl restart solana-bot
fi
```

---

## Scanner Health Check

Each scanner asyncio task must be registered with a predictable name so Monitor can verify it is alive.

### Naming Convention

```python
# scanner/runner.py — when spawning scanner tasks
asyncio.create_task(scanner.run_dexscreener(), name="scanner.dexscreener")
asyncio.create_task(scanner.run_gmgn(),        name="scanner.gmgn")
asyncio.create_task(scanner.run_kol_wallets(), name="scanner.kol_wallets")
asyncio.create_task(scanner.run_pumpfun(),     name="scanner.pumpfun")
```

### Scanner Health Check Loop

```python
# components/monitor.py
import asyncio
from loguru import logger

EXPECTED_SCANNER_TASKS = [
    "scanner.dexscreener",
    "scanner.gmgn",
    "scanner.kol_wallets",
    "scanner.pumpfun",
]

async def _scanner_health_loop(alerter, stop_event: asyncio.Event) -> None:
    """
    Every 2 minutes, verify each expected scanner task is in asyncio.all_tasks().
    Alert if any task is missing (crashed or was never started).
    """
    log = logger.bind(component="monitor")
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=120.0)
        except asyncio.TimeoutError:
            pass

        if stop_event.is_set():
            break

        running_names = {t.get_name() for t in asyncio.all_tasks()}
        for task_name in EXPECTED_SCANNER_TASKS:
            if task_name not in running_names:
                msg = (
                    f"⚠️ <b>Scanner task dead: {task_name}</b>\n"
                    f"Task not found in asyncio task list.\n"
                    f"Bot may be missing signals."
                )
                log.error(f"Scanner task missing: {task_name}")
                alerter.enqueue(msg)
```

Spawn as a named task:

```python
asyncio.create_task(
    _scanner_health_loop(alerter, stop_event),
    name="monitor.scanner_health",
)
```

---

## Per-Strategy Signal Count Tracking

Use Redis `INCR` — it is atomic and safe under concurrent access.

```python
async def record_signal(redis, strategy: str) -> None:
    """Call when Strategy evaluates a signal (regardless of outcome)."""
    await redis.incr(f"stats.signals.{strategy}")
```

Call this in the Strategy component when a signal is published to `stream.signals`, or in Monitor when it observes a signal event.

---

## Per-Strategy Win/Loss Tracking

```python
async def record_trade_outcome(
    redis,
    strategy: str,
    pnl_usdc: float,
    mint: str,
    symbol: str,
) -> None:
    """
    Call after a position is closed. Updates wins/losses and daily PnL.
    Uses INCR and INCRBYFLOAT for atomic updates.
    """
    if pnl_usdc >= 0:
        await redis.incr(f"stats.wins.{strategy}")
    else:
        await redis.incr(f"stats.losses.{strategy}")

    await redis.incrbyfloat("stats.daily_pnl", pnl_usdc)
    await redis.incr("stats.daily_trades")

    # Track best/worst trade
    trade_data = json.dumps({"mint": mint, "symbol": symbol, "pnl_usdc": pnl_usdc})

    current_best_raw = await redis.get("stats.best_trade")
    if current_best_raw:
        current_best = json.loads(current_best_raw)
        if pnl_usdc > current_best["pnl_usdc"]:
            await redis.set("stats.best_trade", trade_data)
    else:
        await redis.set("stats.best_trade", trade_data)

    current_worst_raw = await redis.get("stats.worst_trade")
    if current_worst_raw:
        current_worst = json.loads(current_worst_raw)
        if pnl_usdc < current_worst["pnl_usdc"]:
            await redis.set("stats.worst_trade", trade_data)
    else:
        await redis.set("stats.worst_trade", trade_data)
```

---

## Win Rate Calculation

```python
async def get_win_rate(redis, strategy: Optional[str] = None) -> float:
    """
    Return win rate as a percentage (0.0–100.0).
    If strategy is None, calculate across all strategies.
    """
    if strategy:
        wins   = int(await redis.get(f"stats.wins.{strategy}")   or 0)
        losses = int(await redis.get(f"stats.losses.{strategy}") or 0)
    else:
        # Sum across all known strategies
        win_keys  = await redis.keys("stats.wins.*")
        loss_keys = await redis.keys("stats.losses.*")
        wins   = sum([int(await redis.get(k) or 0) for k in win_keys])
        losses = sum([int(await redis.get(k) or 0) for k in loss_keys])

    total = wins + losses
    if total == 0:
        return 0.0
    return round((wins / total) * 100, 1)
```

---

## Daily PnL Tracking

`stats.daily_pnl` is a float string in Redis. Use `INCRBYFLOAT` to add each trade's PnL atomically.

```python
async def get_daily_pnl(redis) -> float:
    raw = await redis.get("stats.daily_pnl")
    return float(raw) if raw else 0.0
```

Reset at midnight UTC is handled by the `_daily_reset_loop` in Monitor (see `daily-report.md` for the full midnight loop that also generates the daily report before resetting).

---

## Position Age Alert

Alert if any open position is held longer than 75% of `max_hold_time`. Default `max_hold_time` is 3600s (60 min), so the alert fires at 2700s (45 min).

```python
# components/monitor.py
import json
import time
import asyncio
from loguru import logger

POSITION_AGE_WARN_PCT = 0.75   # alert at 75% of max_hold_time

async def _position_age_loop(redis, alerter, stop_event: asyncio.Event) -> None:
    """
    Every 5 minutes: scan all open positions for age exceeding warn threshold.
    """
    log = logger.bind(component="monitor")
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=300.0)
        except asyncio.TimeoutError:
            pass

        if stop_event.is_set():
            break

        try:
            config_raw = await redis.get("config.risk")
            config = json.loads(config_raw) if config_raw else {}
            max_hold_time = int(config.get("max_hold_time", 3600))
            warn_threshold = int(max_hold_time * POSITION_AGE_WARN_PCT)

            pos_keys = await redis.keys("state.position.*")
            now = int(time.time())

            for key in pos_keys:
                raw = await redis.get(key)
                if not raw:
                    continue
                pos = json.loads(raw)
                opened_at = int(pos.get("opened_at", now))
                age_seconds = now - opened_at
                mint   = pos.get("mint", key.replace("state.position.", ""))
                symbol = pos.get("symbol", mint[:8])

                if age_seconds >= warn_threshold:
                    age_min = age_seconds // 60
                    max_min = max_hold_time // 60
                    msg = (
                        f"⚠️ <b>Position Age Warning: {symbol}</b>\n"
                        f"Open for {age_min} min (limit: {max_min} min)\n"
                        f"Mint: <code>{mint[:8]}…</code>"
                    )
                    log.warning(f"Position age warning: {symbol} open {age_min}min")
                    alerter.enqueue(msg)

        except Exception as e:
            log.error(f"Position age check failed: {e}")
```

Spawn as a named task:

```python
asyncio.create_task(
    _position_age_loop(redis, alerter, stop_event),
    name="monitor.position_age",
)
```

The `state.position.{mint}` JSON must include an `opened_at` epoch timestamp. PositionTracker sets this when writing the position on `stream.fills` with `side=BUY`.

---

## Full Monitor.run() Skeleton

```python
# components/monitor.py
import asyncio
import json
import time
from loguru import logger
from .telegram_alerter import TelegramAlerter


class Monitor:
    def __init__(self, redis, settings, alerter: TelegramAlerter):
        self.redis   = redis
        self.settings = settings
        self.alerter = alerter
        self.log     = logger.bind(component="monitor")

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Monitor started")

        # Subscribe to position updates
        pubsub = self.redis.pubsub()
        await pubsub.subscribe("position.updates")

        # Spawn internal loops as named tasks
        tasks = [
            asyncio.create_task(
                _heartbeat_loop(self.redis, stop_event),
                name="monitor.heartbeat",
            ),
            asyncio.create_task(
                _scanner_health_loop(self.alerter, stop_event),
                name="monitor.scanner_health",
            ),
            asyncio.create_task(
                _position_age_loop(self.redis, self.alerter, stop_event),
                name="monitor.position_age",
            ),
        ]

        try:
            async for message in pubsub.listen():
                if stop_event.is_set():
                    break
                if message["type"] != "message":
                    continue
                await self._handle_position_update(message["data"])
        finally:
            await pubsub.unsubscribe()
            for t in tasks:
                t.cancel()
            self.log.info("Monitor stopped")
```
