# FastAPI Bridge Server

Separate process from the bot engine. Reads Redis state and PostgreSQL, relays
Redis pub/sub to browser via WebSocket.

## Directory Layout

```
dashboard-api/
├── main.py           ← FastAPI app, lifespan, router mount
├── config.py         ← Settings (pydantic-settings)
├── deps.py           ← Redis + PostgreSQL dependency injection
├── ws.py             ← WebSocket relay (Redis pub/sub → browser)
├── routers/
│   ├── positions.py  ← GET /api/positions
│   ├── bot.py        ← GET /api/bot/status, POST /api/bot/command
│   ├── trades.py     ← GET /api/trades
│   ├── metrics.py    ← GET /api/metrics/performance, /strategy
│   └── wallets.py    ← GET /api/wallets/kol, GET /api/rejections
└── .env
```

---

## main.py

```python
# dashboard-api/main.py

from contextlib import asynccontextmanager
import asyncio

import redis.asyncio as aioredis
import asyncpg
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from loguru import logger

from config import Settings
from routers import positions, bot, trades, metrics, wallets
from ws import websocket_endpoint


settings = Settings()
_redis: aioredis.Redis | None = None
_pg_pool: asyncpg.Pool | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _redis, _pg_pool
    _redis   = aioredis.from_url(settings.redis_url, decode_responses=True)
    _pg_pool = await asyncpg.create_pool(settings.database_url, min_size=2, max_size=10)
    logger.info("Dashboard API started")
    yield
    await _redis.aclose()
    await _pg_pool.close()


app = FastAPI(title="Solana Bot Dashboard API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(positions.router, prefix="/api")
app.include_router(bot.router,       prefix="/api")
app.include_router(trades.router,    prefix="/api")
app.include_router(metrics.router,   prefix="/api")
app.include_router(wallets.router,   prefix="/api")

app.add_api_websocket_route("/ws", websocket_endpoint)
```

---

## deps.py

```python
# dashboard-api/deps.py

from fastapi import Request
import redis.asyncio as aioredis
import asyncpg


def get_redis(request: Request) -> aioredis.Redis:
    return request.app.state.redis   # set in lifespan via app.state


def get_pg(request: Request) -> asyncpg.Pool:
    return request.app.state.pg_pool
```

---

## ws.py — WebSocket Relay

Subscribes to Redis pub/sub channels and broadcasts to all connected browser clients.

```python
# dashboard-api/ws.py

import asyncio
import json
from typing import Any

import redis.asyncio as aioredis
from fastapi import WebSocket, WebSocketDisconnect
from loguru import logger


PUBSUB_CHANNELS = ["position.updates", "bot.status"]

# Connected browser clients
_clients: set[WebSocket] = set()


async def websocket_endpoint(websocket: WebSocket, redis: aioredis.Redis):
    await websocket.accept()
    _clients.add(websocket)
    logger.debug("WS client connected, total={}", len(_clients))

    try:
        # Keep connection alive — client sends ping, we ignore
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _clients.discard(websocket)
        logger.debug("WS client disconnected, total={}", len(_clients))


async def _broadcast(message: dict) -> None:
    dead: set[WebSocket] = set()
    payload = json.dumps(message)
    for ws in _clients:
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    _clients.difference_update(dead)


async def pubsub_relay(redis: aioredis.Redis) -> None:
    """
    Background task: subscribes to Redis pub/sub and broadcasts to WS clients.
    Start this in lifespan alongside the FastAPI server.
    """
    pubsub = redis.pubsub()
    await pubsub.subscribe(*PUBSUB_CHANNELS)
    logger.info("PubSub relay subscribed to {}", PUBSUB_CHANNELS)

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue
        try:
            data = json.loads(message["data"])
            channel = message["channel"]

            # Normalize channel name to event type
            data["type"] = channel.replace(".", "_")
            await _broadcast(data)
        except Exception as exc:
            logger.warning("pubsub relay error: {}", exc)
```

---

## routers/positions.py

```python
# dashboard-api/routers/positions.py

import json
from decimal import Decimal

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends

from deps import get_redis

router = APIRouter()


@router.get("/positions")
async def list_positions(redis: aioredis.Redis = Depends(get_redis)):
    """
    Return all open positions from Redis state.position.* keys.
    Enriches each position with current price from state.price.{mint}.
    """
    keys = await redis.keys("state.position.*")
    if not keys:
        return []

    pipe = redis.pipeline()
    for key in keys:
        pipe.get(key)
    raw_positions = await pipe.execute()

    results = []
    for raw in raw_positions:
        if not raw:
            continue
        pos = json.loads(raw)
        mint = pos["mint"]

        # Enrich with current price
        price_raw = await redis.get(f"state.price.{mint}")
        if price_raw:
            price_data    = json.loads(price_raw)
            current_price = Decimal(str(price_data.get("price_usd", 0)))
            entry_price   = Decimal(pos["entry_price"])
            amount_tokens = Decimal(pos.get("amount_tokens", 0))
            amount_usdc   = Decimal(pos.get("amount_usdc_in", 0))

            if entry_price > 0 and amount_usdc > 0:
                current_value = current_price * amount_tokens
                pnl_usdc = current_value - amount_usdc
                pnl_pct  = float(pnl_usdc / amount_usdc * 100)
            else:
                pnl_usdc = Decimal("0")
                pnl_pct  = 0.0

            pos["current_price"] = str(current_price)
            pos["pnl_usdc"]      = str(round(pnl_usdc, 4))
            pos["pnl_pct"]       = round(pnl_pct, 2)

        results.append(pos)

    return results
```

---

## routers/bot.py

```python
# dashboard-api/routers/bot.py

import json
import time

import redis.asyncio as aioredis
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from deps import get_redis

router = APIRouter()

ALLOWED_COMMANDS = {"START", "STOP", "PAUSE", "RESUME", "EMERGENCY_STOP"}


class CommandRequest(BaseModel):
    cmd: str


@router.get("/bot/status")
async def bot_status(redis: aioredis.Redis = Depends(get_redis)):
    status          = await redis.get("state.bot.status") or "unknown"
    circuit_breaker = await redis.get("state.circuit_breaker") or "closed"
    daily_loss_pct  = await redis.get("state.daily_loss_pct") or "0"
    open_positions  = await redis.get("state.open_positions_count") or "0"

    return {
        "status":           status,
        "circuit_breaker":  circuit_breaker,
        "daily_loss_pct":   float(daily_loss_pct),
        "open_positions":   int(open_positions),
    }


@router.post("/bot/command")
async def send_command(
    body: CommandRequest,
    redis: aioredis.Redis = Depends(get_redis),
):
    if body.cmd not in ALLOWED_COMMANDS:
        raise HTTPException(status_code=400, detail=f"Unknown command: {body.cmd}")

    await redis.xadd("stream.commands", {
        "cmd":     body.cmd,
        "payload": "{}",
        "ts":      str(int(time.time() * 1000)),
    })
    return {"queued": True, "cmd": body.cmd}
```

---

## routers/trades.py

```python
# dashboard-api/routers/trades.py

from typing import Optional

import asyncpg
from fastapi import APIRouter, Depends, Query

from deps import get_pg

router = APIRouter()


@router.get("/trades")
async def list_trades(
    page:     int            = Query(1, ge=1),
    limit:    int            = Query(50, ge=1, le=200),
    strategy: Optional[str] = Query(None),
    side:     Optional[str] = Query(None),
    pg: asyncpg.Pool = Depends(get_pg),
):
    offset     = (page - 1) * limit
    conditions = ["side = 'SELL'", "status = 'confirmed'", "pnl_usdc IS NOT NULL"]
    params: list = []

    if strategy:
        params.append(strategy)
        conditions.append(f"strategy = ${len(params)}")
    if side:
        params.append(side)
        conditions.append(f"side = ${len(params)}")

    where   = " AND ".join(conditions)
    params += [limit, offset]

    rows = await pg.fetch(
        f"""
        SELECT mint, symbol, strategy, side, status,
               buy_amount_usdc, sell_amount_usdc,
               pnl_usdc, pnl_pct, created_at
        FROM trades
        WHERE {where}
        ORDER BY created_at DESC
        LIMIT ${len(params) - 1} OFFSET ${len(params)}
        """,
        *params,
    )

    total = await pg.fetchval(f"SELECT COUNT(*) FROM trades WHERE {where}", *params[:-2])

    return {"items": [dict(r) for r in rows], "total": total, "page": page}
```

---

## routers/metrics.py

```python
# dashboard-api/routers/metrics.py

import asyncpg
from fastapi import APIRouter, Depends

from deps import get_pg

router = APIRouter()


@router.get("/metrics/performance")
async def performance_metrics(pg: asyncpg.Pool = Depends(get_pg)):
    row = await pg.fetchrow("""
        SELECT
            COUNT(*)                                    AS total_trades,
            COUNT(*) FILTER (WHERE pnl_usdc > 0)        AS winning_trades,
            ROUND(
                COUNT(*) FILTER (WHERE pnl_usdc > 0)::numeric
                / NULLIF(COUNT(*), 0) * 100, 2
            )                                           AS win_rate,
            ROUND(SUM(pnl_usdc)::numeric, 4)            AS total_pnl_usdc,
            ROUND(AVG(pnl_usdc)::numeric, 4)            AS avg_pnl_usdc,
            ROUND(MAX(pnl_usdc)::numeric, 4)            AS best_trade,
            ROUND(MIN(pnl_usdc)::numeric, 4)            AS worst_trade
        FROM trades
        WHERE side = 'SELL' AND status = 'confirmed' AND pnl_usdc IS NOT NULL
    """)
    return dict(row)


@router.get("/metrics/strategy")
async def strategy_metrics(pg: asyncpg.Pool = Depends(get_pg)):
    rows = await pg.fetch("""
        SELECT strategy, total_trades, win_rate, total_pnl_usdc,
               avg_pnl_usdc, avg_hold_time_seconds
        FROM strategy_stats
        ORDER BY total_pnl_usdc DESC NULLS LAST
    """)
    return [dict(r) for r in rows]
```

---

## .env

```bash
REDIS_URL=redis://localhost:6379/0
DATABASE_URL=postgresql://user:pass@localhost:5432/solana_bot
CORS_ORIGINS=["http://localhost:3000"]
SECRET_KEY=change-me-in-production
```

---

## Running

```bash
# Install
pip install fastapi uvicorn redis asyncpg python-dotenv loguru pydantic-settings

# Dev
uvicorn main:app --reload --port 8001

# Production
uvicorn main:app --host 0.0.0.0 --port 8001 --workers 2
```
