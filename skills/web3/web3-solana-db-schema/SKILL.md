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

**1. fill_id as idempotency key** — every write to `trades` uses `fill_id` (derived from the Jupiter swap response) as a UNIQUE key. Duplicate fills from crash recovery never create duplicate rows.

**2. BUY and SELL are separate rows** — a BUY fill inserts a new row. The matching SELL fill updates that row's PnL columns. `pnl_usdc` and `pnl_pct` are NULL until the SELL is confirmed.

**3. All fills are recorded** — `status` column captures `confirmed`, `failed`, `timeout`, and `dry_run`. Failed swaps are inserted so the rejection analysis is complete.

**4. Signal rejections are written by DBWriter** — strategy publishes to `scanner.safety.rejected` pub/sub, DBWriter subscribes and inserts to `signal_rejections`. This keeps rejection data without coupling Strategy to DB.

**5. `strategy_stats` is rebuilt nightly** — it is not updated per-trade. DBWriter runs a nightly `TRUNCATE + INSERT ... SELECT` to rebuild it from the `trades` table. This is simpler and avoids counter drift from failed updates.

**6. Decimal for all money** — `NUMERIC` in PostgreSQL, never `float`. asyncpg maps `NUMERIC` to Python `Decimal` automatically.

## Table Overview

```
trades             → every BUY and SELL fill, PnL calculated on SELL
kol_wallets        → KOL wallet registry with aggregated performance stats
signal_rejections  → log of every signal rejected by safety checks
strategy_stats     → per-strategy aggregated stats, rebuilt nightly
daily_reports      → one row per day, EOD summary JSON
```

## Tech Stack

- **asyncpg** — async PostgreSQL driver, raw SQL only (no SQLAlchemy, no ORM)
- **Raw SQL migrations** — `CREATE TABLE IF NOT EXISTS`, no Alembic
- **Connection pool** — `asyncpg.create_pool(min_size=1, max_size=5)`
- **NUMERIC everywhere** — never `FLOAT` for money columns
- **ON CONFLICT DO UPDATE** — used for kol_wallets upserts and strategy_stats
- **TIMESTAMPTZ** — all timestamps stored in UTC

## Reference Files

| Building...                                        | Read                        |
|----------------------------------------------------|-----------------------------|
| DDL for all 5 tables, indexes, migration script   | `references/schema.md`      |
| asyncpg query functions for all common operations | `references/queries.md`     |
| DBWriter integration, PnL pairing, nightly rebuild | `references/dbwriter.md`   |

## Quick Self-Check Before Writing DB Code

- [ ] All money columns are `NUMERIC`, never `float`
- [ ] All timestamps are `TIMESTAMPTZ` (UTC)
- [ ] BUY inserts new row; SELL updates existing row for same mint
- [ ] `fill_id` used as idempotency key on INSERT
- [ ] Failed/timeout fills still inserted (status captures outcome)
- [ ] `strategy_stats` rebuilt from scratch nightly — do not UPDATE per-trade
- [ ] Connection pool max=5 — do not raise without load testing
- [ ] All queries use `async with pool.acquire() as conn:`
