# App Setup

FastAPI app factory, lifespan, CORS, dependency injection, and uvicorn entry point.

## Table of contents
- config.py
- app.py (factory + lifespan)
- dependencies.py
- main.py

---

## config.py

```python
# config.py
from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # PostgreSQL
    database_url: str = Field(..., description="postgresql+asyncpg://user:pass@host/db")

    # Redis
    redis_url: str = Field(default="redis://localhost:6379/0")

    # Auth
    admin_password_hash: str = Field(
        ..., description="bcrypt hash — generate with: python -c \"import bcrypt; print(bcrypt.hashpw(b'yourpass', bcrypt.gensalt()).decode())\""
    )
    session_ttl_seconds: int = Field(default=86400)   # 24h
    cookie_name: str         = Field(default="bot_session")
    cookie_secure: bool      = Field(default=True)    # False for local HTTP dev
    cookie_domain: str | None = Field(default=None)

    # CORS
    cors_origins: list[str] = Field(default=["http://localhost:3000"])

    # Bot engine comms
    command_timeout_s: float = Field(default=5.0)

    # PnL snapshot interval (mirrors bot engine setting)
    pnl_snapshot_interval_s: int = Field(default=900)   # 15 min

    class Config:
        env_file = ".env"


settings = Settings()
```

---

## app.py

```python
# app.py
import asyncio
from contextlib import asynccontextmanager

import redis.asyncio as aioredis
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker

from config import settings
from auth.middleware import AuthMiddleware
from routers import bot_control, data, health
from auth.router import router as auth_router
from ws.manager import ConnectionManager
from ws.relay import start_redis_relay


@asynccontextmanager
async def lifespan(app: FastAPI):
    # ── Infrastructure ───────────────────────────────────────────────
    redis = await aioredis.from_url(
        settings.redis_url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=30,
    )
    await redis.ping()

    engine = create_async_engine(
        settings.database_url,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
    )
    session_factory = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    # ── Shared state on app ──────────────────────────────────────────
    app.state.redis           = redis
    app.state.engine          = engine
    app.state.session_factory = session_factory
    app.state.ws_manager      = ConnectionManager()

    # ── WebSocket relay: single Redis subscription for all WS clients
    relay_task = asyncio.create_task(
        start_redis_relay(redis, app.state.ws_manager),
        name="redis_ws_relay",
    )
    app.state.relay_task = relay_task

    yield  # ← app is running

    # ── Shutdown ─────────────────────────────────────────────────────
    relay_task.cancel()
    await asyncio.gather(relay_task, return_exceptions=True)
    await redis.aclose()
    await engine.dispose()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Crypto Futures Bot API",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/docs",       # disable in prod: docs_url=None
        redoc_url=None,
    )

    # ── CORS — allow_credentials=True is required for cookies ────────
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ── Auth middleware — protects all routes except /auth/* ─────────
    app.add_middleware(AuthMiddleware)

    # ── Routers ──────────────────────────────────────────────────────
    app.include_router(auth_router,         prefix="/auth",    tags=["auth"])
    app.include_router(bot_control.router,  prefix="/bot",     tags=["bot"])
    app.include_router(data.router,         prefix="",         tags=["data"])
    app.include_router(health.router,       prefix="/health",  tags=["health"])

    # WebSocket is registered separately (no prefix) — see ws/relay.py
    from ws.relay import router as ws_router
    app.include_router(ws_router)

    return app


app = create_app()
```

---

## dependencies.py

```python
# dependencies.py
from typing import Annotated

import redis.asyncio as aioredis
from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession


# ── Redis ─────────────────────────────────────────────────────────────

async def get_redis(request: Request) -> aioredis.Redis:
    return request.app.state.redis


# ── PostgreSQL session ────────────────────────────────────────────────

async def get_session(request: Request):
    session_factory = request.app.state.session_factory
    async with session_factory() as session:
        yield session


# ── Auth ──────────────────────────────────────────────────────────────

async def get_current_user(
    request: Request,
    redis: Annotated[aioredis.Redis, Depends(get_redis)],
) -> dict:
    """
    Validates session cookie. Raises 401 if missing or expired.
    Used as a FastAPI dependency on protected endpoints.
    The AuthMiddleware handles route-level blocking; this dependency
    provides the user object to individual endpoints if needed.
    """
    from auth.security import verify_session_token
    from config import settings

    token = request.cookies.get(settings.cookie_name)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Not authenticated")

    user = await verify_session_token(redis, token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Session expired")
    return user


# ── Convenience type aliases ──────────────────────────────────────────

RedisDep   = Annotated[aioredis.Redis,   Depends(get_redis)]
SessionDep = Annotated[AsyncSession,     Depends(get_session)]
UserDep    = Annotated[dict,             Depends(get_current_user)]
```

---

## main.py

```python
# main.py
import uvicorn
from app import app   # noqa: F401 — imported for uvicorn string reference

if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=False,          # True for development
        workers=1,             # single worker — WebSocket state is in-process
        log_level="info",
        access_log=True,
    )
```

> **Why `workers=1`?** ConnectionManager holds WebSocket connections in memory. Multiple workers would split connections across processes, so broadcasts from one worker would miss clients on another. If horizontal scaling is needed later, move ConnectionManager state to Redis and use Pub/Sub for cross-process broadcast.
