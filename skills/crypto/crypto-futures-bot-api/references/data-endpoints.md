# Data Endpoints

Trade history, performance metrics, equity curve, health, and account data endpoints.

## Table of contents
- routers/data.py (trades, metrics, accounts)
- routers/health.py (health, alerts)
- Query patterns reference

---

## routers/data.py

```python
# routers/data.py
import json
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, text

from dependencies import RedisDep, SessionDep, UserDep

router = APIRouter()


# ── /trades ───────────────────────────────────────────────────────────

class TradeOut(BaseModel):
    id:            int
    symbol:        str
    direction:     str
    strategy:      str
    entry_price:   str
    exit_price:    str | None
    qty:           str
    gross_pnl:     str
    fee_total:     str
    net_pnl:       str
    outcome:       str | None
    leverage:      int
    sl_price:      str
    tp_price:      str | None
    opened_at:     str
    closed_at:     str | None
    hold_duration_s: int | None

    class Config:
        from_attributes = True


@router.get("/trades", response_model=list[TradeOut])
async def get_trades(
    session: SessionDep,
    _user:   UserDep,
    symbol:    Optional[str]  = Query(default=None),
    strategy:  Optional[str]  = Query(default=None),
    from_date: Optional[str]  = Query(default=None, description="ISO date, e.g. 2025-01-01"),
    to_date:   Optional[str]  = Query(default=None),
    outcome:   Optional[str]  = Query(default=None, description="sl_hit | tp_hit | manual_close | emergency_close"),
    limit:     int            = Query(default=50,  ge=1, le=500),
    offset:    int            = Query(default=0,   ge=0),
    account_id: int           = Query(default=1),
):
    """
    Paginated trade history. All money columns returned as strings
    (Decimal-safe — let the frontend parse to float for display only).
    """
    # Build WHERE clauses dynamically
    filters = ["t.account_id = :account_id", "t.closed_at IS NOT NULL"]
    params: dict = {"account_id": account_id, "limit": limit, "offset": offset}

    if symbol:
        filters.append("t.symbol = :symbol")
        params["symbol"] = symbol
    if strategy:
        filters.append("t.strategy = :strategy")
        params["strategy"] = strategy
    if from_date:
        filters.append("t.closed_at >= :from_date::timestamptz")
        params["from_date"] = from_date
    if to_date:
        filters.append("t.closed_at <= :to_date::timestamptz")
        params["to_date"] = to_date
    if outcome:
        filters.append("t.outcome = :outcome")
        params["outcome"] = outcome

    where = " AND ".join(filters)
    sql = text(f"""
        SELECT
            t.id, t.symbol, t.direction, t.strategy,
            t.entry_price::text, t.exit_price::text,
            t.qty::text, t.gross_pnl::text,
            t.fee_total::text, t.net_pnl::text,
            t.outcome, t.leverage,
            t.sl_price::text, t.tp_price::text,
            t.opened_at::text, t.closed_at::text,
            EXTRACT(EPOCH FROM (t.closed_at - t.opened_at))::int AS hold_duration_s
        FROM trades t
        WHERE {where}
        ORDER BY t.closed_at DESC
        LIMIT :limit OFFSET :offset
    """)

    result = await session.execute(sql, params)
    rows   = result.mappings().all()
    return [TradeOut(**dict(r)) for r in rows]


# ── /metrics/performance ──────────────────────────────────────────────

@router.get("/metrics/performance")
async def get_performance(
    session:    SessionDep,
    _user:      UserDep,
    account_id: int          = Query(default=1),
    days:       int          = Query(default=30, ge=1, le=365),
):
    """
    Aggregate performance stats for the dashboard stats row.
    win_rate, profit_factor, max_drawdown_pct, avg_r, net_pnl, trade_count.
    """
    result = await session.execute(text("""
        WITH base AS (
            SELECT
                net_pnl,
                CASE WHEN net_pnl > 0 THEN net_pnl END AS win_pnl,
                CASE WHEN net_pnl < 0 THEN ABS(net_pnl) END AS loss_pnl
            FROM trades
            WHERE account_id    = :account_id
              AND closed_at     IS NOT NULL
              AND closed_at     >= NOW() - (:days || ' days')::interval
        )
        SELECT
            COUNT(*)                                          AS trade_count,
            SUM(net_pnl)                                     AS net_pnl,
            SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)   AS wins,
            SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END)   AS losses,
            COALESCE(SUM(win_pnl),  0)                       AS gross_profit,
            COALESCE(SUM(loss_pnl), 0)                       AS gross_loss,
            AVG(net_pnl)                                     AS avg_pnl
        FROM base
    """), {"account_id": account_id, "days": days})

    row = result.mappings().first()
    if not row or not row["trade_count"]:
        return _empty_performance()

    trade_count   = int(row["trade_count"])
    wins          = int(row["wins"])
    losses        = int(row["losses"])
    net_pnl       = float(row["net_pnl"] or 0)
    gross_profit  = float(row["gross_profit"] or 0)
    gross_loss    = float(row["gross_loss"] or 0)

    win_rate       = wins / trade_count if trade_count else 0
    profit_factor  = (gross_profit / gross_loss) if gross_loss > 0 else float("inf")

    # Max drawdown from equity curve snapshots
    dd_result = await session.execute(text("""
        SELECT
            MAX(equity)    AS peak,
            MIN(equity)    AS trough,
            (SELECT equity FROM pnl_snapshots
             WHERE account_id = :aid ORDER BY snapshot_ts DESC LIMIT 1) AS current_eq
        FROM pnl_snapshots
        WHERE account_id = :aid
          AND snapshot_ts >= NOW() - (:days || ' days')::interval
    """), {"aid": account_id, "days": days})
    dd_row = dd_result.mappings().first()
    max_drawdown_pct = 0.0
    if dd_row and dd_row["peak"] and float(dd_row["peak"]) > 0:
        peak   = float(dd_row["peak"])
        trough = float(dd_row["trough"] or peak)
        max_drawdown_pct = round((peak - trough) / peak * 100, 2)

    return {
        "trade_count":    trade_count,
        "win_rate":       round(win_rate * 100, 2),
        "net_pnl":        round(net_pnl, 4),
        "profit_factor":  round(profit_factor, 2) if profit_factor != float("inf") else None,
        "max_drawdown_pct": max_drawdown_pct,
        "avg_pnl":        round(float(row["avg_pnl"] or 0), 4),
        "period_days":    days,
    }


def _empty_performance() -> dict:
    return {
        "trade_count": 0, "win_rate": 0.0, "net_pnl": 0.0,
        "profit_factor": None, "max_drawdown_pct": 0.0, "avg_pnl": 0.0,
    }


# ── /metrics/equity-curve ─────────────────────────────────────────────

@router.get("/metrics/equity-curve")
async def get_equity_curve(
    session:    SessionDep,
    _user:      UserDep,
    account_id: int = Query(default=1),
    hours:      int = Query(default=24, ge=1, le=720),
):
    """
    Equity snapshots for lightweight-charts time series.
    Returns list of {time, equity, unrealized_pnl}.
    """
    result = await session.execute(text("""
        SELECT
            EXTRACT(EPOCH FROM snapshot_ts)::bigint AS time,
            equity::float                           AS equity,
            unrealized_pnl::float                  AS unrealized_pnl
        FROM pnl_snapshots
        WHERE account_id = :aid
          AND snapshot_ts >= NOW() - (:h || ' hours')::interval
        ORDER BY snapshot_ts ASC
    """), {"aid": account_id, "h": hours})

    return [dict(r) for r in result.mappings().all()]


# ── /accounts ─────────────────────────────────────────────────────────

@router.get("/accounts")
async def get_accounts(session: SessionDep, _user: UserDep):
    """
    Exchange accounts list. api_key_ref is returned (never the actual key).
    """
    result = await session.execute(text("""
        SELECT a.id, a.label, a.api_key_ref,
               e.name AS exchange_name, e.slug AS exchange_slug
        FROM accounts a
        JOIN exchanges e ON e.id = a.exchange_id
        WHERE a.is_active = true
        ORDER BY a.id
    """))
    return [dict(r) for r in result.mappings().all()]
```

---

## routers/health.py

```python
# routers/health.py
import json
import time
from datetime import datetime, timezone

from fastapi import APIRouter

from dependencies import RedisDep, UserDep

router = APIRouter()

_HEARTBEAT_KEY   = "bot.heartbeat"          # set by HealthHeartbeat in bot engine
_HEALTH_SNAP_KEY = "bot.health.snapshot"    # JSON: component status dict


@router.get("")
async def get_health(redis: RedisDep, _user: UserDep):
    """
    Combines bot heartbeat age with the component health snapshot
    written by the bot engine's HealthHeartbeat task.

    - heartbeat_age_s > 30 → engine is likely dead (CRITICAL threshold)
    - component_status: dict of component → "ok" | "error" | "degraded"
    """
    heartbeat_raw = await redis.get(_HEARTBEAT_KEY)
    snapshot_raw  = await redis.get(_HEALTH_SNAP_KEY)

    now_ts = int(time.time())

    if heartbeat_raw:
        last_beat_ts  = int(heartbeat_raw)
        heartbeat_age = now_ts - last_beat_ts
        heartbeat_ok  = heartbeat_age < 30
    else:
        heartbeat_age = None
        heartbeat_ok  = False

    component_status: dict = {}
    if snapshot_raw:
        try:
            component_status = json.loads(snapshot_raw)
        except json.JSONDecodeError:
            pass

    bot_status = await redis.get("state.bot.status") or "unknown"

    return {
        "bot_status":      bot_status,
        "heartbeat_ok":    heartbeat_ok,
        "heartbeat_age_s": heartbeat_age,
        "components":      component_status,
        "checked_at":      datetime.now(timezone.utc).isoformat(),
    }


_THROTTLE_PREFIX = "alert.throttle."


@router.get("/alerts")
async def get_active_alerts(redis: RedisDep, _user: UserDep):
    """
    Returns currently throttled alerts — i.e. alerts that fired recently
    and are suppressed from re-sending. Useful for the dashboard alert feed.

    Alert keys follow the pattern: alert.throttle.{alert_type}.{symbol}
    Written by AlertManager in the monitoring skill.
    """
    keys = await redis.keys(f"{_THROTTLE_PREFIX}*")
    if not keys:
        return []

    pipe     = redis.pipeline()
    for k in keys:
        pipe.get(k)
        pipe.ttl(k)
    results  = await pipe.execute()

    alerts = []
    for i, key in enumerate(keys):
        raw = results[i * 2]
        ttl = results[i * 2 + 1]
        if raw is None:
            continue
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = {"message": raw}

        # Key pattern: alert.throttle.{alert_type}[.{symbol}]
        parts      = key[len(_THROTTLE_PREFIX):].split(".", 1)
        alert_type = parts[0]
        symbol     = parts[1] if len(parts) > 1 else "global"

        alerts.append({
            "alert_type": alert_type,
            "symbol":     symbol,
            "ttl_s":      ttl,
            **data,
        })

    # Most recently fired first
    alerts.sort(key=lambda a: a.get("fired_at", ""), reverse=True)
    return alerts
```

---

## Query patterns reference

These follow the conventions from `crypto-futures-bot-db-schema`:

- All money columns cast to `::text` or `::float` — never return `Decimal` objects in JSON
- All `*_at` timestamps cast to `::text` — ISO format, UTC
- Always filter by `account_id` — never return cross-account data
- Use raw `text()` SQL for analytics queries (more readable than ORM for aggregates)
- For paginated endpoints: always include `LIMIT + OFFSET`, expose both in response headers if needed
