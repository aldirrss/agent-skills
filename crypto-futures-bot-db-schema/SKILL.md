---
name: crypto-futures-bot-db-schema
description: PostgreSQL database schema, SQLModel definitions, and query patterns for crypto futures trading bot web-apps. Use this whenever the user is designing or building any database-related part of a futures trading bot — table design, SQLModel models, async session management, PnL queries, equity curve, win rate, drawdown calculations, Alembic migrations, or any data layer question. Trigger even when the user only mentions one aspect (e.g. "how to store trade history", "query daily PnL", "where to save signal data", "how to track funding payments", "alembic setup for trading bot"). This skill requires crypto-futures-bot-architecture — all table designs follow the component responsibilities defined there.
requires:
  - crypto-futures-bot-architecture
---

# Crypto Futures Bot DB Schema

PostgreSQL + SQLModel (SQLAlchemy async + Pydantic). All tables follow the multi-exchange / multi-account pattern — every table anchors to an `account_id`. API keys are **never stored in the database** — only a reference string that maps to secrets in environment variables or a secret manager.

## Design Principles

**1. account_id on every table** — enables multi-exchange + multi-account from day one without schema migrations later.

**2. Immutable transaction log** — `orders` and `trades` are append-only. Never UPDATE a filled order or a closed trade. If something needs correction, insert a compensating record.

**3. Signals are always recorded** — even discarded ones. A discarded signal with `status='discarded'` and `discard_reason='choppy_regime'` is valuable data for strategy analysis.

**4. API keys never in DB** — `accounts.api_key_ref` is a string like `"BINANCE_MAIN_API_KEY"` that the application resolves against environment variables at runtime.

**5. Decimal for all money** — `NUMERIC(24, 8)` in PostgreSQL, `Decimal` in Python. No float columns for price, PnL, or quantity.

## Table Overview

```
exchanges          → master: Binance, Bybit, OKX
    └── accounts   → per exchange, holds api_key_ref
            └── symbols        → trading pairs per account
            └── workers        → worker config history (active + historical)
            └── bot_sessions   → run history with aggregate PnL
            └── signals        → all signals: executed + discarded
            └── orders         → all exchange orders (entry/SL/TP/emergency)
            └── trades         → completed trades, full PnL breakdown
            └── funding_payments → funding paid/received per trade
            └── pnl_snapshots  → equity snapshots every 15min (equity curve)
```

## SQLModel Setup

```python
# db/engine.py
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker
from sqlmodel import SQLModel

DATABASE_URL = "postgresql+asyncpg://user:pass@localhost:5432/trading_bot"

engine = create_async_engine(
    DATABASE_URL,
    echo=False,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,        # detect stale connections
)

AsyncSessionLocal = sessionmaker(
    engine, class_=AsyncSession,
    expire_on_commit=False,    # keep objects usable after commit
)

async def get_session() -> AsyncSession:
    """FastAPI dependency."""
    async with AsyncSessionLocal() as session:
        yield session

async def create_tables():
    """Call once at startup in dev. Use Alembic in production."""
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
```

## Naming Conventions

```
Tables:     snake_case plural          (trades, pnl_snapshots)
Columns:    snake_case                 (account_id, opened_at)
PKs:        id (integer, autoincrement)
FKs:        {table_singular}_id       (account_id, trade_id)
Timestamps: *_at suffix, always UTC   (opened_at, closed_at, created_at)
Indexes:    idx_{table}_{column(s)}   (idx_trades_account_opened)
Enums:      snake_case string values  ("tp_hit", "sl_hit", "manual_close")
```

All `*_at` columns are `TIMESTAMP WITH TIME ZONE` (stored UTC, displayed in user's TZ by frontend).

## Reference Files

| Building… | Read |
|---|---|
| Raw SQL DDL, CREATE TABLE, indexes | `references/schema-ddl.md` |
| Python SQLModel class definitions | `references/sqlmodel-models.md` |
| PnL queries, win rate, equity curve, drawdown | `references/query-patterns.md` |
| Alembic setup, migration workflow, naming | `references/migration-strategy.md` |

## Quick Self-Check Before Writing DB Code

- [ ] All money columns are `Decimal` / `NUMERIC(24,8)` — no `float`
- [ ] Timestamps are timezone-aware (`datetime` with `timezone=True`)
- [ ] `account_id` present on every non-master table
- [ ] Orders and trades are insert-only (no UPDATE on filled/closed records)
- [ ] API keys not stored — only `api_key_ref` string
- [ ] Every query uses `account_id` in WHERE clause (no cross-account data leak)
- [ ] Indexes exist on (`account_id`, timestamp) for all high-volume tables
