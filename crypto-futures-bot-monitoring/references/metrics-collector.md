# Metrics Collector

Collect and store bot performance metrics using Redis (real-time) and PostgreSQL (historical). No extra infrastructure needed.

## Table of contents
- MetricsCollector component
- Real-time metrics (Redis)
- Historical metrics (PostgreSQL)
- Dashboard-ready queries
- Daily summary scheduler

---

## MetricsCollector component

```python
# components/metrics_collector.py
import asyncio
import json
import time
from decimal import Decimal
from logger_setup import component_logger
from config import settings

log = component_logger("metrics_collector")


class MetricsCollector:
    """
    Runs as asyncio task. Two loops:
    - Every 60s: check WARNING conditions, update Redis metrics
    - Every 15min: write PnL snapshot to PostgreSQL (reuses pnl_snapshots table)
    """

    def __init__(self, redis, registry, session_factory,
                 alert_manager, exchange_factory, account_id: int):
        self.redis      = redis
        self.registry   = registry
        self.db         = session_factory
        self.alerts     = alert_manager
        self.ex_factory = exchange_factory
        self.account_id = account_id

    async def run(self, stop_event: asyncio.Event) -> None:
        log.info("Starting")
        tasks = [
            asyncio.create_task(self._warning_loop(stop_event),  name="warning_checks"),
            asyncio.create_task(self._snapshot_loop(stop_event), name="pnl_snapshots"),
            asyncio.create_task(self._daily_summary(stop_event), name="daily_summary"),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            for t in tasks:
                t.cancel()
            log.info("Stopped")

    # ── Warning check loop (every 60s) ───────────────────────────────

    async def _warning_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            await asyncio.sleep(60)
            try:
                await self._run_warning_checks()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Warning check error")

    async def _run_warning_checks(self) -> None:
        from alerts.conditions_warning import (
            check_daily_drawdown, check_consecutive_losses,
            check_win_rate, check_fill_timeout,
        )
        symbols = self.registry.all_symbols()
        checks  = [
            await check_daily_drawdown(self.db, self.account_id),
            await check_consecutive_losses(self.db, self.account_id),
            await check_win_rate(self.db, self.account_id),
            *[await check_fill_timeout(self.redis, s) for s in symbols],
        ]
        for result in checks:
            if result:
                await self.alerts.send(result["alert_type"], result["symbol"], result)

        # Update Redis real-time metrics
        await self._update_realtime_metrics(symbols)

    # ── PnL snapshot loop (every 15min) ─────────────────────────────

    async def _snapshot_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            await asyncio.sleep(settings.pnl_snapshot_interval_s)
            try:
                await self._write_pnl_snapshot()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("PnL snapshot error")

    async def _write_pnl_snapshot(self) -> None:
        from db.models.snapshot import PnlSnapshot
        from datetime import datetime, timezone

        ex = await self.ex_factory()
        try:
            balance   = await ex.fetch_balance()
            positions = await ex.fetch_positions()
            equity    = Decimal(str(balance["total"].get("USDT", 0)))
            available = Decimal(str(balance["free"].get("USDT", 0)))
            unrealized = sum(
                Decimal(str(p.get("unrealizedPnl", 0)))
                for p in positions if p.get("contracts", 0) > 0
            )
            open_count = len([p for p in positions if p.get("contracts", 0) > 0])
        finally:
            await ex.close()

        # Round to 15min boundary
        now     = datetime.now(timezone.utc)
        snap_ts = now.replace(minute=(now.minute // 15) * 15,
                              second=0, microsecond=0)

        snap = PnlSnapshot(
            account_id=self.account_id,
            equity=equity,
            available_balance=available,
            unrealized_pnl=unrealized,
            open_positions_count=open_count,
            snapshot_ts=snap_ts,
        )
        async with self.db() as session:
            # Upsert — unique on (account_id, snapshot_ts)
            from sqlalchemy.dialects.postgresql import insert
            stmt = insert(PnlSnapshot).values(snap.dict()).on_conflict_do_update(
                index_elements=["account_id", "snapshot_ts"],
                set_={"equity": equity, "available_balance": available,
                      "unrealized_pnl": unrealized,
                      "open_positions_count": open_count},
            )
            await session.exec(stmt)
            await session.commit()

        # Also cache latest equity in Redis
        await self.redis.set(f"metrics.equity.{self.account_id}", str(equity), ex=900)
        log.debug("PnL snapshot written", equity=str(equity))

    # ── Real-time Redis metrics ───────────────────────────────────────

    async def _update_realtime_metrics(self, symbols: list[str]) -> None:
        """Write current metrics to Redis for instant dashboard reads."""
        from sqlalchemy import text
        async with self.db() as session:
            # Today's PnL summary
            result = await session.exec(text("""
                SELECT
                    COUNT(*) AS trades,
                    COALESCE(SUM(net_pnl), 0) AS net_pnl,
                    SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins
                FROM trades
                WHERE account_id = :aid
                  AND closed_at >= DATE_TRUNC('day', NOW())
                  AND closed_at IS NOT NULL
            """), {"aid": self.account_id})
            today = result.first()

            # Peak drawdown from equity curve
            result2 = await session.exec(text("""
                SELECT
                    MAX(equity) AS peak,
                    (SELECT equity FROM pnl_snapshots
                     WHERE account_id = :aid
                     ORDER BY snapshot_ts DESC LIMIT 1) AS current_eq
                FROM pnl_snapshots WHERE account_id = :aid
            """), {"aid": self.account_id})
            dd_row = result2.first()

        metrics = {
            "today_trades": int(today.trades or 0),
            "today_pnl":    float(today.net_pnl or 0),
            "today_wins":   int(today.wins or 0),
            "peak_equity":  float(dd_row.peak or 0) if dd_row else 0,
            "current_equity": float(dd_row.current_eq or 0) if dd_row else 0,
            "ts": int(time.time() * 1000),
        }
        if dd_row and dd_row.peak and float(dd_row.peak) > 0:
            dd = (float(dd_row.peak) - float(dd_row.current_eq or 0)) / float(dd_row.peak)
            metrics["drawdown_pct"] = round(dd * 100, 4)

        await self.redis.set(
            f"metrics.summary.{self.account_id}",
            json.dumps(metrics),
            ex=120,  # 2 min TTL
        )
```

---

## Dashboard-ready queries

```python
# Quick reads for API dashboard endpoints — all from Redis (fast)

async def get_realtime_metrics(redis, account_id: int) -> dict:
    """Used by GET /dashboard/metrics — returns cached summary."""
    raw = await redis.get(f"metrics.summary.{account_id}")
    if raw:
        return json.loads(raw)
    return {"error": "metrics not yet available"}


async def get_equity(redis, account_id: int) -> float | None:
    """Latest account equity."""
    raw = await redis.get(f"metrics.equity.{account_id}")
    return float(raw) if raw else None


# Equity curve — from PostgreSQL (for charting, not real-time)
async def get_equity_curve(session_factory, account_id: int,
                            hours: int = 24) -> list[dict]:
    from sqlalchemy import text
    async with session_factory() as session:
        result = await session.exec(text("""
            SELECT snapshot_ts, equity, unrealized_pnl
            FROM pnl_snapshots
            WHERE account_id = :aid
              AND snapshot_ts >= NOW() - INTERVAL ':h hours'
            ORDER BY snapshot_ts ASC
        """), {"aid": account_id, "h": hours})
        return [{"ts": str(r.snapshot_ts), "equity": float(r.equity),
                 "unrealized": float(r.unrealized_pnl)} for r in result]
```

---

## Daily summary scheduler

```python
async def _daily_summary(self, stop_event: asyncio.Event) -> None:
    """Send daily PnL summary at 00:00 UTC."""
    from alerts.manager import send_daily_summary
    import datetime as dt

    while not stop_event.is_set():
        now = dt.datetime.now(dt.timezone.utc)
        # Next midnight UTC
        tomorrow = (now + dt.timedelta(days=1)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        wait_s = (tomorrow - now).total_seconds()
        log.debug("Daily summary scheduled", wait_s=wait_s)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=wait_s)
            break  # stop_event set — exit
        except asyncio.TimeoutError:
            pass   # timeout = it's midnight, send summary

        try:
            await send_daily_summary(self.alerts, self.db, self.account_id)
        except Exception:
            log.exception("Daily summary send error")
```
