---
name: web3-solana-db-schema
description: PostgreSQL database schema for Solana DEX trading bot — trades table, KOL wallet registry, signal rejection log, strategy performance stats, and daily reports. Use this whenever the user is setting up the database, writing migrations, querying trade history, calculating win rates, analyzing strategy performance, or building the DBWriter component. Trigger when the user mentions "database schema", "trades table", "win rate query", "PnL history", "strategy stats", "KOL wallet performance", or "signal rejection log".
requires:
  - web3-solana
  - web3-solana-architecture
---

# Web3 Solana DB Schema

PostgreSQL + asyncpg (raw SQL, no ORM). All queries are async. Schema is designed for a single-bot, single-wallet Solana DEX trading bot that trades SPL tokens via Jupiter swap.

## Design Principles

**1. fill_id as idempotency key** — every write to `trades` uses `fill_id` as a UNIQUE key. Duplicate fills from crash recovery never create duplicate rows.

**2. BUY and SELL are separate rows** — a BUY fill inserts a new row. The matching SELL fill updates that row's PnL columns. `pnl_usdc` and `pnl_pct` are NULL until the SELL is confirmed.

**3. All fills are recorded** — `status` captures `confirmed`, `failed`, `timeout`, and `dry_run`. Failed swaps are still inserted so rejection analysis is complete.

**4. Signal rejections are written by DBWriter** — Strategy publishes to `scanner.safety.rejected` pub/sub; DBWriter subscribes and inserts to `signal_rejections`. This keeps rejection data without coupling Strategy to DB.

**5. `strategy_stats` is rebuilt nightly** — `TRUNCATE + INSERT ... SELECT` from `trades` table each midnight. Never update per-trade — avoids counter drift from failed updates.

**6. Decimal for all money** — `NUMERIC` in PostgreSQL, never `FLOAT`. asyncpg maps `NUMERIC` to Python `Decimal` automatically.

## Table Overview

```
trades             → every BUY and SELL fill, PnL calculated on SELL
kol_wallets        → KOL wallet registry with aggregated performance stats
signal_rejections  → log of every signal rejected by safety/risk checks
strategy_stats     → per-strategy aggregated stats, rebuilt nightly
daily_reports      → one row per day, EOD summary JSON
```

## Core Table: `trades`

```sql
CREATE TABLE IF NOT EXISTS trades (
    id              BIGSERIAL PRIMARY KEY,
    fill_id         VARCHAR(32)    UNIQUE NOT NULL,   -- idempotency key (fill_{swap_id}_{side})
    swap_id         VARCHAR(32)    NOT NULL,
    mint            VARCHAR(44)    NOT NULL,           -- SPL token mint address
    symbol          VARCHAR(20),
    side            VARCHAR(4)     NOT NULL,           -- BUY | SELL
    status          VARCHAR(12)    NOT NULL,           -- confirmed | failed | timeout | dry_run
    tx_signature    VARCHAR(88),                       -- NULL if not submitted
    amount_usdc     NUMERIC(18,6)  NOT NULL DEFAULT 0,
    amount_tokens   BIGINT         NOT NULL DEFAULT 0, -- raw token units (smallest denomination)
    price_usdc      NUMERIC(24,12) NOT NULL DEFAULT 0,
    strategy        VARCHAR(32),
    reason          VARCHAR(32),                       -- take_profit | stop_loss | max_hold_time | emergency_stop
    pnl_usdc        NUMERIC(18,6),                    -- NULL for BUY; populated on matching SELL
    pnl_pct         NUMERIC(8,4),                     -- NULL for BUY; populated on matching SELL
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_mint         ON trades (mint);
CREATE INDEX IF NOT EXISTS idx_trades_strategy     ON trades (strategy);
CREATE INDEX IF NOT EXISTS idx_trades_created_at   ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_side_status  ON trades (side, status);
```

**Why these four indexes:** `mint` for per-token history lookups; `strategy` for win rate queries; `created_at DESC` for time-range reports; `(side, status)` for aggregate stats that filter on both columns together.

## PnL Calculation Formula

PnL is calculated at SELL time and stored on the SELL row:

```python
# In DBWriter, when processing a SELL fill:
buy_row = await conn.fetchrow(
    "SELECT amount_usdc FROM trades WHERE mint = $1 AND side = 'BUY' AND status = 'confirmed' "
    "ORDER BY created_at DESC LIMIT 1",
    mint
)
buy_amount = Decimal(str(buy_row["amount_usdc"]))
sell_amount = Decimal(fill["amount_usdc"])

pnl_usdc = sell_amount - buy_amount
pnl_pct  = (pnl_usdc / buy_amount * 100) if buy_amount > 0 else Decimal("0")
```

`pnl_usdc` = `sell_amount_usdc - buy_amount_usdc`. Does NOT subtract transaction fees — Jupiter fees are embedded in the effective price already. Keep it simple: USDC in vs USDC out.

## Schema for All 5 Tables

```sql
-- kol_wallets
CREATE TABLE IF NOT EXISTS kol_wallets (
    address         VARCHAR(44)   PRIMARY KEY,
    label           VARCHAR(64),
    source          VARCHAR(20),                       -- cielo | manual | gmgn
    win_rate        NUMERIC(5,4),                      -- 0.0000 to 1.0000
    total_trades    INT           NOT NULL DEFAULT 0,
    avg_trade_usdc  NUMERIC(12,2),
    total_pnl_usdc  NUMERIC(18,2),
    active          BOOLEAN       NOT NULL DEFAULT true,
    last_seen_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kol_wallets_active   ON kol_wallets (active);
CREATE INDEX IF NOT EXISTS idx_kol_wallets_win_rate ON kol_wallets (win_rate DESC NULLS LAST);

-- signal_rejections
CREATE TABLE IF NOT EXISTS signal_rejections (
    id              BIGSERIAL PRIMARY KEY,
    mint            VARCHAR(44)   NOT NULL,
    symbol          VARCHAR(20),
    strategy        VARCHAR(32),
    reason          VARCHAR(64)   NOT NULL,
    sources         TEXT[],
    confidence      NUMERIC(5,4),
    liquidity_usdc  NUMERIC(18,2),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rejections_reason     ON signal_rejections (reason);
CREATE INDEX IF NOT EXISTS idx_rejections_strategy   ON signal_rejections (strategy);
CREATE INDEX IF NOT EXISTS idx_rejections_created_at ON signal_rejections (created_at DESC);

-- strategy_stats (rebuilt nightly, never updated per-trade)
CREATE TABLE IF NOT EXISTS strategy_stats (
    strategy         VARCHAR(32)   PRIMARY KEY,
    total_trades     INT           NOT NULL DEFAULT 0,
    wins             INT           NOT NULL DEFAULT 0,
    losses           INT           NOT NULL DEFAULT 0,
    win_rate         NUMERIC(5,4),
    total_pnl_usdc   NUMERIC(18,2) NOT NULL DEFAULT 0,
    avg_pnl_usdc     NUMERIC(12,4),
    best_trade_usdc  NUMERIC(12,2),
    worst_trade_usdc NUMERIC(12,2),
    avg_hold_time_s  INT,
    updated_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- daily_reports
CREATE TABLE IF NOT EXISTS daily_reports (
    report_date      DATE          PRIMARY KEY,
    total_trades     INT           NOT NULL DEFAULT 0,
    win_rate         NUMERIC(5,4),
    total_pnl_usdc   NUMERIC(18,2),
    best_trade_usdc  NUMERIC(12,2),
    worst_trade_usdc NUMERIC(12,2),
    strategies_used  TEXT[],
    report_json      JSONB,
    created_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

## Migration Strategy for a Live Bot

Because the bot cannot stop trading between schema changes, follow these rules:

**Safe at any time (zero downtime):**
- `CREATE TABLE IF NOT EXISTS` — new tables are invisible to existing queries
- `CREATE INDEX CONCURRENTLY` — builds index without locking the table
- Adding a **nullable column**: `ALTER TABLE trades ADD COLUMN new_col TEXT` — existing rows get NULL

**Requires maintenance window (brief, <1s for this schema size):**
- Adding a `NOT NULL` column without a default — add as nullable first, backfill, then add constraint
- Renaming a column — coordinate with code deploy

**Never do on a running bot:**
- `DROP COLUMN` — get code deployed first, then drop
- Changing `NUMERIC` precision on money columns — always widen, never narrow

**Migration file pattern:** Name files `migration_001_initial.sql`, `migration_002_add_X.sql` etc. Run at startup via `asyncpg` — `CREATE TABLE IF NOT EXISTS` makes it idempotent.

## Tech Stack

- **asyncpg** — async PostgreSQL driver, raw SQL only (no SQLAlchemy, no ORM)
- **Raw SQL migrations** — `CREATE TABLE IF NOT EXISTS`, no Alembic
- **Connection pool** — `asyncpg.create_pool(min_size=1, max_size=5)`
- **NUMERIC everywhere** — never `FLOAT` for money columns
- **ON CONFLICT DO UPDATE** — used for `kol_wallets` upserts
- **TIMESTAMPTZ** — all timestamps stored in UTC

## Quick Self-Check Before Writing DB Code

- [ ] All money columns are `NUMERIC`, never `float`
- [ ] All timestamps are `TIMESTAMPTZ` (UTC)
- [ ] BUY inserts new row; SELL updates `pnl_usdc` / `pnl_pct` on existing BUY row for same mint
- [ ] `fill_id` used as idempotency key on INSERT (`ON CONFLICT DO NOTHING` or `UNIQUE`)
- [ ] Failed/timeout fills still inserted — `status` column captures outcome
- [ ] `strategy_stats` rebuilt from scratch nightly — never `UPDATE` per-trade
- [ ] New `NOT NULL` columns added as nullable first, then backfilled, then constrained
- [ ] Connection pool max=5 — do not raise without load testing
- [ ] All queries use `async with pool.acquire() as conn:`
- [ ] `pnl_usdc = sell_amount_usdc - buy_amount_usdc` — no fee adjustment

## Reference Files

| Building...                                        | Read                        |
|----------------------------------------------------|-----------------------------|
| DDL for all 5 tables, indexes, full migration script | `references/schema.md`    |
| asyncpg query functions for all common operations  | `references/queries.md`     |
| DBWriter integration, PnL pairing, nightly rebuild | `references/dbwriter.md`   |
