# DB Schema — DDL & Migration

All tables use `CREATE TABLE IF NOT EXISTS` so the migration script is safe to run on every startup.

---

## Table: `trades`

Primary record of every swap fill. One row per BUY fill inserted immediately; the SELL fill updates `pnl_usdc`, `pnl_pct`, `reason`, and `status` on the matching row.

```sql
CREATE TABLE IF NOT EXISTS trades (
    id              BIGSERIAL PRIMARY KEY,
    fill_id         VARCHAR(32)   UNIQUE NOT NULL,   -- idempotency key from Jupiter response
    swap_id         VARCHAR(32)   NOT NULL,           -- internal swap request id
    mint            VARCHAR(44)   NOT NULL,           -- SPL token mint address
    symbol          VARCHAR(20),                      -- token symbol (nullable, filled async)
    side            VARCHAR(4)    NOT NULL,           -- BUY | SELL
    status          VARCHAR(12)   NOT NULL,           -- confirmed | failed | timeout | dry_run
    tx_signature    VARCHAR(88),                      -- Solana tx signature (NULL if failed)
    amount_usdc     NUMERIC(18,6) NOT NULL DEFAULT 0,
    amount_tokens   BIGINT        NOT NULL DEFAULT 0, -- raw token amount (lamports-equivalent)
    price_usdc      NUMERIC(24,12) NOT NULL DEFAULT 0,
    strategy        VARCHAR(32),                      -- strategy that generated the signal
    reason          VARCHAR(32),                      -- take_profit | stop_loss | max_hold_time | emergency_stop
    pnl_usdc        NUMERIC(18,6),                   -- NULL for BUY; populated on SELL
    pnl_pct         NUMERIC(8,4),                    -- NULL for BUY; populated on SELL
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_mint         ON trades (mint);
CREATE INDEX IF NOT EXISTS idx_trades_strategy     ON trades (strategy);
CREATE INDEX IF NOT EXISTS idx_trades_created_at   ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_side_status  ON trades (side, status);
```

**Notes:**
- `fill_id` — built as `f"{swap_id}_{side}_{slot}"` inside Execution component
- `amount_tokens` — raw integer units from Jupiter (no decimal adjustment here; apply decimals in presentation layer)
- `pnl_usdc` — calculated as `sell_amount_usdc - buy_amount_usdc`
- `pnl_pct` — calculated as `(pnl_usdc / buy_amount_usdc) * 100`

---

## Table: `kol_wallets`

Registry of tracked KOL (Key Opinion Leader) wallets. Stats columns are updated after each detected trade from that wallet.

```sql
CREATE TABLE IF NOT EXISTS kol_wallets (
    address         VARCHAR(44)   PRIMARY KEY,        -- Solana wallet public key
    label           VARCHAR(64),                      -- human-readable name (e.g. "whale_001")
    source          VARCHAR(20),                      -- cielo | manual | gmgn
    win_rate        NUMERIC(5,4),                     -- 0.0000 to 1.0000
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
```

**Notes:**
- `win_rate` is recomputed externally from known trade outcomes and upserted — not derived live in-DB
- `last_seen_at` updated every time the Scanner detects this wallet buying a token
- `active = false` — wallet is in registry but not followed for new signals

---

## Table: `signal_rejections`

Every signal that was evaluated but rejected by safety or risk checks. Published by Strategy to `scanner.safety.rejected` Redis channel; DBWriter subscribes and inserts here.

```sql
CREATE TABLE IF NOT EXISTS signal_rejections (
    id              BIGSERIAL PRIMARY KEY,
    mint            VARCHAR(44)   NOT NULL,
    symbol          VARCHAR(20),
    strategy        VARCHAR(32),
    reason          VARCHAR(64)   NOT NULL,           -- safety reject reason code
    sources         TEXT[],                           -- scanner sources at time of reject
    confidence      NUMERIC(5,4),                     -- signal confidence score (0-1)
    liquidity_usdc  NUMERIC(18,2),
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rejections_reason      ON signal_rejections (reason);
CREATE INDEX IF NOT EXISTS idx_rejections_strategy    ON signal_rejections (strategy);
CREATE INDEX IF NOT EXISTS idx_rejections_created_at  ON signal_rejections (created_at DESC);
```

**Reason codes** (matches RiskManager reject constants):
```
low_liquidity           liquidity_usdc below threshold
high_price_impact       Jupiter price impact exceeds max_price_impact_pct
duplicate_position      position already open for this mint
rug_risk                token flagged by safety scanner
max_positions_reached   open position count at limit
low_confidence          signal confidence below min_confidence
honeypot_detected       token fails honeypot check
```

---

## Table: `strategy_stats`

Aggregated per-strategy performance. **Never updated per-trade.** Rebuilt nightly by DBWriter via `TRUNCATE + INSERT ... SELECT` from the `trades` table.

```sql
CREATE TABLE IF NOT EXISTS strategy_stats (
    strategy            VARCHAR(32)   PRIMARY KEY,
    total_trades        INT           NOT NULL DEFAULT 0,
    wins                INT           NOT NULL DEFAULT 0,
    losses              INT           NOT NULL DEFAULT 0,
    win_rate            NUMERIC(5,4),                     -- wins / (wins + losses)
    total_pnl_usdc      NUMERIC(18,2) NOT NULL DEFAULT 0,
    avg_pnl_usdc        NUMERIC(12,4),
    best_trade_usdc     NUMERIC(12,2),
    worst_trade_usdc    NUMERIC(12,2),
    avg_hold_time_s     INT,                              -- average seconds between BUY and SELL
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**Notes:**
- Rebuilt nightly — do not write to this table except inside `rebuild_strategy_stats()`
- `wins` = SELL rows where `pnl_usdc > 0` and `status = 'confirmed'`
- `losses` = SELL rows where `pnl_usdc <= 0` and `status = 'confirmed'`
- `avg_hold_time_s` — computed from BUY `created_at` to SELL `created_at` for matching mint rows

---

## Table: `daily_reports`

One row per calendar day (UTC). Created at EOD (midnight UTC) by DBWriter. Stores a snapshot of key metrics plus a full JSON blob for the dashboard.

```sql
CREATE TABLE IF NOT EXISTS daily_reports (
    report_date         DATE          PRIMARY KEY,
    total_trades        INT           NOT NULL DEFAULT 0,
    win_rate            NUMERIC(5,4),
    total_pnl_usdc      NUMERIC(18,2),
    best_trade_usdc     NUMERIC(12,2),
    worst_trade_usdc    NUMERIC(12,2),
    strategies_used     TEXT[],                           -- distinct strategies that traded
    report_json         JSONB,                            -- full daily summary for dashboard
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

**`report_json` structure:**
```json
{
  "date": "2025-01-15",
  "total_trades": 12,
  "win_rate": 0.6667,
  "total_pnl_usdc": 45.32,
  "best_trade": {"mint": "...", "symbol": "TOKEN", "pnl_usdc": 28.5, "strategy": "kol_copy"},
  "worst_trade": {"mint": "...", "symbol": "RUG", "pnl_usdc": -8.2, "strategy": "momentum_spike"},
  "by_strategy": [
    {"strategy": "kol_copy", "trades": 5, "win_rate": 0.80, "pnl_usdc": 38.1},
    {"strategy": "new_launch_snipe", "trades": 7, "win_rate": 0.57, "pnl_usdc": 7.22}
  ],
  "rejection_count": 34,
  "top_rejection_reason": "low_liquidity"
}
```

---

## Full Migration Script

Run this once at startup (idempotent). Order matters: no foreign keys between tables in this schema, so order is arbitrary — but keep it consistent.

```sql
-- migration_001_initial.sql
-- Safe to run multiple times (IF NOT EXISTS everywhere).

-- 1. trades
CREATE TABLE IF NOT EXISTS trades (
    id              BIGSERIAL PRIMARY KEY,
    fill_id         VARCHAR(32)    UNIQUE NOT NULL,
    swap_id         VARCHAR(32)    NOT NULL,
    mint            VARCHAR(44)    NOT NULL,
    symbol          VARCHAR(20),
    side            VARCHAR(4)     NOT NULL,
    status          VARCHAR(12)    NOT NULL,
    tx_signature    VARCHAR(88),
    amount_usdc     NUMERIC(18,6)  NOT NULL DEFAULT 0,
    amount_tokens   BIGINT         NOT NULL DEFAULT 0,
    price_usdc      NUMERIC(24,12) NOT NULL DEFAULT 0,
    strategy        VARCHAR(32),
    reason          VARCHAR(32),
    pnl_usdc        NUMERIC(18,6),
    pnl_pct         NUMERIC(8,4),
    created_at      TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_mint        ON trades (mint);
CREATE INDEX IF NOT EXISTS idx_trades_strategy    ON trades (strategy);
CREATE INDEX IF NOT EXISTS idx_trades_created_at  ON trades (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_side_status ON trades (side, status);

-- 2. kol_wallets
CREATE TABLE IF NOT EXISTS kol_wallets (
    address         VARCHAR(44)   PRIMARY KEY,
    label           VARCHAR(64),
    source          VARCHAR(20),
    win_rate        NUMERIC(5,4),
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

-- 3. signal_rejections
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

-- 4. strategy_stats
CREATE TABLE IF NOT EXISTS strategy_stats (
    strategy            VARCHAR(32)   PRIMARY KEY,
    total_trades        INT           NOT NULL DEFAULT 0,
    wins                INT           NOT NULL DEFAULT 0,
    losses              INT           NOT NULL DEFAULT 0,
    win_rate            NUMERIC(5,4),
    total_pnl_usdc      NUMERIC(18,2) NOT NULL DEFAULT 0,
    avg_pnl_usdc        NUMERIC(12,4),
    best_trade_usdc     NUMERIC(12,2),
    worst_trade_usdc    NUMERIC(12,2),
    avg_hold_time_s     INT,
    updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- 5. daily_reports
CREATE TABLE IF NOT EXISTS daily_reports (
    report_date         DATE          PRIMARY KEY,
    total_trades        INT           NOT NULL DEFAULT 0,
    win_rate            NUMERIC(5,4),
    total_pnl_usdc      NUMERIC(18,2),
    best_trade_usdc     NUMERIC(12,2),
    worst_trade_usdc    NUMERIC(12,2),
    strategies_used     TEXT[],
    report_json         JSONB,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

### Running migrations from Python (asyncpg)

```python
# db/migrate.py
import asyncpg
from pathlib import Path


async def run_migrations(pool: asyncpg.Pool) -> None:
    """Run all migration files in order. Safe to run on every startup."""
    migrations_dir = Path(__file__).parent / "migrations"
    sql_files = sorted(migrations_dir.glob("migration_*.sql"))

    async with pool.acquire() as conn:
        for sql_file in sql_files:
            sql = sql_file.read_text()
            await conn.execute(sql)
```
