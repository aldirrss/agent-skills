---
name: crypto-futures-bot-architecture
description: Blueprint for building production-grade crypto futures trading bot web-apps with multi-process architecture, Redis message bus, and dynamic multi-symbol/strategy management. Use this whenever the user is designing, building, or debugging any part of a futures trading bot system — process topology, Redis stream/pubsub schema, worker lifecycle, event flow, LLM signal integration, or control interface. Trigger even when the user only mentions one component (e.g. "how should my strategy worker communicate with the order executor", "how to spawn a new symbol worker from UI", "where to store bot state", "how to handle order executor crash"). This skill defines the authoritative architecture — all other crypto-futures-* skills operate within it. Requires: crypto-futures, crypto-futures-strategies.
requires:
  - crypto-futures
  - crypto-futures-strategies
---

# Crypto Futures Bot Architecture

This skill defines the **canonical architecture** for a production futures trading bot web-app. All components, naming conventions, and data flows described here are authoritative. When building any part of the system, reference this first to ensure components integrate correctly.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  FRONTEND (Next.js)                                             │
│  Dashboard · Position Monitor · Strategy Config · Bot Control   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ WebSocket (bi-directional)
┌───────────────────────────▼─────────────────────────────────────┐
│  API SERVER (FastAPI + uvicorn)                                  │
│  REST endpoints · WebSocket server · Auth · Config management   │
└──────┬────────────────────┬────────────────────────────┬────────┘
       │ READ               │ WRITE commands             │ READ/WRITE
       │ PostgreSQL         │ stream.commands            │ Redis state
┌──────▼──────────┐  ┌──────▼────────────────────────────▼────────┐
│  PostgreSQL     │  │  REDIS MESSAGE BUS                          │
│  Trade history  │  │  Streams: signals, orders, fills, commands  │
│  Strategy cfg   │  │  Pub/Sub: market data, status, positions    │
│  PnL records    │  │  Keys: bot state, position cache, LLM cache │
└──────▲──────────┘  └──────▲────────────────────────────┬────────┘
       │ WRITE              │ READ/WRITE                  │ PUBLISH
┌──────┴────────────────────▼─────────────────────────────▼────────┐
│  BOT ENGINE (single asyncio process)                              │
│                                                                   │
│  CommandListener ──────────────────────────────────────────────  │
│  DataCollector[BTC] · DataCollector[ETH] · DataCollector[N...]   │
│  StrategyWorker[BTC/trend] · StrategyWorker[ETH/momentum] · ...  │
│  LLMSignalAgent (shared, async, cached)                          │
│  RiskManager (shared)                                            │
│  OrderExecutor (shared, queue per symbol)                        │
│  PositionTracker (shared)                                        │
│  DBWriter (shared, background queue)                             │
└───────────────────────────────────────┬──────────────────────────┘
                                        │ REST + WebSocket
                         ┌──────────────▼──────────────┐
                         │  EXCHANGE (Binance/Bybit)   │
                         │  Market data · Orders       │
                         └─────────────────────────────┘
```

## Architectural Decisions (Fixed)

These decisions are non-negotiable within this architecture. Do not generate code that contradicts them.

**1. Redis Hybrid Pattern**
- `Pub/Sub` → high-frequency, loss-tolerant data (market ticks, candles, UI updates)
- `Streams` → order-critical events (signals, order requests, fills, commands)
- Reasoning: order events must survive process crashes. Pub/Sub cannot replay. Streams can.

**2. Single asyncio process for bot engine**
- All workers are asyncio tasks, not subprocesses or threads
- Bot is I/O-bound (exchange API, Redis, DB) — asyncio is optimal
- Shared Redis connection pool, shared state managers
- Workers spawned/killed at runtime via CommandListener

**3. LLM as signal source, not orchestrator**
- LLM contributes one score to confluence — it does not place orders
- Called async, result cached in Redis (TTL 5 min) — never blocks signal path
- If LLM unavailable: confluence runs without it (degraded, not broken)

**4. Single source of truth**
- Real-time state lives in Redis (positions, open orders, bot status, latest price)
- Persistent state lives in PostgreSQL (trade history, PnL, config)
- No component maintains its own local state beyond in-flight buffers

**5. Dynamic workers from UI**
- Adding/removing a symbol sends a command to `stream.commands`
- CommandListener in bot engine spawns or cancels tasks
- No restart required

## Redis Naming Convention

```
# Streams (persistent, replayable)
stream.signals              # StrategyWorker → RiskManager
stream.orders               # RiskManager → OrderExecutor
stream.fills                # OrderExecutor → PositionTracker + DBWriter
stream.commands             # API Server → CommandListener

# Pub/Sub channels (fire-and-forget)
market.{symbol}.tick        # DataCollector → StrategyWorker
market.{symbol}.candle.{tf} # DataCollector → StrategyWorker (e.g. market.BTCUSDT.candle.1h)
bot.status                  # CommandListener → API WebSocket
position.updates            # PositionTracker → API WebSocket

# Redis Keys (state cache)
state.position.{symbol}     # current position dict, JSON
state.orders.{symbol}       # open orders list, JSON
state.bot.workers           # SET of active worker symbol keys
state.bot.status            # "running" | "paused" | "stopped"
state.price.{symbol}        # latest price, float string
llm.signal.{symbol}         # cached LLM sentiment score, TTL 300s
config.worker.{symbol}      # worker config (strategy, leverage, risk%), JSON
```

## Component Responsibilities

| Component | Reads from | Writes to | Must NOT |
|---|---|---|---|
| DataCollector | Exchange WebSocket | `market.*` pub/sub | Place orders |
| StrategyWorker | `market.*` pub/sub, `llm.signal.*` | `stream.signals` | Access DB directly |
| LLMSignalAgent | `market.*` pub/sub | `llm.signal.*` | Block StrategyWorker |
| RiskManager | `stream.signals` | `stream.orders` | Modify positions directly |
| OrderExecutor | `stream.orders` | `stream.fills`, Exchange REST | Skip fill verification |
| PositionTracker | `stream.fills` | `state.position.*`, `position.updates` | Place orders |
| DBWriter | `stream.fills`, `stream.signals` | PostgreSQL | Block any other component |
| CommandListener | `stream.commands` | Spawn/cancel tasks, `bot.status` | Process orders |
| API Server | PostgreSQL, Redis state keys | `stream.commands` | Write to streams directly |

## Reference Files

Read the specific file for the area you are building:

| Building… | Read |
|---|---|
| Redis stream schema, consumer groups, pub/sub channels | `references/redis-topology.md` |
| Worker spawn/stop/crash recovery, task lifecycle | `references/worker-lifecycle.md` |
| Full event flow from market data to order fill | `references/event-flow.md` |
| LLM signal async call, caching, confluence integration | `references/llm-signal-integration.md` |
| Command schema, API→bot protocol, emergency stop | `references/control-interface.md` |

## Global Invariants

These must hold at all times. If generating code that could violate them, add an explicit guard:

- A symbol can have at most **one open position** at a time (enforced by RiskManager)
- OrderExecutor processes **one order at a time per symbol** (asyncio.Lock per symbol)
- No component calls `exchange.create_order` except OrderExecutor
- Every order placed must be recorded in `stream.fills` regardless of outcome
- Bot cannot enter new positions when `state.bot.status` ≠ `"running"`
- Emergency stop closes ALL positions before setting status to `"stopped"`
