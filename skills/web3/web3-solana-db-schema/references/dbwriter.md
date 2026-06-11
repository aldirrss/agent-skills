# DBWriter Integration

DBWriter is a single asyncio task inside the bot engine process. It owns all writes to PostgreSQL and runs the nightly maintenance jobs. No other component writes to the database directly.

---

## Responsibilities

| Task | Trigger |
|---|---|
| Insert BUY fill | `stream.fills` XREAD message with `side=BUY` |
| Insert SELL fill + calculate PnL | `stream.fills` XREAD message with `side=SELL` |
| Insert failed/timeout fills | same stream, `status=failed\|timeout` |
| Insert signal rejections | `scanner.safety.rejected` pub/sub message |
| Upsert KOL wallet stats | `scanner.kol.discovered` pub/sub message |
| Rebuild strategy_stats | midnight UTC (asyncio sleep loop) |
| Write daily report | midnight UTC, after strategy_stats rebuild |

---

## Connection Pool Setup

```python
# db/pool.py
import asyncpg
from loguru import logger


async def create_pool(dsn: str) -> asyncpg.Pool:
    """
    Create asyncpg connection pool.
    min_size=1  — keep one connection warm at all times.
    max_size=5  — bot is single-process; 5 is plenty. Raise only after benchmarking.
    """
    pool = await asyncpg.create_pool(
        dsn=dsn,
        min_size=1,
        max_size=5,
        command_timeout=10,       # fail slow queries fast
        server_settings={
            "application_name": "solana_bot",
        },
    )
    # smoke test
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    logger.info("PostgreSQL pool ready")
    return pool
```

---

## DBWriter Task

```python
# components/db_writer.py
import asyncio
import asyncpg
import redis.asyncio as aioredis
import json
from datetime import datetime, timezone, date, timedelta
from loguru import logger

from db.queries import (
    insert_trade_buy,
    update_trade_sell,
    get_latest_buy_fill,
    insert_signal_rejection,
    upsert_kol_wallet,
    rebuild_strategy_stats,
    upsert_daily_report,
    get_daily_pnl,
    get_strategy_win_rates,
)

log = logger.bind(component="db_writer")

FILLS_STREAM   = "stream.fills"
FILLS_GROUP    = "db_writer_group"
FILLS_CONSUMER = "db_writer_1"

REJECT_CHANNEL = "scanner.safety.rejected"
KOL_CHANNEL    = "scanner.kol.discovered"


async def db_writer_task(
    pool: asyncpg.Pool,
    redis: aioredis.Redis,
    stop_event: asyncio.Event,
) -> None:
    """
    Main DBWriter coroutine. Runs until stop_event is set.
    Spawns three sub-tasks:
      1. fill_consumer     — reads stream.fills, writes trades
      2. pubsub_consumer   — reads Redis pub/sub, writes rejections + kol wallets
      3. nightly_scheduler — runs at midnight UTC
    """
    log.info("DBWriter starting")

    await _ensure_consumer_group(redis)

    async with asyncio.TaskGroup() as tg:
        tg.create_task(_fill_consumer(pool, redis, stop_event),  name="dbwriter.fills")
        tg.create_task(_pubsub_consumer(pool, redis, stop_event), name="dbwriter.pubsub")
        tg.create_task(_nightly_scheduler(pool, stop_event),     name="dbwriter.nightly")

    log.info("DBWriter stopped")


async def _ensure_consumer_group(redis: aioredis.Redis) -> None:
    try:
        await redis.xgroup_create(FILLS_STREAM, FILLS_GROUP, id="0", mkstream=True)
        log.debug("Consumer group created: {}", FILLS_GROUP)
    except Exception as e:
        if "BUSYGROUP" in str(e):
            log.debug("Consumer group already exists: {}", FILLS_GROUP)
        else:
            raise
```

---

## Reading stream.fills and Writing Trades

```python
async def _fill_consumer(
    pool: asyncpg.Pool,
    redis: aioredis.Redis,
    stop_event: asyncio.Event,
) -> None:
    """
    Reads fill events from stream.fills via XREADGROUP.
    Each fill is either a BUY (insert new row) or SELL (insert SELL row + calculate PnL).
    Failed/timeout fills are also inserted — status column captures the outcome.
    """
    log.info("Fill consumer started, stream={}", FILLS_STREAM)

    # Drain pending (unacknowledged) messages first — crash recovery
    await _drain_pending_fills(pool, redis)

    while not stop_event.is_set():
        try:
            results = await redis.xreadgroup(
                groupname=FILLS_GROUP,
                consumername=FILLS_CONSUMER,
                streams={FILLS_STREAM: ">"},
                count=10,
                block=1000,   # ms — yields to event loop if no messages
            )
            if not results:
                continue

            for _stream, messages in results:
                for msg_id, data in messages:
                    await _handle_fill(pool, data)
                    await redis.xack(FILLS_STREAM, FILLS_GROUP, msg_id)

        except asyncio.CancelledError:
            break
        except Exception:
            log.exception("Fill consumer error — retrying in 2s")
            await asyncio.sleep(2)


async def _handle_fill(pool: asyncpg.Pool, data: dict) -> None:
    """
    Route fill to insert_trade_buy or update_trade_sell based on side.
    All statuses (confirmed, failed, timeout, dry_run) are written.
    """
    fill = {k: v.decode() if isinstance(v, bytes) else v for k, v in data.items()}

    side = fill.get("side", "").upper()
    log.debug("Handle fill side={} mint={} status={}", side, fill.get("mint"), fill.get("status"))

    try:
        if side == "BUY":
            await insert_trade_buy(pool, fill)

        elif side == "SELL":
            buy_fill = await get_latest_buy_fill(pool, fill["mint"])
            if buy_fill:
                await update_trade_sell(pool, fill["mint"], fill, buy_fill)
            else:
                # No matching BUY found — insert SELL without PnL (data integrity)
                log.warning("No BUY found for SELL mint={} — inserting without PnL", fill["mint"])
                await insert_trade_buy(pool, {**fill, "side": "SELL"})   # reuse insert, side override

        else:
            log.warning("Unknown fill side={} fill_id={}", side, fill.get("fill_id"))

    except Exception:
        log.exception("Failed to write fill fill_id={}", fill.get("fill_id"))


async def _drain_pending_fills(pool: asyncpg.Pool, redis: aioredis.Redis) -> None:
    """
    On startup: read all PENDING messages (unacknowledged from previous run) and process them.
    ON CONFLICT (fill_id) DO NOTHING prevents double-inserts.
    """
    log.info("Draining pending fills...")
    count = 0
    while True:
        results = await redis.xreadgroup(
            groupname=FILLS_GROUP,
            consumername=FILLS_CONSUMER,
            streams={FILLS_STREAM: "0"},   # "0" = pending messages
            count=50,
        )
        if not results or not results[0][1]:
            break
        for _stream, messages in results:
            for msg_id, data in messages:
                await _handle_fill(pool, data)
                await redis.xack(FILLS_STREAM, FILLS_GROUP, msg_id)
                count += 1
    log.info("Drained {} pending fills", count)
```

---

## Reading Redis Pub/Sub for Rejections and KOL Wallets

```python
async def _pubsub_consumer(
    pool: asyncpg.Pool,
    redis: aioredis.Redis,
    stop_event: asyncio.Event,
) -> None:
    """
    Subscribes to:
      scanner.safety.rejected  — published by Strategy/RiskManager when a signal is rejected
      scanner.kol.discovered   — published by KOL Scanner when a new wallet or trade is detected

    Message format (JSON string):
      rejected:   {"mint": "...", "symbol": "...", "strategy": "...", "reason": "...",
                   "sources": [...], "confidence": 0.72, "liquidity_usdc": 5000.0}
      discovered: {"address": "...", "label": "...", "source": "cielo",
                   "win_rate": 0.65, "total_trades": 120, ...}
    """
    pubsub = redis.pubsub()
    await pubsub.subscribe(REJECT_CHANNEL, KOL_CHANNEL)
    log.info("Subscribed to {} and {}", REJECT_CHANNEL, KOL_CHANNEL)

    try:
        while not stop_event.is_set():
            message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
            if message is None:
                await asyncio.sleep(0.05)
                continue

            channel = message["channel"]
            if isinstance(channel, bytes):
                channel = channel.decode()

            try:
                payload = json.loads(message["data"])
            except (json.JSONDecodeError, TypeError):
                log.warning("Non-JSON pubsub message on {}", channel)
                continue

            if channel == REJECT_CHANNEL:
                await insert_signal_rejection(pool, payload)
                log.debug("Rejection logged reason={} mint={}", payload.get("reason"), payload.get("mint"))

            elif channel == KOL_CHANNEL:
                await upsert_kol_wallet(pool, payload)
                log.debug("KOL wallet upserted address={}", payload.get("address"))

    except asyncio.CancelledError:
        pass
    finally:
        await pubsub.unsubscribe(REJECT_CHANNEL, KOL_CHANNEL)
        await pubsub.close()
```

---

## How Strategy Publishes Rejections

In `components/risk_manager.py` (or strategy file), publish to `scanner.safety.rejected` before returning without swapping:

```python
# In RiskManager._reject_signal()
async def _reject_signal(
    self,
    redis: aioredis.Redis,
    signal: dict,
    reason: str,
) -> None:
    """Publish rejection event to Redis pub/sub for DBWriter to persist."""
    event = {
        "mint":          signal["mint"],
        "symbol":        signal.get("symbol"),
        "strategy":      signal.get("strategy"),
        "reason":        reason,
        "sources":       signal.get("sources", []),
        "confidence":    signal.get("confidence"),
        "liquidity_usdc": signal.get("liquidity_usdc"),
    }
    await redis.publish("scanner.safety.rejected", json.dumps(event))
```

---

## Nightly Scheduler (midnight UTC)

```python
async def _nightly_scheduler(
    pool: asyncpg.Pool,
    stop_event: asyncio.Event,
) -> None:
    """
    Runs maintenance jobs once per day at midnight UTC:
      1. Rebuild strategy_stats from trades table
      2. Build and write daily_reports row for yesterday

    Uses sleep-until-next-midnight pattern — no cron dependency.
    """
    log.info("Nightly scheduler started")

    while not stop_event.is_set():
        now_utc = datetime.now(timezone.utc)
        next_midnight = (now_utc + timedelta(days=1)).replace(
            hour=0, minute=0, second=5, microsecond=0
        )
        sleep_secs = (next_midnight - now_utc).total_seconds()
        log.debug("Nightly scheduler sleeping {:.0f}s until midnight UTC", sleep_secs)

        try:
            await asyncio.wait_for(
                _wait_for_stop(stop_event),
                timeout=sleep_secs,
            )
            break   # stop_event was set — exit
        except asyncio.TimeoutError:
            pass    # normal: midnight reached

        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).date()

        log.info("Running nightly maintenance for {}", yesterday)
        try:
            await _run_nightly_jobs(pool, yesterday)
        except Exception:
            log.exception("Nightly maintenance failed for {}", yesterday)


async def _wait_for_stop(stop_event: asyncio.Event) -> None:
    await stop_event.wait()


async def _run_nightly_jobs(pool: asyncpg.Pool, report_date: date) -> None:
    # 1. Rebuild strategy_stats
    log.info("Rebuilding strategy_stats...")
    await rebuild_strategy_stats(pool)
    log.info("strategy_stats rebuilt")

    # 2. Build daily report for yesterday
    date_str = report_date.isoformat()
    summary  = await get_daily_pnl(pool, date_str)
    by_strat = await get_strategy_win_rates(pool)

    report = {
        "report_date":     report_date,
        "total_trades":    summary.get("total_trades", 0) or 0,
        "win_rate":        summary.get("win_rate"),
        "total_pnl_usdc":  str(summary.get("total_pnl_usdc") or 0),
        "best_trade_usdc": str(summary.get("best_trade_usdc") or 0),
        "worst_trade_usdc": str(summary.get("worst_trade_usdc") or 0),
        "strategies_used": [r["strategy"] for r in by_strat if r.get("strategy")],
        "report_json": {
            "date":         date_str,
            "total_trades": summary.get("total_trades", 0) or 0,
            "win_rate":     float(summary["win_rate"]) if summary.get("win_rate") else None,
            "total_pnl_usdc": float(summary.get("total_pnl_usdc") or 0),
            "by_strategy": [
                {
                    "strategy":  r["strategy"],
                    "trades":    r["total"],
                    "win_rate":  float(r["win_rate"]) if r.get("win_rate") else None,
                    "pnl_usdc":  float(r["avg_pnl"]) if r.get("avg_pnl") else None,
                }
                for r in by_strat
            ],
        },
    }

    await upsert_daily_report(pool, report)
    log.info("Daily report written for {}", date_str)
```

---

## Wiring DBWriter in main.py

```python
# In main.py, after all pools are created:

dbwriter_task = asyncio.create_task(
    db_writer_task(pg_pool, redis_client, stop_event),
    name="db_writer",
)
```

DBWriter is started alongside all other component tasks. It does not need to wait for Strategy or Execution — it simply processes what arrives on `stream.fills` and the pub/sub channels.

On shutdown, DBWriter is cancelled **after** Execution finishes its in-flight swap (so the final fill is guaranteed to land on `stream.fills` before DBWriter stops reading).

---

## Error Handling Rules

| Failure scenario | Behavior |
|---|---|
| DB insert fails (duplicate fill_id) | `ON CONFLICT DO NOTHING` — silently skipped, log at DEBUG |
| DB insert fails (other error) | Log at ERROR, XACK the message anyway (don't block the stream) |
| `get_latest_buy_fill` returns None on SELL | Log WARNING, insert SELL row without PnL |
| Pub/sub message not valid JSON | Log WARNING, skip |
| `rebuild_strategy_stats` fails | Log EXCEPTION, continue — stats are stale but trades are intact |
| Pool connection timeout | asyncpg raises `asyncpg.TooManyConnectionsError` — log ERROR, retry after 5s |
