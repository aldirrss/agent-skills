# Control Interface

Command schema and protocol for API Server → Bot Engine communication. How the UI controls the bot at runtime without requiring process restarts.

## Table of contents
- Command schema
- Full command list
- CommandListener implementation
- API endpoints
- Emergency stop
- Response correlation

## Command schema

All commands go through `stream.commands`. The API Server writes; CommandListener reads and executes.

```python
# Base command structure
{
    "cmd":     str,          # command name (see list below)
    "symbol":  str,          # target symbol, empty string if global
    "payload": str,          # JSON string for complex params, empty if none
    "req_id":  str,          # UUID from API, for response correlation
    "ts":      str,          # unix ms
}

# Response published to Pub/Sub (API WebSocket reads and forwards to client)
{
    "req_id":  str,          # matches command req_id
    "status":  str,          # "ok" | "error"
    "message": str,          # human-readable result
    "data":    str,          # JSON string with response data if any
    "ts":      str,
}
```

## Full command list

| Command | Symbol required | Payload | Effect |
|---|---|---|---|
| `ADD_SYMBOL` | Yes | `{strategy, leverage, risk_pct, timeframe}` | Spawn DataCollector + StrategyWorker |
| `REMOVE_SYMBOL` | Yes | — | Stop workers, leave position open |
| `PAUSE_SYMBOL` | Yes | — | Stop StrategyWorker only (data still collected) |
| `RESUME_SYMBOL` | Yes | — | Re-spawn StrategyWorker |
| `UPDATE_CONFIG` | Yes | `{key: value, ...}` | Hot-reload worker config in Redis |
| `CLOSE_POSITION` | Yes | `{reason}` | Market close specific symbol position |
| `EMERGENCY_STOP` | No | — | Close ALL positions, stop ALL workers |
| `PAUSE_ALL` | No | — | Set bot status to paused (no new entries) |
| `RESUME_ALL` | No | — | Set bot status to running |
| `STATUS` | No | — | Return current state snapshot |

## CommandListener implementation

```python
import asyncio
import json
import uuid

class CommandListener:
    def __init__(self, redis, registry, order_executor, position_tracker):
        self.redis    = redis
        self.registry = registry
        self.executor = order_executor
        self.tracker  = position_tracker

    async def run(self, stop_event: asyncio.Event):
        await drain_pending(self.redis, "stream.commands",
                            "command-listener", "cmd-1", self._dispatch)
        while not stop_event.is_set():
            entries = await self.redis.xreadgroup(
                groupname="command-listener", consumername="cmd-1",
                streams={"stream.commands": ">"},
                count=1, block=500,
            )
            if not entries:
                continue
            for _, messages in entries:
                for msg_id, data in messages:
                    await self._dispatch(data)
                    await self.redis.xack("stream.commands",
                                          "command-listener", msg_id)

    async def _dispatch(self, data: dict):
        cmd     = data.get("cmd")
        symbol  = data.get("symbol", "")
        payload = json.loads(data.get("payload") or "{}")
        req_id  = data.get("req_id", str(uuid.uuid4()))

        handlers = {
            "ADD_SYMBOL":    self._add_symbol,
            "REMOVE_SYMBOL": self._remove_symbol,
            "PAUSE_SYMBOL":  self._pause_symbol,
            "RESUME_SYMBOL": self._resume_symbol,
            "UPDATE_CONFIG": self._update_config,
            "CLOSE_POSITION":self._close_position,
            "EMERGENCY_STOP":self._emergency_stop,
            "PAUSE_ALL":     self._pause_all,
            "RESUME_ALL":    self._resume_all,
            "STATUS":        self._status,
        }

        handler = handlers.get(cmd)
        if not handler:
            await self._respond(req_id, "error", f"Unknown command: {cmd}")
            return

        try:
            result = await handler(symbol, payload)
            await self._respond(req_id, "ok", result or "done")
        except Exception as e:
            await self._respond(req_id, "error", str(e))

    async def _respond(self, req_id: str, status: str, message: str, data: dict = None):
        await self.redis.publish("bot.status", json.dumps({
            "req_id":  req_id,
            "status":  status,
            "message": message,
            "data":    json.dumps(data) if data else "",
            "ts":      str(int(time.time() * 1000)),
        }))
```

## Key command implementations

```python
async def _add_symbol(self, symbol: str, payload: dict) -> str:
    if not symbol:
        raise ValueError("symbol required")
    required = {"strategy", "leverage", "risk_pct"}
    if not required.issubset(payload):
        raise ValueError(f"Missing fields: {required - payload.keys()}")
    await spawn_worker(symbol, payload, self.redis, self.registry)
    return f"Worker started for {symbol}"

async def _update_config(self, symbol: str, payload: dict) -> str:
    """Hot-reload: update Redis config. StrategyWorker reads on next candle."""
    existing_raw = await self.redis.get(f"config.worker.{symbol}")
    if not existing_raw:
        raise ValueError(f"No active config for {symbol}")
    config = json.loads(existing_raw)
    config.update(payload)   # merge — only update provided keys
    await self.redis.set(f"config.worker.{symbol}", json.dumps(config))
    return f"Config updated for {symbol}: {list(payload.keys())}"

async def _close_position(self, symbol: str, payload: dict) -> str:
    """Market close specific symbol. Uses OrderExecutor."""
    pos_raw = await self.redis.get(f"state.position.{symbol}")
    if not pos_raw:
        return f"No open position for {symbol}"
    pos = json.loads(pos_raw)
    await self.executor.emergency_close(symbol, pos, reason=payload.get("reason", "manual"))
    return f"Close order submitted for {symbol}"

async def _emergency_stop(self, _symbol: str, _payload: dict) -> str:
    """Close ALL positions then stop ALL workers. See emergency stop section."""
    await self.redis.set("state.bot.status", "paused")  # block new signals first

    # Close all open positions in parallel
    workers = await self.redis.smembers("state.bot.workers")
    close_tasks = []
    for sym in workers:
        pos_raw = await self.redis.get(f"state.position.{sym}")
        if pos_raw:
            pos = json.loads(pos_raw)
            close_tasks.append(self.executor.emergency_close(sym, pos, reason="emergency_stop"))
    await asyncio.gather(*close_tasks, return_exceptions=True)

    # Stop all workers
    symbols = self.registry.all_symbols()
    await asyncio.gather(*[stop_worker(s, self.registry, self.redis) for s in symbols])

    await self.redis.set("state.bot.status", "stopped")
    return f"Emergency stop complete. Closed {len(close_tasks)} positions."

async def _status(self, _symbol: str, _payload: dict) -> str:
    status    = await self.redis.get("state.bot.status") or "unknown"
    workers   = await self.redis.smembers("state.bot.workers")
    positions = {}
    for sym in workers:
        pos = await self.redis.get(f"state.position.{sym}")
        if pos:
            positions[sym] = json.loads(pos)
    return json.dumps({"status": status, "workers": list(workers),
                        "open_positions": positions})
```

## API endpoints

FastAPI routes that translate HTTP/WS requests into `stream.commands` writes:

```python
from fastapi import FastAPI, WebSocket
import uuid, json

app = FastAPI()

async def send_command(redis, cmd: str, symbol: str = "",
                        payload: dict = None, timeout: float = 5.0) -> dict:
    """Send command and wait for response via pub/sub."""
    req_id = str(uuid.uuid4())
    r_sub  = await aioredis.from_url(REDIS_URL, decode_responses=True)

    async with r_sub.pubsub() as ps:
        await ps.subscribe("bot.status")

        await redis.xadd("stream.commands", {
            "cmd": cmd, "symbol": symbol,
            "payload": json.dumps(payload or {}),
            "req_id": req_id,
            "ts": str(int(time.time() * 1000)),
        })

        deadline = time.time() + timeout
        async for msg in ps.listen():
            if time.time() > deadline:
                return {"status": "error", "message": "timeout"}
            if msg["type"] != "message":
                continue
            data = json.loads(msg["data"])
            if data.get("req_id") == req_id:
                return data

@app.post("/bot/symbol")
async def add_symbol(body: AddSymbolRequest):
    return await send_command(redis, "ADD_SYMBOL", body.symbol, body.dict())

@app.delete("/bot/symbol/{symbol}")
async def remove_symbol(symbol: str):
    return await send_command(redis, "REMOVE_SYMBOL", symbol)

@app.post("/bot/emergency-stop")
async def emergency_stop():
    return await send_command(redis, "EMERGENCY_STOP", timeout=30.0)

@app.get("/bot/status")
async def get_status():
    return await send_command(redis, "STATUS")

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Stream real-time updates to frontend."""
    await ws.accept()
    r_sub = await aioredis.from_url(REDIS_URL, decode_responses=True)
    async with r_sub.pubsub() as ps:
        await ps.subscribe("bot.status", "position.updates")
        async for msg in ps.listen():
            if msg["type"] == "message":
                await ws.send_text(msg["data"])
```

## Emergency stop protocol

Emergency stop is the most critical operation. Order of operations matters:

```
1. SET state.bot.status = "paused"     ← blocks new signals immediately
2. Cancel all resting SL/TP orders     ← prevent interference with market close
3. Market close ALL open positions     ← parallel, with individual error handling
4. Verify all positions closed         ← poll exchange until confirmed
5. Stop all workers                    ← DataCollector + StrategyWorker tasks
6. SET state.bot.status = "stopped"
7. Respond to API
```

If step 3 fails for any symbol (exchange error), log it, continue with others, and report which symbols failed in the response. **Never silently skip a position close failure.**

## Response correlation

The API uses `req_id` to match command → response. Pub/Sub is broadcast — all WebSocket clients receive all status messages. The frontend filters by `req_id` for command responses; it processes all messages without `req_id` (or with `req_id: ""`) as broadcast updates (position updates, status changes).
