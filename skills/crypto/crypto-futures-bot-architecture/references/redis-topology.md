# Redis Topology

Full schema for Redis Streams, Pub/Sub channels, and state keys used in the bot engine.

## Table of contents
- Connection setup
- Streams: schema per stream
- Consumer groups
- Pub/Sub channels
- State keys
- TTL policy

## Connection setup

```python
import redis.asyncio as aioredis

async def make_redis(url: str = "redis://localhost:6379") -> aioredis.Redis:
    return await aioredis.from_url(
        url,
        encoding="utf-8",
        decode_responses=True,
        max_connections=20,        # shared pool across all components
    )

# One pool, injected into all components at startup
# Never create per-component connections — wastes sockets
```

## Streams: schema per stream

All stream messages use flat string dicts (Redis requirement). Deserialize immediately after reading.

### `stream.pre_signals` *(optional — only active when `crypto-futures-agent` is enabled)*
Published by: StrategyWorker (when `pre_signal_threshold <= score < signal_threshold`)
Consumed by: AgentConfirmer (consumer group `agent_confirmer`)

```python
# WRITE (StrategyWorker — medium confidence band)
await redis.xadd("stream.pre_signals", {
    "symbol":    "BTCUSDT",
    "direction": "long",
    "strategy":  "trend",
    "score":     "0.45",          # Decimal string
    "entry":     "67234.50",
    "sl":        "66800.00",
    "tp":        "68100.00",
    "atr":       "420.00",
    "tf":        "15m",
    "ts":        "1718000000.0",
    "candle_ts": "1718000000000",
    "context":   "{...}",         # JSON: indicators pre-packaged for agent
})

# READ (AgentConfirmer)
entries = await redis.xreadgroup(
    groupname="agent_confirmer", consumername="confirmer_1",
    streams={"stream.pre_signals": ">"},
    count=5, block=2000,
)
# After approve: xadd("stream.signals", approved_signal)
# After reject:  xack only, signal discarded
```

AgentConfirmer publishes approved signals to `stream.signals` with additional fields:
`agent_confidence` (Decimal string), `agent_reason` (string).
The `context` field is removed before forwarding to keep message size small.

---

### `stream.signals`
Published by: StrategyWorker (high confidence, score >= signal_threshold) or AgentConfirmer (approved pre-signals)
Consumed by: RiskManager (consumer group `risk-manager`)

```python
# WRITE (StrategyWorker)
await redis.xadd("stream.signals", {
    "symbol":     "BTCUSDT",
    "direction":  "long",          # "long" | "short"
    "strategy":   "trend",
    "confidence": "0.82",          # float 0–1, from confluence score
    "entry_price": "64230.50",
    "atr":        "420.30",
    "ts":         str(int(time.time() * 1000)),
})

# READ (RiskManager)
entries = await redis.xreadgroup(
    groupname="risk-manager", consumername="risk-1",
    streams={"stream.signals": ">"},   # ">" = undelivered only
    count=10, block=100,               # block 100ms, then loop
)
for stream, messages in entries:
    for msg_id, data in messages:
        await process_signal(data)
        await redis.xack("stream.signals", "risk-manager", msg_id)
```

### `stream.orders`
Published by: RiskManager  
Consumed by: OrderExecutor (consumer group `order-executor`)

```python
await redis.xadd("stream.orders", {
    "symbol":     "BTCUSDT",
    "direction":  "long",
    "qty":        "0.042",         # Decimal str, already sized by RiskManager
    "order_type": "market",        # "market" | "limit"
    "limit_price": "",             # empty if market
    "sl_price":   "63800.00",
    "tp_price":   "65200.00",
    "atr":        "285.50",        # ATR at signal time — forwarded to PositionManager
    "leverage":   "10",            # leverage applied when sizing qty
    "strategy":   "trend",
    "signal_id":  "<msg_id from stream.signals>",
    "confidence": "0.8000",        # from signal dict, informational
    "ts":         str(int(time.time() * 1000)),
})
```

### `stream.fills`
Published by: OrderExecutor  
Consumed by: PositionTracker, DBWriter (consumer group `fill-processors`, 2 consumers)

```python
await redis.xadd("stream.fills", {
    "symbol":       "BTCUSDT",
    "order_id":     "exchange_order_id_here",
    "direction":    "long",
    "qty_filled":   "0.042",
    "avg_price":    "64235.10",
    "fee":          "1.082",       # USDT
    "outcome":      "filled",      # "filled" | "cancelled" | "failed"
    "sl_order_id":  "exchange_sl_id",
    "tp_order_id":  "exchange_tp_id",
    "signal_id":    "<original signal msg_id>",
    "ts":           str(int(time.time() * 1000)),
})
```

### `stream.commands`
Published by: API Server  
Consumed by: CommandListener (consumer group `command-listener`)

```python
await redis.xadd("stream.commands", {
    "cmd":     "ADD_SYMBOL",       # see control-interface.md for full list
    "symbol":  "ETHUSDT",
    "payload": json.dumps({        # JSON string for complex params
        "strategy": "momentum",
        "leverage": 5,
        "risk_pct": 0.01,
    }),
    "req_id":  "uuid-from-api",    # for API to correlate response
    "ts":      str(int(time.time() * 1000)),
})
```

## Consumer groups

Create groups at startup if they don't exist. Safe to call repeatedly.

```python
async def ensure_consumer_groups(redis: aioredis.Redis):
    groups = [
        ("stream.signals",  "risk-manager"),
        ("stream.orders",   "order-executor"),
        ("stream.fills",    "fill-processors"),
        ("stream.commands", "command-listener"),
    ]
    for stream, group in groups:
        try:
            await redis.xgroup_create(stream, group, id="0", mkstream=True)
        except aioredis.ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise    # already exists = fine, other errors = re-raise
```

**Pending message recovery:** on startup, each consumer should first drain its pending entries (messages delivered but not ACKed from a previous crash) before reading new ones:

```python
async def drain_pending(redis, stream, group, consumer, process_fn):
    """Call once at component startup before entering normal read loop."""
    while True:
        pending = await redis.xreadgroup(
            groupname=group, consumername=consumer,
            streams={stream: "0"},    # "0" = pending (unacked) messages
            count=50,
        )
        if not pending or not pending[0][1]:
            break
        for _, messages in pending:
            for msg_id, data in messages:
                await process_fn(data)
                await redis.xack(stream, group, msg_id)
```

## Pub/Sub channels

```python
# PUBLISH (DataCollector)
await redis.publish(f"market.{symbol}.tick", json.dumps({
    "price": "64230.50",
    "ts":    str(int(time.time() * 1000)),
}))

await redis.publish(f"market.{symbol}.candle.1h", json.dumps({
    "open": "63900.00", "high": "64500.00",
    "low":  "63800.00", "close": "64230.50",
    "vol":  "1240.55",  "ts": str(candle_open_ts_ms),
    "closed": True,      # only publish True — never act on forming candles
}))

# SUBSCRIBE (StrategyWorker)
async def subscribe_market(redis_url: str, symbol: str, callback):
    r = await aioredis.from_url(redis_url, decode_responses=True)
    async with r.pubsub() as ps:
        await ps.subscribe(
            f"market.{symbol}.candle.1h",
            f"market.{symbol}.candle.15m",
        )
        async for msg in ps.listen():
            if msg["type"] == "message":
                await callback(json.loads(msg["data"]))
```

Note: Pub/Sub requires a **dedicated connection** (cannot share with command connection). Each subscriber gets its own connection from the pool.

## State keys

```python
# Position state (JSON, no TTL — persists until explicitly cleared)
await redis.set(f"state.position.{symbol}", json.dumps({
    "symbol":     symbol,
    "direction":  "long",
    "qty":        "0.042",
    "entry_price": "64235.10",
    "sl_price":   "63800.00",
    "tp_price":   "65200.00",
    "sl_order_id": "xxx",
    "tp_order_id": "yyy",
    "opened_at":  "2026-01-01T00:00:00Z",
}))
await redis.delete(f"state.position.{symbol}")   # on close

# Active workers (SET)
await redis.sadd("state.bot.workers", symbol)
await redis.srem("state.bot.workers", symbol)
members = await redis.smembers("state.bot.workers")

# Bot status
await redis.set("state.bot.status", "running")   # running | paused | stopped

# LLM cache (TTL 480s = 2× refresh interval — buffer against delayed refreshes)
await redis.set(f"llm.signal.{symbol}", json.dumps({
    "score":     0.72,         # 0–1, sentiment strength
    "direction": "bullish",    # "bullish" | "bearish" | "neutral"
    "reason":    "...",        # short summary for UI display
    "ts":        "...",
}), ex=480)
```

## TTL policy

| Key pattern | TTL | Reason |
|---|---|---|
| `llm.signal.*` | 480s | 2× refresh interval — buffer against delayed LLM calls |
| `state.price.*` | 10s | Stale price should not be used for sizing |
| `state.position.*` | None | Must persist until explicitly closed |
| `state.bot.*` | None | Must persist across restarts |
| `config.worker.*` | None | Config must survive restarts |
| Stream entries | 7 days (MAXLEN ~100k) | Audit trail, not infinite |

```python
# Stream trimming — add to xadd calls to prevent unbounded growth
await redis.xadd("stream.fills", data, maxlen=100_000, approximate=True)
```
