# Query Patterns — asyncpg

All functions accept an `asyncpg.Pool` as first argument. Use `async with pool.acquire() as conn:` inside every function. All money values are returned as Python `Decimal` from asyncpg's NUMERIC mapping — cast to `float` only at the API/presentation layer.

---

## Insert Trade (BUY fill)

Called by DBWriter immediately when a BUY fill arrives on `stream.fills`.

```python
# db/queries.py
import asyncpg
from decimal import Decimal


async def insert_trade_buy(pool: asyncpg.Pool, fill: dict) -> int:
    """
    Insert a new BUY fill as a trade row.
    Returns the new row id.
    ON CONFLICT DO NOTHING handles duplicate fills from crash recovery.
    """
    sql = """
        INSERT INTO trades (
            fill_id, swap_id, mint, symbol, side, status,
            tx_signature, amount_usdc, amount_tokens, price_usdc,
            strategy, created_at
        )
        VALUES ($1, $2, $3, $4, 'BUY', $5, $6, $7, $8, $9, $10, NOW())
        ON CONFLICT (fill_id) DO NOTHING
        RETURNING id
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            sql,
            fill["fill_id"],
            fill["swap_id"],
            fill["mint"],
            fill.get("symbol"),
            fill["status"],           # confirmed | failed | timeout | dry_run
            fill.get("tx_signature"),
            Decimal(str(fill["amount_usdc"])),
            int(fill["amount_tokens"]),
            Decimal(str(fill["price_usdc"])),
            fill.get("strategy"),
        )
    return row["id"] if row else None
```

---

## Update Trade with PnL on SELL fill

Called by DBWriter when a SELL fill arrives. Looks up the most recent confirmed BUY for the same mint to calculate PnL.

```python
async def update_trade_sell(
    pool: asyncpg.Pool,
    mint: str,
    sell_fill: dict,
    buy_fill: dict,
) -> None:
    """
    Insert the SELL fill row and calculate PnL.
    buy_fill is fetched from the trades table (most recent confirmed BUY for mint).
    pnl_usdc = sell_amount_usdc - buy_amount_usdc
    pnl_pct  = (pnl_usdc / buy_amount_usdc) * 100
    """
    sell_amount = Decimal(str(sell_fill["amount_usdc"]))
    buy_amount  = Decimal(str(buy_fill["amount_usdc"]))

    pnl_usdc = sell_amount - buy_amount
    pnl_pct  = (pnl_usdc / buy_amount * 100) if buy_amount else Decimal("0")

    sql = """
        INSERT INTO trades (
            fill_id, swap_id, mint, symbol, side, status,
            tx_signature, amount_usdc, amount_tokens, price_usdc,
            strategy, reason, pnl_usdc, pnl_pct, created_at
        )
        VALUES ($1, $2, $3, $4, 'SELL', $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
        ON CONFLICT (fill_id) DO NOTHING
    """
    async with pool.acquire() as conn:
        await conn.execute(
            sql,
            sell_fill["fill_id"],
            sell_fill["swap_id"],
            mint,
            sell_fill.get("symbol"),
            sell_fill["status"],
            sell_fill.get("tx_signature"),
            sell_amount,
            int(sell_fill["amount_tokens"]),
            Decimal(str(sell_fill["price_usdc"])),
            sell_fill.get("strategy"),
            sell_fill.get("reason"),   # take_profit | stop_loss | max_hold_time | emergency_stop
            pnl_usdc.quantize(Decimal("0.000001")),
            pnl_pct.quantize(Decimal("0.0001")),
        )


async def get_latest_buy_fill(pool: asyncpg.Pool, mint: str) -> dict | None:
    """
    Fetch the most recent confirmed BUY fill for a given mint.
    Used to pair with SELL fill for PnL calculation.
    """
    sql = """
        SELECT id, fill_id, amount_usdc, amount_tokens, price_usdc, strategy
        FROM trades
        WHERE mint = $1
          AND side = 'BUY'
          AND status = 'confirmed'
        ORDER BY created_at DESC
        LIMIT 1
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, mint)
    return dict(row) if row else None
```

---

## Win Rate Per Strategy (last 30 days)

Returns per-strategy stats for the dashboard strategy leaderboard.

```python
async def get_strategy_win_rates(pool: asyncpg.Pool) -> list[dict]:
    """
    Returns [{strategy, total, wins, win_rate, avg_pnl}]
    Only counts confirmed SELL trades (pnl_usdc is not NULL).
    """
    sql = """
        SELECT
            strategy,
            COUNT(*)                                        AS total,
            COUNT(*) FILTER (WHERE pnl_usdc > 0)           AS wins,
            ROUND(
                COUNT(*) FILTER (WHERE pnl_usdc > 0)::NUMERIC
                / NULLIF(COUNT(*), 0),
                4
            )                                               AS win_rate,
            ROUND(AVG(pnl_usdc), 4)                        AS avg_pnl
        FROM trades
        WHERE side      = 'SELL'
          AND status    = 'confirmed'
          AND pnl_usdc  IS NOT NULL
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY strategy
        ORDER BY win_rate DESC NULLS LAST
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql)
    return [dict(r) for r in rows]
```

---

## Daily PnL Summary

Returns aggregate stats for a given UTC date string (`YYYY-MM-DD`).

```python
async def get_daily_pnl(pool: asyncpg.Pool, date: str) -> dict:
    """
    Returns a summary dict for the given date.
    date format: 'YYYY-MM-DD' (UTC).
    """
    sql = """
        SELECT
            COUNT(*)                                        AS total_trades,
            ROUND(
                COUNT(*) FILTER (WHERE pnl_usdc > 0)::NUMERIC
                / NULLIF(COUNT(*), 0),
                4
            )                                               AS win_rate,
            COALESCE(SUM(pnl_usdc), 0)                     AS total_pnl_usdc,
            MAX(pnl_usdc)                                   AS best_trade_usdc,
            MIN(pnl_usdc)                                   AS worst_trade_usdc
        FROM trades
        WHERE side      = 'SELL'
          AND status    = 'confirmed'
          AND pnl_usdc  IS NOT NULL
          AND created_at::DATE = $1::DATE
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(sql, date)
    return dict(row) if row else {}
```

---

## Top Performing KOL Wallets (last 7 days)

Joins `kol_wallets` against `trades` to rank wallets by their signals' recent performance.

```python
async def get_top_kol_wallets(pool: asyncpg.Pool, limit: int = 10) -> list[dict]:
    """
    Returns KOL wallets ranked by total PnL generated from their signals over the last 7 days.
    Joins on strategy = 'kol_copy' and links via the kol_wallet address stored in signal metadata.

    Since trades.strategy = 'kol_copy' for all KOL-copy trades, and kol_wallets.address is the
    tracked wallet, the join uses a trades metadata column. If your schema stores the kol_address
    on the trade row (add a VARCHAR(44) kol_address column), use this query directly.

    If kol_address is NOT a column yet, use win_rate + total_pnl_usdc from kol_wallets directly:
    """
    sql = """
        SELECT
            kw.address,
            kw.label,
            kw.source,
            kw.win_rate,
            kw.total_trades,
            kw.total_pnl_usdc,
            kw.last_seen_at
        FROM kol_wallets kw
        WHERE kw.active = true
          AND kw.last_seen_at >= NOW() - INTERVAL '7 days'
        ORDER BY kw.total_pnl_usdc DESC NULLS LAST
        LIMIT $1
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, limit)
    return [dict(r) for r in rows]
```

**Alternative — if `kol_address` column exists on `trades`:**

```python
async def get_top_kol_wallets_by_trade_pnl(
    pool: asyncpg.Pool, limit: int = 10
) -> list[dict]:
    """
    Ranks KOL wallets by sum of pnl_usdc on trades where strategy='kol_copy'
    and kol_address matches, last 7 days.
    Requires trades.kol_address VARCHAR(44) column.
    """
    sql = """
        SELECT
            kw.address,
            kw.label,
            kw.source,
            COUNT(t.id)             AS trades_7d,
            SUM(t.pnl_usdc)         AS pnl_7d,
            ROUND(
                COUNT(*) FILTER (WHERE t.pnl_usdc > 0)::NUMERIC
                / NULLIF(COUNT(*), 0),
                4
            )                       AS win_rate_7d
        FROM kol_wallets kw
        JOIN trades t ON t.kol_address = kw.address
        WHERE t.side       = 'SELL'
          AND t.status     = 'confirmed'
          AND t.strategy   = 'kol_copy'
          AND t.created_at >= NOW() - INTERVAL '7 days'
        GROUP BY kw.address, kw.label, kw.source
        ORDER BY pnl_7d DESC NULLS LAST
        LIMIT $1
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, limit)
    return [dict(r) for r in rows]
```

---

## Signal Rejection Breakdown

Returns rejection reason stats with percentage of total for the given window.

```python
async def get_rejection_stats(pool: asyncpg.Pool, days: int = 7) -> list[dict]:
    """
    Returns [{reason, count, pct_of_total}] ordered by count DESC.
    """
    sql = """
        WITH totals AS (
            SELECT COUNT(*) AS grand_total
            FROM signal_rejections
            WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
        )
        SELECT
            sr.reason,
            COUNT(*)                                                AS count,
            ROUND(COUNT(*)::NUMERIC / NULLIF(t.grand_total, 0), 4) AS pct_of_total
        FROM signal_rejections sr
        CROSS JOIN totals t
        WHERE sr.created_at >= NOW() - ($1 || ' days')::INTERVAL
        GROUP BY sr.reason, t.grand_total
        ORDER BY count DESC
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(sql, days)
    return [dict(r) for r in rows]
```

---

## Rebuild strategy_stats (nightly)

Called by DBWriter at midnight UTC. Truncates and rebuilds from the `trades` table.

```python
async def rebuild_strategy_stats(pool: asyncpg.Pool) -> None:
    """
    Full rebuild of strategy_stats from trades table.
    Called nightly by DBWriter. Safe to call at any time — TRUNCATE + INSERT is atomic
    when wrapped in a transaction.
    avg_hold_time_s is the average seconds between the BUY and SELL fill for the same mint.
    """
    sql = """
        BEGIN;

        TRUNCATE TABLE strategy_stats;

        INSERT INTO strategy_stats (
            strategy, total_trades, wins, losses, win_rate,
            total_pnl_usdc, avg_pnl_usdc,
            best_trade_usdc, worst_trade_usdc,
            avg_hold_time_s, updated_at
        )
        SELECT
            sells.strategy,
            COUNT(*)                                            AS total_trades,
            COUNT(*) FILTER (WHERE sells.pnl_usdc > 0)         AS wins,
            COUNT(*) FILTER (WHERE sells.pnl_usdc <= 0)        AS losses,
            ROUND(
                COUNT(*) FILTER (WHERE sells.pnl_usdc > 0)::NUMERIC
                / NULLIF(COUNT(*), 0),
                4
            )                                                   AS win_rate,
            COALESCE(SUM(sells.pnl_usdc), 0)                   AS total_pnl_usdc,
            ROUND(AVG(sells.pnl_usdc), 4)                      AS avg_pnl_usdc,
            MAX(sells.pnl_usdc)                                 AS best_trade_usdc,
            MIN(sells.pnl_usdc)                                 AS worst_trade_usdc,
            AVG(
                EXTRACT(EPOCH FROM (sells.created_at - buys.created_at))
            )::INT                                              AS avg_hold_time_s,
            NOW()                                               AS updated_at
        FROM trades sells
        JOIN trades buys
          ON buys.mint     = sells.mint
         AND buys.side     = 'BUY'
         AND buys.status   = 'confirmed'
         AND buys.created_at < sells.created_at
        WHERE sells.side    = 'SELL'
          AND sells.status  = 'confirmed'
          AND sells.pnl_usdc IS NOT NULL
          AND sells.strategy IS NOT NULL
        GROUP BY sells.strategy;

        COMMIT;
    """
    async with pool.acquire() as conn:
        await conn.execute(sql)
```

---

## Upsert KOL Wallet

Used when Scanner discovers a new wallet or updates an existing one's stats.

```python
async def upsert_kol_wallet(pool: asyncpg.Pool, wallet: dict) -> None:
    """
    Insert or update a KOL wallet.
    On conflict (address already exists), update mutable stats only.
    """
    sql = """
        INSERT INTO kol_wallets (
            address, label, source, win_rate, total_trades,
            avg_trade_usdc, total_pnl_usdc, active, last_seen_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        ON CONFLICT (address) DO UPDATE SET
            label          = EXCLUDED.label,
            win_rate       = EXCLUDED.win_rate,
            total_trades   = EXCLUDED.total_trades,
            avg_trade_usdc = EXCLUDED.avg_trade_usdc,
            total_pnl_usdc = EXCLUDED.total_pnl_usdc,
            active         = EXCLUDED.active,
            last_seen_at   = EXCLUDED.last_seen_at,
            updated_at     = NOW()
    """
    async with pool.acquire() as conn:
        await conn.execute(
            sql,
            wallet["address"],
            wallet.get("label"),
            wallet.get("source", "manual"),
            Decimal(str(wallet["win_rate"])) if wallet.get("win_rate") is not None else None,
            wallet.get("total_trades", 0),
            Decimal(str(wallet["avg_trade_usdc"])) if wallet.get("avg_trade_usdc") is not None else None,
            Decimal(str(wallet["total_pnl_usdc"])) if wallet.get("total_pnl_usdc") is not None else None,
            wallet.get("active", True),
            wallet.get("last_seen_at"),
        )
```

---

## Insert Signal Rejection

```python
async def insert_signal_rejection(pool: asyncpg.Pool, event: dict) -> None:
    """
    Insert a signal rejection event. Called by DBWriter when it receives
    a message on the scanner.safety.rejected Redis pub/sub channel.
    """
    sql = """
        INSERT INTO signal_rejections (
            mint, symbol, strategy, reason, sources, confidence, liquidity_usdc
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    """
    async with pool.acquire() as conn:
        await conn.execute(
            sql,
            event["mint"],
            event.get("symbol"),
            event.get("strategy"),
            event["reason"],
            event.get("sources", []),
            Decimal(str(event["confidence"])) if event.get("confidence") is not None else None,
            Decimal(str(event["liquidity_usdc"])) if event.get("liquidity_usdc") is not None else None,
        )
```

---

## Insert / Upsert Daily Report

```python
async def upsert_daily_report(pool: asyncpg.Pool, report: dict) -> None:
    """
    Insert or replace the daily report for report_date.
    Called by DBWriter at midnight UTC after building the full report dict.
    """
    import json

    sql = """
        INSERT INTO daily_reports (
            report_date, total_trades, win_rate, total_pnl_usdc,
            best_trade_usdc, worst_trade_usdc, strategies_used, report_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (report_date) DO UPDATE SET
            total_trades     = EXCLUDED.total_trades,
            win_rate         = EXCLUDED.win_rate,
            total_pnl_usdc   = EXCLUDED.total_pnl_usdc,
            best_trade_usdc  = EXCLUDED.best_trade_usdc,
            worst_trade_usdc = EXCLUDED.worst_trade_usdc,
            strategies_used  = EXCLUDED.strategies_used,
            report_json      = EXCLUDED.report_json
    """
    async with pool.acquire() as conn:
        await conn.execute(
            sql,
            report["report_date"],
            report["total_trades"],
            Decimal(str(report["win_rate"])) if report.get("win_rate") is not None else None,
            Decimal(str(report["total_pnl_usdc"])),
            Decimal(str(report["best_trade_usdc"])) if report.get("best_trade_usdc") is not None else None,
            Decimal(str(report["worst_trade_usdc"])) if report.get("worst_trade_usdc") is not None else None,
            report.get("strategies_used", []),
            json.dumps(report.get("report_json", {})),
        )
```
