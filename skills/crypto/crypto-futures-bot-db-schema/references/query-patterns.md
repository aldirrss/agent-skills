# Query Patterns

All queries needed for dashboard analytics. Raw SQL for complex aggregations (faster than ORM for analytics), SQLModel/SQLAlchemy for simple CRUD.

## Table of contents
- Daily PnL
- Equity curve
- Win rate & profit factor per strategy
- Drawdown calculation
- Best / worst trades
- PnL by symbol
- Funding cost breakdown
- Open position summary
- Signal analysis

---

## Daily PnL

```sql
-- Daily net PnL for an account, last 30 days
SELECT
    DATE_TRUNC('day', closed_at AT TIME ZONE 'UTC') AS trade_date,
    COUNT(*)                                          AS total_trades,
    SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)    AS wins,
    SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END)   AS losses,
    ROUND(SUM(net_pnl)::NUMERIC, 4)                  AS net_pnl,
    ROUND(SUM(fee_total)::NUMERIC, 4)                AS total_fees,
    ROUND(SUM(funding_total)::NUMERIC, 4)            AS total_funding
FROM trades
WHERE account_id = :account_id
  AND closed_at  >= NOW() - INTERVAL '30 days'
  AND closed_at  IS NOT NULL
GROUP BY trade_date
ORDER BY trade_date DESC;
```

```python
# SQLAlchemy equivalent for FastAPI endpoint
from sqlalchemy import text
from decimal import Decimal

async def daily_pnl(session: AsyncSession, account_id: int,
                    days: int = 30) -> list[dict]:
    result = await session.exec(text("""
        SELECT
            DATE_TRUNC('day', closed_at)::DATE AS trade_date,
            COUNT(*)::INT                       AS total_trades,
            COALESCE(SUM(net_pnl), 0)          AS net_pnl,
            COALESCE(SUM(fee_total), 0)        AS total_fees
        FROM trades
        WHERE account_id = :account_id
          AND closed_at >= NOW() - INTERVAL ':days days'
          AND closed_at IS NOT NULL
        GROUP BY trade_date
        ORDER BY trade_date DESC
    """), {"account_id": account_id, "days": days})
    return [dict(row) for row in result]
```

---

## Equity curve

```sql
-- Equity snapshots every 15min for charting
SELECT
    snapshot_ts,
    equity,
    available_balance,
    unrealized_pnl,
    open_positions_count
FROM pnl_snapshots
WHERE account_id = :account_id
  AND snapshot_ts >= :from_ts
  AND snapshot_ts <= :to_ts
ORDER BY snapshot_ts ASC;
```

```python
# Snapshot writer — call from PositionTracker every 15min
async def write_pnl_snapshot(session: AsyncSession, account_id: int, ex):
    balance  = await ex.fetch_balance()
    positions = await ex.fetch_positions()

    equity      = Decimal(str(balance["total"]["USDT"]))
    available   = Decimal(str(balance["free"]["USDT"]))
    unrealized  = sum(Decimal(str(p["unrealizedPnl"])) for p in positions if p["symbol"])
    open_count  = len([p for p in positions if p["contracts"] > 0])

    # Round to 15min interval
    now = datetime.now(timezone.utc)
    snap_ts = now.replace(
        minute=(now.minute // 15) * 15,
        second=0, microsecond=0
    )

    snapshot = PnlSnapshot(
        account_id=account_id,
        equity=equity,
        available_balance=available,
        unrealized_pnl=unrealized,
        open_positions_count=open_count,
        snapshot_ts=snap_ts,
    )
    session.add(snapshot)
    await session.commit()
```

---

## Win rate & profit factor per strategy

```sql
SELECT
    strategy,
    COUNT(*)                                              AS total_trades,
    SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END)        AS wins,
    ROUND(
        100.0 * SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 2
    )                                                     AS win_rate_pct,
    ROUND(AVG(r_multiple)::NUMERIC, 3)                   AS avg_r_multiple,
    ROUND(SUM(net_pnl)::NUMERIC, 4)                      AS total_net_pnl,
    -- Profit factor = gross wins / abs(gross losses)
    ROUND(
        COALESCE(SUM(CASE WHEN net_pnl > 0 THEN net_pnl END), 0) /
        NULLIF(ABS(SUM(CASE WHEN net_pnl < 0 THEN net_pnl END)), 0),
        3
    )                                                     AS profit_factor,
    ROUND(AVG(duration_seconds) / 3600.0, 2)             AS avg_duration_hours
FROM trades
WHERE account_id = :account_id
  AND closed_at  IS NOT NULL
  AND closed_at  >= :from_ts
GROUP BY strategy
ORDER BY total_net_pnl DESC;
```

---

## Drawdown calculation

```sql
-- Max drawdown from equity curve: largest peak-to-trough drop
WITH peaks AS (
    SELECT
        snapshot_ts,
        equity,
        MAX(equity) OVER (
            PARTITION BY account_id
            ORDER BY snapshot_ts
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) AS running_peak
    FROM pnl_snapshots
    WHERE account_id = :account_id
      AND snapshot_ts >= :from_ts
)
SELECT
    snapshot_ts,
    equity,
    running_peak,
    ROUND((equity - running_peak)::NUMERIC, 4)              AS drawdown_abs,
    ROUND(100.0 * (equity - running_peak) / running_peak, 4) AS drawdown_pct
FROM peaks
ORDER BY drawdown_pct ASC   -- most negative first
LIMIT 1;                    -- max drawdown point
```

```python
async def current_drawdown(session: AsyncSession, account_id: int) -> dict:
    """Current drawdown from all-time equity peak."""
    result = await session.exec(text("""
        SELECT
            MAX(equity)                                       AS peak_equity,
            (SELECT equity FROM pnl_snapshots
             WHERE account_id = :account_id
             ORDER BY snapshot_ts DESC LIMIT 1)              AS current_equity
        FROM pnl_snapshots
        WHERE account_id = :account_id
    """), {"account_id": account_id})
    row = result.first()
    if not row or not row.peak_equity:
        return {"drawdown_pct": 0, "drawdown_abs": 0}
    dd_abs = row.current_equity - row.peak_equity
    dd_pct = (dd_abs / row.peak_equity * 100) if row.peak_equity else 0
    return {
        "peak_equity":    float(row.peak_equity),
        "current_equity": float(row.current_equity),
        "drawdown_abs":   float(dd_abs),
        "drawdown_pct":   round(float(dd_pct), 4),
    }
```

---

## Best / worst trades

```sql
-- Top 5 best and worst trades by net_pnl
(
    SELECT 'best' AS category, id, symbol, strategy, direction,
           net_pnl, r_multiple, outcome, opened_at, closed_at
    FROM trades
    WHERE account_id = :account_id AND closed_at IS NOT NULL
    ORDER BY net_pnl DESC
    LIMIT 5
)
UNION ALL
(
    SELECT 'worst', id, symbol, strategy, direction,
           net_pnl, r_multiple, outcome, opened_at, closed_at
    FROM trades
    WHERE account_id = :account_id AND closed_at IS NOT NULL
    ORDER BY net_pnl ASC
    LIMIT 5
)
ORDER BY category, net_pnl DESC;
```

---

## PnL by symbol

```sql
SELECT
    symbol,
    COUNT(*)                                         AS total_trades,
    ROUND(SUM(net_pnl)::NUMERIC, 4)                 AS net_pnl,
    ROUND(AVG(net_pnl)::NUMERIC, 4)                 AS avg_pnl_per_trade,
    ROUND(AVG(r_multiple)::NUMERIC, 3)              AS avg_r,
    ROUND(
        100.0 * SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 2
    )                                                AS win_rate_pct,
    SUM(fee_total + funding_total)                  AS total_costs
FROM trades
WHERE account_id = :account_id
  AND closed_at IS NOT NULL
  AND closed_at >= :from_ts
GROUP BY symbol
ORDER BY net_pnl DESC;
```

---

## Funding cost breakdown

```sql
-- Funding paid vs received per symbol over a period
SELECT
    fp.symbol,
    COUNT(*)                                        AS payment_count,
    ROUND(SUM(fp.amount)::NUMERIC, 6)              AS net_funding,   -- neg = paid more
    ROUND(SUM(CASE WHEN fp.amount < 0 THEN fp.amount ELSE 0 END)::NUMERIC, 6) AS total_paid,
    ROUND(SUM(CASE WHEN fp.amount > 0 THEN fp.amount ELSE 0 END)::NUMERIC, 6) AS total_received,
    ROUND(AVG(ABS(fp.rate))::NUMERIC, 8)           AS avg_rate
FROM funding_payments fp
WHERE fp.account_id = :account_id
  AND fp.payment_ts >= :from_ts
GROUP BY fp.symbol
ORDER BY net_funding ASC;   -- biggest payers first
```

---

## Open position summary

```sql
-- All currently open trades with unrealized PnL estimate
SELECT
    t.id,
    t.symbol,
    t.strategy,
    t.direction,
    t.qty,
    t.entry_price,
    t.sl_price,
    t.tp_price,
    t.leverage,
    t.initial_risk,
    t.opened_at,
    EXTRACT(EPOCH FROM (NOW() - t.opened_at)) / 3600 AS hours_open,
    t.fee_total,
    t.funding_total
FROM trades t
WHERE t.account_id = :account_id
  AND t.closed_at IS NULL
ORDER BY t.opened_at ASC;
-- Note: unrealized PnL comes from exchange API (state.position.* in Redis),
-- not from DB — DB has no live price access.
```

---

## Signal analysis

```sql
-- Signal quality: how many signals become trades, filtered by what
SELECT
    status,
    discard_reason,
    COUNT(*)                                         AS count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 2) AS pct
FROM signals
WHERE account_id = :account_id
  AND signal_ts >= :from_ts
GROUP BY status, discard_reason
ORDER BY count DESC;
```

```sql
-- LLM signal accuracy: did LLM-aligned signals perform better?
SELECT
    CASE WHEN s.llm_direction = t.direction::TEXT THEN 'llm_aligned'
         WHEN s.llm_score IS NULL               THEN 'no_llm'
         ELSE 'llm_misaligned' END               AS llm_category,
    COUNT(*)                                     AS trades,
    ROUND(AVG(t.net_pnl)::NUMERIC, 4)           AS avg_pnl,
    ROUND(AVG(t.r_multiple)::NUMERIC, 3)        AS avg_r,
    ROUND(
        100.0 * SUM(CASE WHEN t.net_pnl > 0 THEN 1 ELSE 0 END) / COUNT(*), 2
    )                                            AS win_rate_pct
FROM trades t
JOIN signals s ON t.signal_id = s.id
WHERE t.account_id = :account_id
  AND t.closed_at IS NOT NULL
  AND t.closed_at >= :from_ts
GROUP BY llm_category;
```
