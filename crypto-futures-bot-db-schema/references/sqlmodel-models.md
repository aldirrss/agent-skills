# SQLModel Models

Python class definitions for all tables. One class = DB table + Pydantic schema.

## Table of contents
- Base class & imports
- Enums
- Master tables (Exchange, Account, Symbol)
- Operational tables (Worker, BotSession)
- Transaction tables (Signal, Order, Trade)
- Supporting tables (FundingPayment, PnlSnapshot)
- CRUD helpers

---

## Base class & imports

```python
# db/models/__init__.py
from __future__ import annotations
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum
from typing import Optional
import json

from sqlalchemy import Column, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel


def utcnow() -> datetime:
    return datetime.now(timezone.utc)
```

---

## Enums

```python
# db/enums.py
from enum import Enum

class ExchangeName(str, Enum):
    BINANCE = "binance"
    BYBIT   = "bybit"
    OKX     = "okx"
    BITGET  = "bitget"

class WorkerStatus(str, Enum):
    ACTIVE  = "active"
    PAUSED  = "paused"
    STOPPED = "stopped"
    CRASHED = "crashed"

class SignalStatus(str, Enum):
    EXECUTED        = "executed"
    DISCARDED       = "discarded"
    REJECTED_RISK   = "rejected_risk"
    REJECTED_FILTER = "rejected_filter"

class TradeDirection(str, Enum):
    LONG  = "long"
    SHORT = "short"

class OrderType(str, Enum):
    MARKET               = "market"
    LIMIT                = "limit"
    STOP_MARKET          = "stop_market"
    STOP_LIMIT           = "stop_limit"
    TAKE_PROFIT_MARKET   = "take_profit_market"
    TAKE_PROFIT_LIMIT    = "take_profit_limit"

class OrderRole(str, Enum):
    ENTRY           = "entry"
    SL              = "sl"
    TP              = "tp"
    EMERGENCY_CLOSE = "emergency_close"
    MANUAL_CLOSE    = "manual_close"

class OrderStatus(str, Enum):
    OPEN             = "open"
    FILLED           = "filled"
    PARTIALLY_FILLED = "partially_filled"
    CANCELLED        = "cancelled"
    REJECTED         = "rejected"
    FAILED           = "failed"

class TradeOutcome(str, Enum):
    TP_HIT          = "tp_hit"
    SL_HIT          = "sl_hit"
    MANUAL_CLOSE    = "manual_close"
    EMERGENCY_CLOSE = "emergency_close"
    LIQUIDATED      = "liquidated"
    UNKNOWN         = "unknown"

class SessionStopReason(str, Enum):
    MANUAL          = "manual"
    EMERGENCY_STOP  = "emergency_stop"
    CRASH           = "crash"
    CIRCUIT_BREAKER = "circuit_breaker"
    SCHEDULED       = "scheduled"
```

---

## Master tables

```python
# db/models/exchange.py
class Exchange(SQLModel, table=True):
    __tablename__ = "exchanges"

    id:           Optional[int]  = Field(default=None, primary_key=True)
    name:         ExchangeName   = Field(sa_column_kwargs={"unique": True})
    display_name: str            = Field(max_length=50)
    base_url:     str            = Field(max_length=200)
    ws_url:       str            = Field(max_length=200)
    is_testnet:   bool           = Field(default=False)
    created_at:   datetime       = Field(default_factory=utcnow)

    accounts:     list["Account"] = Relationship(back_populates="exchange")


class Account(SQLModel, table=True):
    __tablename__ = "accounts"

    id:          Optional[int] = Field(default=None, primary_key=True)
    exchange_id: int           = Field(foreign_key="exchanges.id", index=True)
    name:        str           = Field(max_length=100)
    api_key_ref: str           = Field(max_length=100)  # env var name, NOT the key
    is_active:   bool          = Field(default=True)
    is_testnet:  bool          = Field(default=False)
    created_at:  datetime      = Field(default_factory=utcnow)

    exchange:    Exchange       = Relationship(back_populates="accounts")
    workers:     list["Worker"]       = Relationship(back_populates="account")
    trades:      list["Trade"]        = Relationship(back_populates="account")
    signals:     list["Signal"]       = Relationship(back_populates="account")

    def resolve_api_key(self) -> str:
        """Resolve api_key_ref to actual key from environment."""
        import os
        key = os.getenv(self.api_key_ref)
        if not key:
            raise EnvironmentError(
                f"API key not configured for account '{self.name}'"
            )
        return key


class Symbol(SQLModel, table=True):
    __tablename__ = "symbols"

    id:          Optional[int] = Field(default=None, primary_key=True)
    account_id:  int           = Field(foreign_key="accounts.id", index=True)
    symbol:      str           = Field(max_length=20)
    base_asset:  str           = Field(max_length=10)
    quote_asset: str           = Field(max_length=10)
    is_active:   bool          = Field(default=True)
    created_at:  datetime      = Field(default_factory=utcnow)
```

---

## Operational tables

```python
class Worker(SQLModel, table=True):
    __tablename__ = "workers"

    id:          Optional[int]   = Field(default=None, primary_key=True)
    account_id:  int             = Field(foreign_key="accounts.id", index=True)
    symbol:      str             = Field(max_length=20)
    strategy:    str             = Field(max_length=50)
    leverage:    int             = Field(ge=1, le=20)
    risk_pct:    Decimal         = Field(max_digits=6, decimal_places=4)
    timeframe:   str             = Field(max_length=10)
    status:      WorkerStatus    = Field(default=WorkerStatus.ACTIVE)
    config:      dict            = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'"))
    )
    started_at:  datetime        = Field(default_factory=utcnow)
    stopped_at:  Optional[datetime] = None
    stop_reason: Optional[str]   = Field(default=None, max_length=200)
    created_at:  datetime        = Field(default_factory=utcnow)

    account:     Account         = Relationship(back_populates="workers")
    signals:     list["Signal"]  = Relationship(back_populates="worker")
    trades:      list["Trade"]   = Relationship(back_populates="worker")


class BotSession(SQLModel, table=True):
    __tablename__ = "bot_sessions"

    id:             Optional[int]          = Field(default=None, primary_key=True)
    account_id:     int                    = Field(foreign_key="accounts.id", index=True)
    started_at:     datetime               = Field(default_factory=utcnow)
    stopped_at:     Optional[datetime]     = None
    stop_reason:    Optional[SessionStopReason] = None
    total_trades:   int                    = Field(default=0)
    winning_trades: int                    = Field(default=0)
    total_pnl:      Decimal                = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    created_at:     datetime               = Field(default_factory=utcnow)
```

---

## Transaction tables

```python
class Signal(SQLModel, table=True):
    __tablename__ = "signals"

    id:                  Optional[int]   = Field(default=None, primary_key=True)
    account_id:          int             = Field(foreign_key="accounts.id", index=True)
    worker_id:           Optional[int]   = Field(default=None, foreign_key="workers.id")
    symbol:              str             = Field(max_length=20)
    strategy:            str             = Field(max_length=50)
    direction:           TradeDirection
    confidence:          Decimal         = Field(max_digits=5, decimal_places=4)
    entry_price:         Decimal         = Field(max_digits=24, decimal_places=8)
    atr:                 Decimal         = Field(max_digits=24, decimal_places=8)
    regime:              str             = Field(max_length=30)
    confluence_score:    int
    confluence_details:  dict            = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'"))
    )
    llm_score:           Optional[Decimal] = Field(default=None, max_digits=5, decimal_places=4)
    llm_direction:       Optional[str]   = Field(default=None, max_length=10)
    status:              SignalStatus
    discard_reason:      Optional[str]   = Field(default=None, max_length=200)
    signal_ts:           datetime
    created_at:          datetime        = Field(default_factory=utcnow)

    account:             Account         = Relationship(back_populates="signals")
    worker:              Optional[Worker] = Relationship(back_populates="signals")
    trade:               Optional["Trade"] = Relationship(back_populates="signal")


class Order(SQLModel, table=True):
    __tablename__ = "orders"

    id:                Optional[int]    = Field(default=None, primary_key=True)
    account_id:        int              = Field(foreign_key="accounts.id", index=True)
    trade_id:          Optional[int]    = Field(default=None, foreign_key="trades.id")
    signal_id:         Optional[int]    = Field(default=None, foreign_key="signals.id")
    exchange_order_id: str              = Field(max_length=100)
    symbol:            str              = Field(max_length=20)
    direction:         TradeDirection
    order_type:        OrderType
    role:              OrderRole
    side:              str              = Field(max_length=5)  # "buy" | "sell"
    qty_requested:     Decimal          = Field(max_digits=24, decimal_places=8)
    qty_filled:        Decimal          = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    price_requested:   Optional[Decimal] = Field(default=None, max_digits=24, decimal_places=8)
    avg_fill_price:    Optional[Decimal] = Field(default=None, max_digits=24, decimal_places=8)
    fee:               Decimal          = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    fee_asset:         str              = Field(default="USDT", max_length=10)
    reduce_only:       bool             = Field(default=False)
    status:            OrderStatus      = Field(default=OrderStatus.OPEN)
    placed_at:         datetime         = Field(default_factory=utcnow)
    filled_at:         Optional[datetime] = None
    created_at:        datetime         = Field(default_factory=utcnow)


class Trade(SQLModel, table=True):
    __tablename__ = "trades"

    id:              Optional[int]      = Field(default=None, primary_key=True)
    account_id:      int                = Field(foreign_key="accounts.id", index=True)
    worker_id:       Optional[int]      = Field(default=None, foreign_key="workers.id")
    signal_id:       Optional[int]      = Field(default=None, foreign_key="signals.id")
    entry_order_id:  Optional[int]      = Field(default=None, foreign_key="orders.id")
    exit_order_id:   Optional[int]      = Field(default=None, foreign_key="orders.id")
    symbol:          str                = Field(max_length=20)
    strategy:        str                = Field(max_length=50)
    direction:       TradeDirection
    qty:             Decimal            = Field(max_digits=24, decimal_places=8)
    entry_price:     Decimal            = Field(max_digits=24, decimal_places=8)
    exit_price:      Optional[Decimal]  = Field(default=None, max_digits=24, decimal_places=8)
    sl_price:        Decimal            = Field(max_digits=24, decimal_places=8)
    tp_price:        Optional[Decimal]  = Field(default=None, max_digits=24, decimal_places=8)
    gross_pnl:       Optional[Decimal]  = Field(default=None, max_digits=24, decimal_places=8)
    fee_total:       Decimal            = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    funding_total:   Decimal            = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    net_pnl:         Optional[Decimal]  = Field(default=None, max_digits=24, decimal_places=8)
    pnl_pct:         Optional[Decimal]  = Field(default=None, max_digits=10, decimal_places=6)
    r_multiple:      Optional[Decimal]  = Field(default=None, max_digits=10, decimal_places=4)
    outcome:         Optional[TradeOutcome] = None
    leverage:        int                = Field(ge=1, le=20)
    risk_pct:        Decimal            = Field(max_digits=6, decimal_places=4)
    initial_risk:    Decimal            = Field(max_digits=24, decimal_places=8)
    duration_seconds: Optional[int]    = None
    opened_at:       datetime           = Field(default_factory=utcnow)
    closed_at:       Optional[datetime] = None
    created_at:      datetime           = Field(default_factory=utcnow)

    account:          Account           = Relationship(back_populates="trades")
    worker:           Optional[Worker]  = Relationship(back_populates="trades")
    signal:           Optional[Signal]  = Relationship(back_populates="trade")
    funding_payments: list["FundingPayment"] = Relationship(back_populates="trade")
```

---

## Supporting tables

```python
class FundingPayment(SQLModel, table=True):
    __tablename__ = "funding_payments"

    id:         Optional[int] = Field(default=None, primary_key=True)
    account_id: int           = Field(foreign_key="accounts.id", index=True)
    trade_id:   int           = Field(foreign_key="trades.id", index=True)
    symbol:     str           = Field(max_length=20)
    amount:     Decimal       = Field(max_digits=24, decimal_places=8)  # +received, -paid
    rate:       Decimal       = Field(max_digits=12, decimal_places=8)
    payment_ts: datetime
    created_at: datetime      = Field(default_factory=utcnow)

    trade:      Trade         = Relationship(back_populates="funding_payments")


class PnlSnapshot(SQLModel, table=True):
    __tablename__ = "pnl_snapshots"

    id:                   Optional[int] = Field(default=None, primary_key=True)
    account_id:           int           = Field(foreign_key="accounts.id", index=True)
    equity:               Decimal       = Field(max_digits=24, decimal_places=8)
    available_balance:    Decimal       = Field(max_digits=24, decimal_places=8)
    unrealized_pnl:       Decimal       = Field(default=Decimal("0"), max_digits=24, decimal_places=8)
    open_positions_count: int           = Field(default=0)
    snapshot_ts:          datetime      # rounded to 15min interval
    created_at:           datetime      = Field(default_factory=utcnow)
```

---

## CRUD helpers

```python
# db/crud/trades.py
from sqlalchemy.ext.asyncio import AsyncSession
from sqlmodel import select

async def get_open_trades(session: AsyncSession, account_id: int) -> list[Trade]:
    result = await session.exec(
        select(Trade)
        .where(Trade.account_id == account_id)
        .where(Trade.closed_at == None)   # noqa: E711
        .order_by(Trade.opened_at.desc())
    )
    return result.all()

async def close_trade(session: AsyncSession, trade_id: int,
                       exit_order: Order, outcome: TradeOutcome) -> Trade:
    trade = await session.get(Trade, trade_id)
    if not trade or trade.closed_at:
        raise ValueError(f"Trade {trade_id} not found or already closed")

    trade.exit_order_id   = exit_order.id
    trade.exit_price      = exit_order.avg_fill_price
    trade.outcome         = outcome
    trade.closed_at       = utcnow()
    trade.duration_seconds = int((trade.closed_at - trade.opened_at).total_seconds())

    # PnL calculation
    sign = Decimal("1") if trade.direction == TradeDirection.LONG else Decimal("-1")
    trade.gross_pnl    = sign * (trade.exit_price - trade.entry_price) * trade.qty
    trade.fee_total   += exit_order.fee
    trade.net_pnl      = trade.gross_pnl - trade.fee_total - trade.funding_total
    notional           = trade.entry_price * trade.qty
    trade.pnl_pct      = trade.net_pnl / notional if notional else Decimal("0")
    trade.r_multiple   = trade.net_pnl / trade.initial_risk if trade.initial_risk else None

    session.add(trade)
    await session.commit()
    await session.refresh(trade)
    return trade
```
