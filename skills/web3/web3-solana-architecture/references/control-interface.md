# Control Interface

Command schema and emergency stop protocol.

## Command Schema (`stream.commands`)

All commands follow this envelope:
```json
{
  "cmd": "<COMMAND_NAME>",
  "payload": {},
  "ts": 1718000000000
}
```

## Supported Commands

### `START`
Start the bot engine. Spawns Scanner, Strategy, RiskManager, Execution, PositionTracker, DBWriter.
```json
{"cmd": "START", "payload": {}, "ts": ...}
```
Guard: only valid when `state.bot.status = "stopped"`.

### `STOP`
Graceful shutdown. Drains in-flight swaps, closes DB connections.
```json
{"cmd": "STOP", "payload": {}, "ts": ...}
```
Guard: only valid when status is `"running"` or `"paused"`.

### `PAUSE`
Pause signal processing. Scanner keeps running (buffer signals), but Strategy stops publishing to `stream.signals`.
```json
{"cmd": "PAUSE", "payload": {}, "ts": ...}
```
Use case: network issues detected, hold new entries but keep monitoring positions.

### `RESUME`
Resume from paused state.
```json
{"cmd": "RESUME", "payload": {}, "ts": ...}
```

### `EMERGENCY_STOP`
Immediately sell ALL open positions, then stop the bot.
```json
{"cmd": "EMERGENCY_STOP", "payload": {}, "ts": ...}
```
This command is valid from ANY state. It cannot be blocked.

Execution:
1. Immediately set `state.bot.status = "stopped"` (no new entries)
2. Read all `state.position.*` keys
3. For each position: XADD `stream.swaps` with `side=SELL, reason=emergency_stop, prioritize=true`
4. Wait for all fills (max 120s)
5. Send final summary via Monitor

### `ADD_TOKEN`
Add a token mint to the active watchlist.
```json
{"cmd": "ADD_TOKEN", "payload": {"mint": "ABC...123", "symbol": "BONK"}, "ts": ...}
```

### `REMOVE_TOKEN`
Remove a token mint. Bot will close open position if exists.
```json
{"cmd": "REMOVE_TOKEN", "payload": {"mint": "ABC...123"}, "ts": ...}
```

### `UPDATE_CONFIG`
Hot-reload strategy or risk config without restart.
```json
{"cmd": "UPDATE_CONFIG", "payload": {"key": "config.risk", "value": {...}}, "ts": ...}
```
CommandListener writes to Redis key. Components read config from Redis on each cycle (not cached in memory beyond 1 loop iteration).

## Sending Commands

From CLI:
```bash
redis-cli XADD stream.commands '*' cmd EMERGENCY_STOP payload '{}' ts $(date +%s%3N)
```

From Python:
```python
await redis.xadd("stream.commands", {
    "cmd": "EMERGENCY_STOP",
    "payload": "{}",
    "ts": str(int(time.time() * 1000))
})
```

## State Transitions

```
stopped ──START──► running ──PAUSE──► paused
                      │                  │
                   STOP/EMERGENCY      RESUME
                      │                  │
                   stopped           running
                      ▲
              EMERGENCY_STOP (from any state)
```

## Health Check

Monitor publishes a heartbeat every 30s to `state.bot.heartbeat` (TTL: 60s).
If the key expires, the process has crashed. External watchdog should restart.

```python
# Monitor heartbeat loop
async def heartbeat_loop():
    while True:
        await redis.set("state.bot.heartbeat", int(time.time()), ex=60)
        await asyncio.sleep(30)
```
