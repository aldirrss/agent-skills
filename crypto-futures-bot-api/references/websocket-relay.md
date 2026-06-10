# WebSocket Relay

ConnectionManager, /ws endpoint, Redis pub/sub relay task, and heartbeat pattern.

## Table of contents
- ws/manager.py (ConnectionManager)
- ws/relay.py (/ws endpoint + Redis relay task)
- Initial state push on connect
- Heartbeat & dead connection cleanup

---

## ws/manager.py

```python
# ws/manager.py
import asyncio

from fastapi import WebSocket
from loguru import logger


class ConnectionManager:
    """
    Tracks all active WebSocket connections.
    One instance lives on app.state.ws_manager (created in lifespan).

    Thread-safety: asyncio.Lock protects the connection set.
    Single-process only — see app-setup.md note on workers=1.
    """

    def __init__(self):
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._connections.add(ws)
        logger.debug("WS client connected", total=len(self._connections))

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(ws)
        logger.debug("WS client disconnected", total=len(self._connections))

    async def broadcast(self, message: str) -> None:
        """
        Send message to all connected clients.
        Dead connections are silently removed.
        """
        dead: list[WebSocket] = []

        async with self._lock:
            conns = set(self._connections)   # snapshot

        for ws in conns:
            try:
                await ws.send_text(message)
            except Exception:
                dead.append(ws)

        if dead:
            async with self._lock:
                for ws in dead:
                    self._connections.discard(ws)
            logger.debug("Removed dead WS connections", count=len(dead))

    @property
    def connection_count(self) -> int:
        return len(self._connections)
```

---

## ws/relay.py

```python
# ws/relay.py
import asyncio
import json
import time

import redis.asyncio as aioredis
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from loguru import logger

from auth.security import verify_session_token
from config import settings
from ws.manager import ConnectionManager

router = APIRouter()

# Redis pub/sub channels the relay subscribes to
_RELAY_CHANNELS = ["bot.status", "position.updates"]


# ── Redis → WebSocket relay task ─────────────────────────────────────

async def start_redis_relay(
    redis: aioredis.Redis,
    manager: ConnectionManager,
) -> None:
    """
    Long-running background task (started in lifespan).
    Subscribes to Redis pub/sub channels and broadcasts all messages
    to every connected WebSocket client.

    One subscription for N browser clients — efficient.
    Uses a dedicated connection (pubsub cannot share with command connection).
    """
    pubsub = redis.pubsub()
    await pubsub.subscribe(*_RELAY_CHANNELS)
    logger.info("Redis relay started", channels=_RELAY_CHANNELS)

    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            data = message["data"]
            if manager.connection_count > 0:
                await manager.broadcast(data)
    except asyncio.CancelledError:
        logger.info("Redis relay cancelled, shutting down")
    except Exception:
        logger.exception("Redis relay error")
    finally:
        await pubsub.unsubscribe(*_RELAY_CHANNELS)
        await pubsub.aclose()
        logger.info("Redis relay stopped")


# ── /ws endpoint ─────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, request: Request):
    """
    WebSocket endpoint. Cookie auth is validated before accept().
    After connect:
      1. Push initial state (bot status + open positions)
      2. Listen for client messages (ping/pong, commands)
      3. Server-side ping every 25s to detect dead connections
    """
    redis:   aioredis.Redis   = request.app.state.redis
    manager: ConnectionManager = request.app.state.ws_manager

    # ── Auth check BEFORE accept() ────────────────────────────────────
    token = ws.cookies.get(settings.cookie_name)
    user  = await verify_session_token(redis, token or "")
    if not user:
        await ws.close(code=4001)   # 4001 = unauthorized (custom code)
        return

    await manager.connect(ws)

    try:
        # ── Push current state immediately ────────────────────────────
        await _push_initial_state(ws, redis)

        # ── Message loop ─────────────────────────────────────────────
        while True:
            try:
                text = await asyncio.wait_for(ws.receive_text(), timeout=25.0)
                await _handle_client_message(ws, text, redis)
            except asyncio.TimeoutError:
                # No message from client in 25s → send server ping
                await ws.send_text(json.dumps({
                    "type": "ping",
                    "ts":   str(int(time.time() * 1000)),
                }))
            except WebSocketDisconnect:
                break

    except Exception:
        logger.exception("WebSocket error")
    finally:
        await manager.disconnect(ws)


async def _push_initial_state(ws: WebSocket, redis: aioredis.Redis) -> None:
    """
    Send current bot state to a newly connected client so the dashboard
    renders immediately without waiting for the next Redis pub/sub event.
    """
    import json

    bot_status = await redis.get("state.bot.status") or "unknown"
    workers    = list(await redis.smembers("state.bot.workers") or [])

    positions: dict = {}
    for symbol in workers:
        raw = await redis.get(f"state.position.{symbol}")
        if raw:
            try:
                positions[symbol] = json.loads(raw)
            except json.JSONDecodeError:
                pass

    # Send bot status event (same schema as bot.status pub/sub)
    await ws.send_text(json.dumps({
        "status":  "ok",
        "message": "initial_state",
        "data":    json.dumps({
            "status":    bot_status,
            "workers":   workers,
            "positions": positions,
        }),
        "ts": str(int(time.time() * 1000)),
    }))

    # Send one position.updates event per open position
    for symbol, pos in positions.items():
        await ws.send_text(json.dumps({
            "symbol":   symbol,
            "status":   "open",
            "position": pos,
            "ts":       str(int(time.time() * 1000)),
        }))


async def _handle_client_message(
    ws: WebSocket,
    text: str,
    redis: aioredis.Redis,
) -> None:
    """
    Handle messages sent from the browser over WebSocket.
    Currently supports:
      - "ping"        → "pong" keepalive
      - JSON command  → dispatch via stream.commands (same as REST /bot/*)

    Commands sent via WS are convenience wrappers — they still go through
    stream.commands and return a response via bot.status pub/sub.
    The response is broadcast to ALL clients (not just the sender),
    which is correct: bot state changes should update every open tab.
    """
    if text == "ping":
        await ws.send_text("pong")
        return

    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return

    # Client-initiated command (optional — dashboard usually uses REST)
    if data.get("type") == "command":
        from routers._command import send_command
        try:
            response = await send_command(
                redis,
                command=data["command"],
                symbol=data.get("symbol"),
                payload=data.get("payload", {}),
            )
            # Response will come via bot.status pub/sub → relay → broadcast
            # No need to send directly to this client
        except Exception as e:
            await ws.send_text(json.dumps({
                "req_id":  data.get("req_id", ""),
                "status":  "error",
                "message": str(e),
                "ts":      str(int(time.time() * 1000)),
            }))
```

---

## Heartbeat & dead connection cleanup

**Server → client ping** (every 25s of inactivity):
- `asyncio.wait_for(ws.receive_text(), timeout=25.0)` raises `TimeoutError` if the client sends nothing in 25s
- Server sends `{"type": "ping", "ts": "..."}` as a JSON ping
- If the client is dead, the next `send_text` raises and the connection is discarded by `broadcast()`

**Client → server pong**:
- Browser WebSocket API handles standard WS ping/pong frames automatically
- For JSON-level keepalive, the dashboard's `WebSocketProvider` sends `"ping"` string periodically (see `crypto-futures-bot-dashboard` websocket-client.md)

**broadcast() cleanup**:
- Any `send_text` failure removes the dead connection from the set
- No need for a separate cleanup task

## Relay reconnect (if Redis drops)

`start_redis_relay` is wrapped in the lifespan with `asyncio.create_task`. If Redis drops, `pubsub.listen()` will raise. Add a retry wrapper in production:

```python
async def start_redis_relay(redis, manager):
    while True:
        try:
            await _relay_loop(redis, manager)
        except asyncio.CancelledError:
            raise   # propagate shutdown
        except Exception:
            logger.exception("Relay crashed, retrying in 5s")
            await asyncio.sleep(5)


async def _relay_loop(redis, manager):
    pubsub = redis.pubsub()
    await pubsub.subscribe(*_RELAY_CHANNELS)
    try:
        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            if manager.connection_count > 0:
                await manager.broadcast(message["data"])
    finally:
        await pubsub.unsubscribe(*_RELAY_CHANNELS)
        await pubsub.aclose()
```
