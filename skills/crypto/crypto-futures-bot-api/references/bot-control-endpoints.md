# Bot Control Endpoints

Command dispatch from API to bot engine via stream.commands, and all /bot/* REST endpoints.

## Table of contents
- Command schema
- send_command() helper
- GET /bot/status
- POST /bot/symbol
- DELETE /bot/symbol/{symbol}
- POST /bot/symbol/{symbol}/pause & /resume
- PATCH /bot/symbol/{symbol}/config
- POST /bot/emergency-stop

---

## Command schema

Commands published to `stream.commands` (stream), responses received on `bot.status` (pub/sub):

```python
# Command fields in stream.commands
{
    "req_id":   str,        # UUID — correlates response to request
    "command":  str,        # see COMMANDS below
    "symbol":   str,        # empty string if not symbol-specific
    "payload":  str,        # JSON-encoded dict with command-specific data
    "ts":       str,        # unix ms timestamp
}

# Response fields on bot.status pub/sub channel
{
    "req_id":   str,        # echoes command req_id
    "status":   "ok" | "error",
    "message":  str,
    "data":     str,        # optional JSON-encoded dict
    "ts":       str,
}

COMMANDS = [
    "ADD_SYMBOL",       # payload: {strategy, leverage, risk_pct, timeframes}
    "REMOVE_SYMBOL",    # payload: {}
    "PAUSE_SYMBOL",     # payload: {}
    "RESUME_SYMBOL",    # payload: {}
    "UPDATE_CONFIG",    # payload: {leverage?, risk_pct?, strategy?, timeframes?}
    "EMERGENCY_STOP",   # payload: {} — closes all positions, stops bot
]
```

---

## send_command() helper

```python
# routers/_command.py
import asyncio
import json
import time
import uuid

import redis.asyncio as aioredis
from fastapi import HTTPException, status

from config import settings


async def send_command(
    redis: aioredis.Redis,
    command: str,
    symbol: str | None = None,
    payload: dict | None = None,
    timeout_s: float | None = None,
) -> dict:
    """
    Publish a command to stream.commands and await the bot engine response.

    Subscribe to bot.status BEFORE publishing — this eliminates the race
    condition where the bot processes the command and responds before
    the caller's listener is ready.

    Raises HTTPException(504) on timeout, HTTPException(502) on bot error.
    """
    req_id    = str(uuid.uuid4())
    timeout_s = timeout_s or settings.command_timeout_s

    pubsub = redis.pubsub()
    await pubsub.subscribe("bot.status")

    try:
        # Publish command after subscription is confirmed
        await redis.xadd(
            "stream.commands",
            {
                "req_id":  req_id,
                "command": command,
                "symbol":  symbol or "",
                "payload": json.dumps(payload or {}),
                "ts":      str(int(time.time() * 1000)),
            },
            maxlen=1000,
            approximate=True,
        )

        # Await response with matching req_id
        response = await asyncio.wait_for(
            _await_response(pubsub, req_id),
            timeout=timeout_s,
        )
        return response

    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_504_GATEWAY_TIMEOUT,
            detail=f"Bot engine did not respond to {command} within {timeout_s}s",
        )
    finally:
        await pubsub.unsubscribe("bot.status")
        await pubsub.aclose()


async def _await_response(pubsub, req_id: str) -> dict:
    """
    Consume pub/sub messages until one with matching req_id is found.
    Must be wrapped in asyncio.wait_for() for timeout.
    """
    async for message in pubsub.listen():
        if message["type"] != "message":
            continue
        try:
            data = json.loads(message["data"])
        except (json.JSONDecodeError, TypeError):
            continue
        if data.get("req_id") == req_id:
            if data.get("status") == "error":
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=data.get("message", "Bot engine returned error"),
                )
            return data
```

---

## routers/bot_control.py

```python
# routers/bot_control.py
import json
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field

from dependencies import RedisDep, UserDep
from routers._command import send_command

router = APIRouter()


# ── Request schemas ───────────────────────────────────────────────────

class AddSymbolRequest(BaseModel):
    symbol:     str             = Field(..., examples=["BTCUSDT"])
    strategy:   str             = Field(..., examples=["trend"])
    leverage:   int             = Field(default=5,   ge=1, le=20)
    risk_pct:   float           = Field(default=0.01, gt=0, le=0.05)
    timeframes: list[str]       = Field(default=["1h", "15m"])
    exchange:   str             = Field(default="binance")
    api_key_ref: str            = Field(..., examples=["BINANCE_MAIN_API_KEY"])


class UpdateConfigRequest(BaseModel):
    strategy:   str | None      = None
    leverage:   int | None      = Field(default=None, ge=1, le=20)
    risk_pct:   float | None    = Field(default=None, gt=0, le=0.05)
    timeframes: list[str] | None = None


# ── Endpoints ─────────────────────────────────────────────────────────

@router.get("/status")
async def get_bot_status(redis: RedisDep, _user: UserDep):
    """
    Read current bot state directly from Redis (fast, no DB query).
    Returns bot status, active workers, and open position count.
    """
    bot_status = await redis.get("state.bot.status") or "unknown"
    workers    = list(await redis.smembers("state.bot.workers") or [])

    # Fetch positions for each worker
    positions = {}
    for symbol in workers:
        raw = await redis.get(f"state.position.{symbol}")
        if raw:
            positions[symbol] = json.loads(raw)

    return {
        "status":          bot_status,
        "active_workers":  workers,
        "open_positions":  positions,
        "position_count":  len(positions),
    }


@router.post("/symbol", status_code=201)
async def add_symbol(
    body: AddSymbolRequest,
    redis: RedisDep,
    _user: UserDep,
):
    """Add a new symbol worker. Bot engine spawns DataCollector + StrategyWorker."""
    response = await send_command(
        redis,
        command="ADD_SYMBOL",
        symbol=body.symbol,
        payload=body.model_dump(),
    )
    return {"status": "ok", "message": response.get("message", ""), "symbol": body.symbol}


@router.delete("/symbol/{symbol}")
async def remove_symbol(symbol: str, redis: RedisDep, _user: UserDep):
    """Stop and remove a symbol worker. Does NOT close open position."""
    response = await send_command(redis, "REMOVE_SYMBOL", symbol=symbol)
    return {"status": "ok", "message": response.get("message", ""), "symbol": symbol}


@router.post("/symbol/{symbol}/pause")
async def pause_symbol(symbol: str, redis: RedisDep, _user: UserDep):
    """
    Pause signal generation for a symbol.
    Worker stays alive but no new signals enter stream.signals.
    """
    response = await send_command(redis, "PAUSE_SYMBOL", symbol=symbol)
    return {"status": "ok", "message": response.get("message", ""), "symbol": symbol}


@router.post("/symbol/{symbol}/resume")
async def resume_symbol(symbol: str, redis: RedisDep, _user: UserDep):
    response = await send_command(redis, "RESUME_SYMBOL", symbol=symbol)
    return {"status": "ok", "message": response.get("message", ""), "symbol": symbol}


@router.patch("/symbol/{symbol}/config")
async def update_config(
    symbol: str,
    body: UpdateConfigRequest,
    redis: RedisDep,
    _user: UserDep,
):
    """
    Hot-reload worker config. Changes take effect on the next candle.
    Bot engine reads config from Redis on every candle — no restart needed.
    """
    # Only send fields that were actually provided
    payload = body.model_dump(exclude_none=True)
    if not payload:
        return {"status": "ok", "message": "No changes", "symbol": symbol}

    response = await send_command(redis, "UPDATE_CONFIG", symbol=symbol, payload=payload)
    return {"status": "ok", "message": response.get("message", ""), "symbol": symbol}


@router.post("/emergency-stop")
async def emergency_stop(redis: RedisDep, _user: UserDep):
    """
    Immediately close ALL open positions via market orders,
    then set state.bot.status = 'stopped'.

    This is the nuclear option. Triggers the bot engine's emergency close
    for every symbol that has an open position.
    Use only in genuine emergencies — exits may be at unfavorable prices.
    """
    response = await send_command(
        redis,
        "EMERGENCY_STOP",
        timeout_s=30.0,   # emergency stop may take longer: multiple market orders
    )
    return {"status": "ok", "message": response.get("message", "Emergency stop executed")}
```

---

## Notes on send_command() timeout

`EMERGENCY_STOP` uses `timeout_s=30.0` because the bot engine may need to place market close orders for multiple symbols sequentially. All other commands use `settings.command_timeout_s` (default 5s).

If the bot engine is down (no response within timeout), the API returns **504 Gateway Timeout**. The caller (dashboard) should display this clearly — the bot engine needs manual investigation.
