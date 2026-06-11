# Daily Report

## Overview

The daily report is generated once per day at midnight UTC. It summarizes the last 24 hours of trading performance, saves the result to Redis, and sends it to Telegram. It also resets the daily counters so the next day starts clean.

A manual report can be triggered at any time by sending `cmd=DAILY_REPORT` to `stream.commands`.

---

## Midnight UTC Loop

```python
# components/monitor.py
import asyncio
import time
from loguru import logger


async def _midnight_loop(redis, db_pool, alerter, stop_event: asyncio.Event) -> None:
    """
    Fires once per day at midnight UTC:
      1. Generate daily report (reads PostgreSQL + Redis)
      2. Send report to Telegram
      3. Save report to Redis with 30-day TTL
      4. Reset daily counters in Redis
    """
    log = logger.bind(component="monitor")

    while not stop_event.is_set():
        # Calculate seconds until next midnight UTC
        now_struct = time.gmtime()
        seconds_elapsed_today = (
            now_struct.tm_hour * 3600
            + now_struct.tm_min * 60
            + now_struct.tm_sec
        )
        seconds_to_midnight = 86400 - seconds_elapsed_today

        log.info(f"Next daily report in {seconds_to_midnight // 3600}h "
                 f"{(seconds_to_midnight % 3600) // 60}m")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=float(seconds_to_midnight))
        except asyncio.TimeoutError:
            pass   # midnight reached

        if stop_event.is_set():
            break

        log.info("Generating daily report (midnight UTC)")
        try:
            report = await generate_daily_report(redis, db_pool)
            msg    = format_daily_report_message(report)
            alerter.enqueue(msg)
            await save_report_to_redis(redis, report)
            await reset_daily_counters(redis)
            log.info("Daily report sent and counters reset")
        except Exception as e:
            log.error(f"Daily report failed: {e}")
```

Spawn in Monitor.run():

```python
asyncio.create_task(
    _midnight_loop(redis, db_pool, alerter, stop_event),
    name="monitor.midnight",
)
```

---

## Data Collection

### PostgreSQL Query (last 24 hours)

```python
# components/monitor.py
import asyncpg
import json
from datetime import datetime, timezone, timedelta
from typing import Any


async def collect_pg_stats(db_pool: asyncpg.Pool) -> dict[str, Any]:
    """
    Query the trades table for the last 24 hours.
    Returns raw aggregate stats.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    query = """
        SELECT
            COUNT(*)                            AS total_trades,
            SUM(CASE WHEN pnl_usdc >= 0 THEN 1 ELSE 0 END)  AS wins,
            SUM(CASE WHEN pnl_usdc < 0  THEN 1 ELSE 0 END)  AS losses,
            COALESCE(SUM(pnl_usdc), 0)          AS total_pnl,
            COALESCE(MAX(pnl_usdc), 0)          AS best_pnl,
            COALESCE(MIN(pnl_usdc), 0)          AS worst_pnl,
            strategy
        FROM trades
        WHERE closed_at >= $1 AND status = 'closed'
        GROUP BY strategy
        ORDER BY strategy
    """

    rows = await db_pool.fetch(query, cutoff)

    total_trades = 0
    total_wins   = 0
    total_losses = 0
    total_pnl    = 0.0
    best_pnl     = None
    worst_pnl    = None
    strategies: list[dict] = []

    for row in rows:
        total_trades += row["total_trades"]
        total_wins   += row["wins"]
        total_losses += row["losses"]
        total_pnl    += float(row["total_pnl"])
        row_best  = float(row["best_pnl"])
        row_worst = float(row["worst_pnl"])
        if best_pnl is None or row_best > best_pnl:
            best_pnl = row_best
        if worst_pnl is None or row_worst < worst_pnl:
            worst_pnl = row_worst
        strategies.append({
            "name":   row["strategy"],
            "trades": row["total_trades"],
            "wins":   row["wins"],
            "losses": row["losses"],
            "pnl":    float(row["total_pnl"]),
        })

    return {
        "total_trades": total_trades,
        "wins":         total_wins,
        "losses":       total_losses,
        "total_pnl":    total_pnl,
        "best_pnl":     best_pnl or 0.0,
        "worst_pnl":    worst_pnl or 0.0,
        "strategies":   strategies,
    }
```

### Per-Strategy Win Rate from PostgreSQL (best trade / worst trade with symbol)

```python
async def collect_best_worst_trades(db_pool: asyncpg.Pool) -> tuple[dict, dict]:
    """Return the best and worst trades of the day (with symbol)."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)

    best_row = await db_pool.fetchrow(
        "SELECT symbol, pnl_usdc FROM trades "
        "WHERE closed_at >= $1 AND status = 'closed' "
        "ORDER BY pnl_usdc DESC LIMIT 1",
        cutoff,
    )
    worst_row = await db_pool.fetchrow(
        "SELECT symbol, pnl_usdc FROM trades "
        "WHERE closed_at >= $1 AND status = 'closed' "
        "ORDER BY pnl_usdc ASC LIMIT 1",
        cutoff,
    )

    best  = {"symbol": best_row["symbol"],  "pnl": float(best_row["pnl_usdc"])}  if best_row  else {"symbol": "—", "pnl": 0.0}
    worst = {"symbol": worst_row["symbol"], "pnl": float(worst_row["pnl_usdc"])} if worst_row else {"symbol": "—", "pnl": 0.0}
    return best, worst
```

---

## Report Assembly

```python
async def generate_daily_report(redis, db_pool: asyncpg.Pool) -> dict[str, Any]:
    """
    Combine PostgreSQL and Redis stats into a single report dict.
    PostgreSQL is authoritative for trade-level data.
    Redis is used for strategy signal counts (not stored in DB).
    """
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    # PostgreSQL aggregates
    pg_stats         = await collect_pg_stats(db_pool)
    best_trade, worst_trade = await collect_best_worst_trades(db_pool)

    # Per-strategy signal counts from Redis
    win_keys  = await redis.keys("stats.wins.*")
    loss_keys = await redis.keys("stats.losses.*")

    signal_counts: dict[str, int] = {}
    for key in await redis.keys("stats.signals.*"):
        strategy = key.replace("stats.signals.", "")
        signal_counts[strategy] = int(await redis.get(key) or 0)

    # Win rate
    total = pg_stats["wins"] + pg_stats["losses"]
    win_rate = round((pg_stats["wins"] / total) * 100, 1) if total > 0 else 0.0

    # Active strategies (those with at least 1 trade today)
    active_strategies = [s["name"] for s in pg_stats["strategies"] if s["trades"] > 0]

    report = {
        "date":              date_str,
        "total_trades":      pg_stats["total_trades"],
        "wins":              pg_stats["wins"],
        "losses":            pg_stats["losses"],
        "win_rate":          win_rate,
        "total_pnl":         pg_stats["total_pnl"],
        "best_trade":        best_trade,
        "worst_trade":       worst_trade,
        "strategies":        pg_stats["strategies"],
        "signal_counts":     signal_counts,
        "active_strategies": active_strategies,
        "generated_at":      int(time.time()),
    }
    return report
```

---

## Telegram Formatting

```python
def format_daily_report_message(report: dict[str, Any]) -> str:
    date        = report["date"]
    total       = report["total_trades"]
    wins        = report["wins"]
    losses      = report["losses"]
    win_rate    = report["win_rate"]
    total_pnl   = report["total_pnl"]
    best        = report["best_trade"]
    worst       = report["worst_trade"]
    strategies  = report["strategies"]

    pnl_emoji = "🟢" if total_pnl >= 0 else "🔴"

    lines = [
        f"📊 <b>Daily Report — {date}</b>",
        "",
        f"Trades:   {total}  ({wins}W / {losses}L)",
        f"Win Rate: <code>{win_rate:.1f}%</code>",
        f"Total PnL: {pnl_emoji} <code>{total_pnl:+.2f} USDC</code>",
        "",
        f"Best:  <b>{best['symbol']}</b>  <code>{best['pnl']:+.2f} USDC</code>",
        f"Worst: <b>{worst['symbol']}</b> <code>{worst['pnl']:+.2f} USDC</code>",
    ]

    if strategies:
        lines.append("")
        lines.append("<b>By Strategy:</b>")
        for s in sorted(strategies, key=lambda x: x["pnl"], reverse=True):
            strat_total = s["wins"] + s["losses"]
            strat_wr    = round((s["wins"] / strat_total) * 100, 0) if strat_total > 0 else 0
            pnl_sign    = "🟢" if s["pnl"] >= 0 else "🔴"
            lines.append(
                f"  {pnl_sign} {s['name']}: {s['trades']}T  "
                f"{strat_wr:.0f}%WR  <code>{s['pnl']:+.2f}</code>"
            )

    return "\n".join(lines)
```

---

## Saving Report to Redis

```python
async def save_report_to_redis(redis, report: dict[str, Any]) -> None:
    """
    Save the report JSON to Redis with 30-day TTL.
    Key: stats.report.{YYYY-MM-DD}
    """
    key = f"stats.report.{report['date']}"
    ttl = 30 * 86400   # 30 days in seconds
    await redis.set(key, json.dumps(report), ex=ttl)
    log = logger.bind(component="monitor")
    log.info(f"Daily report saved to Redis: {key}")
```

---

## Resetting Daily Counters

```python
async def reset_daily_counters(redis) -> None:
    """
    Reset all daily stats keys at midnight UTC.
    Called AFTER report is generated and saved.
    """
    await redis.set("stats.daily_pnl",    "0")
    await redis.set("stats.daily_trades", "0")
    await redis.delete("stats.best_trade")
    await redis.delete("stats.worst_trade")

    # Note: stats.wins.{strategy} and stats.losses.{strategy} are NOT reset.
    # They are all-time cumulative counters.
    # Use the PostgreSQL query to get per-day breakdowns for historical reporting.
```

---

## Manual Report via stream.commands

CommandListener dispatches `DAILY_REPORT` to Monitor. Wire this in `command_listener.py`:

```python
# In CommandListener._handle()
elif cmd == "DAILY_REPORT":
    asyncio.create_task(self._trigger_manual_report(), name="monitor.manual_report")

async def _trigger_manual_report(self):
    """Publish a manual-report request on a pub/sub channel Monitor listens to."""
    await self.redis.publish("monitor.commands", json.dumps({"cmd": "DAILY_REPORT"}))
```

Monitor subscribes to `monitor.commands` alongside `position.updates`:

```python
# In Monitor.run() — subscribe to both channels
await pubsub.subscribe("position.updates", "monitor.commands")

async for message in pubsub.listen():
    if message["type"] != "message":
        continue
    channel = message["channel"]
    if channel == "position.updates":
        await self._handle_position_update(message["data"])
    elif channel == "monitor.commands":
        data = json.loads(message["data"])
        if data.get("cmd") == "DAILY_REPORT":
            self.log.info("Manual daily report requested")
            report = await generate_daily_report(self.redis, self.db_pool)
            msg    = format_daily_report_message(report)
            self.alerter.enqueue(msg)
            await save_report_to_redis(self.redis, report)
```

### CLI Trigger

```bash
redis-cli XADD stream.commands '*' cmd DAILY_REPORT payload '{}'
```

---

## PostgreSQL Trades Table Schema (required)

The report queries assume this minimum schema:

```sql
CREATE TABLE trades (
    id          SERIAL PRIMARY KEY,
    mint        TEXT        NOT NULL,
    symbol      TEXT        NOT NULL,
    strategy    TEXT        NOT NULL,
    side        TEXT        NOT NULL,      -- 'BUY' | 'SELL'
    status      TEXT        NOT NULL,      -- 'open' | 'closed'
    entry_price NUMERIC(20,8),
    exit_price  NUMERIC(20,8),
    size_usdc   NUMERIC(12,4),
    pnl_usdc    NUMERIC(12,4),
    reason      TEXT,                      -- 'take_profit' | 'stop_loss' | 'max_hold_time'
    opened_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at   TIMESTAMPTZ,
    tx_buy      TEXT,
    tx_sell     TEXT
);

CREATE INDEX idx_trades_closed_at ON trades (closed_at);
CREATE INDEX idx_trades_strategy  ON trades (strategy);
```

The `closed_at` index is critical — daily report queries filter on this column.

---

## Reading Historical Reports

```python
async def get_report(redis, date_str: str) -> Optional[dict]:
    """Retrieve a saved daily report. date_str format: '2024-01-15'"""
    raw = await redis.get(f"stats.report.{date_str}")
    return json.loads(raw) if raw else None
```

List available reports:

```python
async def list_report_dates(redis) -> list[str]:
    keys = await redis.keys("stats.report.*")
    dates = sorted([k.replace("stats.report.", "") for k in keys])
    return dates
```
