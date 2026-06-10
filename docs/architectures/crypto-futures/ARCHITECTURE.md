# [PROJECT_NAME] — Architecture

## Overview

[PROJECT_NAME] is a web-based crypto futures trading automation platform.
Users can connect their exchange accounts, select trading strategies,
and monitor positions and performance in real-time through a web dashboard.

**Target users:** Traders who want to automate futures strategies
without writing code themselves.

**Design principles:**
- Self-hosted — data and API keys never leave the user's server
- Dashboard-first — all operations can be done from the web, no CLI needed
- Fail-safe — positions are always protected by SL/TP orders at the exchange

---

## System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Browser                             │
│                    Next.js Dashboard                            │
│          (REST polling + WebSocket real-time)                   │
└──────────────────────┬──────────────────────────────────────────┘
                       │ HTTPS / WSS
┌──────────────────────▼──────────────────────────────────────────┐
│                    API Server (FastAPI)                          │
│    Auth │ /bot/* │ /trades │ /metrics │ /ws relay               │
│                       workers=1                                 │
└──────┬───────────────┬─────────────────────────────────────────┘
       │               │
       │ stream.commands    bot.status pub/sub
       │               │
┌──────▼───────────────▼──────────────────────────────────────────┐
│                     Redis                                        │
│  Streams: signals │ orders │ fills │ commands                   │
│  PubSub:  bot.status │ position.updates                         │
│  State:   position.* │ price.* │ bot.status │ config.worker.*  │
└──────┬───────────────┬──────────────────────────────────────────┘
       │               │
┌──────▼───────────────▼──────────────────────────────────────────┐
│                   Bot Engine (asyncio)                           │
│                                                                  │
│  DataCollector ──pub/sub──► StrategyWorker                      │
│                                    │ stream.signals              │
│                             RiskManager                          │
│                                    │ stream.orders               │
│                            OrderExecutor ──── Exchange API       │
│                                    │ stream.fills                │
│              PositionTracker ◄─────┤                             │
│              PositionManager ◄─────┘ (polling 10s)              │
│              LiquidationCollector ── Binance WS                 │
│              LLMSignalAgent ──────── LLM API                    │
│              CommandListener ◄────── stream.commands            │
│              HealthHeartbeat                                     │
└──────┬──────────────────────────────────────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────────────────┐
│                  PostgreSQL                                      │
│  accounts │ symbols │ trades │ signals │ daily_pnl              │
└─────────────────────────────────────────────────────────────────┘
       ▲
┌──────┴──────────────────────────────────────────────────────────┐
│                  Monitoring Daemon (asyncio)                     │
│  MetricsCollector │ HealthChecker │ AlertManager                │
│  → Telegram alerts                                               │
└─────────────────────────────────────────────────────────────────┘
```

---

## Components

### Bot Engine
- **Skill:** `crypto-futures-bot-engine`
- **Runtime:** Single asyncio process, all components as coroutines
- **Entry:** `bot_engine/main.py`
- **Key rule:** One `asyncio.Lock` per symbol in OrderExecutor — no duplicate orders
- **Config hot-reload:** Config read from Redis every candle, no restart needed

| Component | Function |
|---|---|
| DataCollector | Subscribe to exchange WebSocket, publish closed candles + CVD to Redis |
| StrategyWorker | Evaluate signals from candles, publish to stream.signals |
| RiskManager | 5 gate checks, position sizing, forward to stream.orders |
| OrderExecutor | Execute orders + SL/TP at exchange, publish to stream.fills |
| PositionTracker | Maintain position state in Redis, sync to PostgreSQL |
| PositionManager | Trailing stop, break-even, partial TP, time exit (polling 10s) |
| LiquidationCollector | Binance forceOrder WebSocket, rolling liquidation summary |
| LLMSignalAgent | Refresh LLM signals every 4 minutes, cache in Redis |
| CommandListener | Consume stream.commands from API, spawn/stop workers |

### API Server
- **Skill:** `crypto-futures-bot-api`
- **Runtime:** Uvicorn, `workers=1` (ConnectionManager in-process, not thread-safe)
- **Auth:** HttpOnly cookie + bcrypt, session in Redis (sliding TTL)
- **WebSocket:** Single relay task subscribing Redis PubSub → broadcast to all browser tabs

### Dashboard
- **Skill:** `crypto-futures-bot-dashboard`
- **Stack:** Next.js App Router + Tailwind + shadcn/ui + lightweight-charts
- **State:** Zustand store updated via WebSocket events
- **Data fetch:** React Query for REST (polling), Zustand for real-time WS

### Monitoring
- **Skill:** `crypto-futures-bot-monitoring`
- **Runtime:** Asyncio daemon separate from bot engine
- **Alert channels:** Telegram (primary), email (optional fallback)
- **Checks:** Heartbeat age, position SL coverage, stream lag, DB fallback file

---

## Infrastructure

### Development
```
docker-compose.yml
├── redis:latest-alpine      port 6379
├── postgres:latest-alpine   port 5432
├── bot_engine               (volume mount for hot-reload)
├── api_server               port 8000
└── monitoring
```

### Production (minimal VPS)
```
VPS (min 2 vCPU, 4GB RAM)
├── nginx (reverse proxy, SSL termination, WS upgrade)
│   └── → api_server:8000
├── bot_engine    (systemd unit or docker)
├── api_server    (systemd unit or docker)
├── monitoring    (systemd unit or docker)
├── redis         (requirepass, AOF persistence)
├── postgres      (not exposed to public)
└── dashboard     (static export or served via Next.js)
```

### Redis key space

```
state.bot.status          running | paused | stopped
state.bot.workers         SET of active symbols
state.position.{symbol}   JSON active position
state.price.{symbol}      current price (TTL 10s)
config.worker.{symbol}    strategy config per symbol
stream.signals            Redis Stream: signals from StrategyWorker
stream.orders             Redis Stream: orders from RiskManager
stream.fills              Redis Stream: fills from OrderExecutor
stream.commands           Redis Stream: commands from API
bot.status                PubSub channel: status updates
position.updates          PubSub channel: real-time position updates
```

Full schema in `crypto-futures-bot-architecture` skill.

### PostgreSQL schema

```
accounts      exchange accounts (api_key_ref to env var, not the key itself)
symbols       active trading symbols per account
trades        immutable trade log (entry/exit/pnl/fee)
signals       acted-upon signals (for strategy analysis)
daily_pnl     daily snapshot for equity curve
```

Full DDL in `crypto-futures-bot-db-schema` skill.

---

## Data Flow (Sequence)

### 1. Market Data → Signal

```
Exchange WS
    │ OHLCV candle closed
    ▼
DataCollector
    │ publish market.{symbol}.candle.{tf}
    ▼
StrategyWorker
    │ evaluate: EMA/RSI/CVD/volume/LLM confluence
    │ if score >= threshold:
    ▼
stream.signals ──► RiskManager
```

### 2. Signal → Order → Fill

```
stream.signals
    │ 5 gate checks (status, position, circuit breaker, equity, drawdown)
    │ calculate qty from risk_pct and ATR
    ▼
stream.orders ──► OrderExecutor
    │ acquire Lock(symbol)
    │ create_order(market entry)
    │ assert filled
    │ place SL order (stop_market, reduce_only)
    │ place TP order (take_profit_market, reduce_only)
    ▼
stream.fills ──► PositionTracker + DBWriter
    │ PositionTracker: state.position.{symbol} = {...}
    │ DBWriter: INSERT INTO trades
    ▼
position.updates pub/sub ──► API Server ──► Dashboard WebSocket
```

### 3. Position Management Loop

```
PositionManager (polling 10s)
    │ read state.position.{symbol}
    │ evaluate 5 rules (priority order):
    │   1. Time exit (>24h without reaching 1R)
    │   2. Trailing active (update peak, move SL)
    │   3. Trailing activate (profit >= 1.5R)
    │   4. Break-even (profit >= 1R → SL to entry)
    │   5. Partial TP (profit >= 2R → close 50%)
    ▼
OrderExecutor.modify_sl() or partial_close()
    │ if modify_sl fails: CRITICAL alert + emergency_close
    ▼
stream.fills ──► PositionTracker (update state)
```

### 4. Dashboard Real-time Update

```
Browser (WebSocket /ws)
    │ connect → auth cookie check
    │ server push: initial state (bot status + all positions)
    ▼
Redis PubSub (bot.status + position.updates)
    │ on each event: API Server relay task
    ▼
ConnectionManager.broadcast()
    ▼
All open browser tabs (including newly connected tabs)
```

---

## Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| Single asyncio process | vs multiprocess | Shared Lock per symbol, no IPC overhead |
| Redis hybrid (Stream + PubSub) | vs Kafka, RabbitMQ | Sufficient for this throughput, simpler to operate |
| Uvicorn workers=1 | vs workers=N | ConnectionManager is in-memory, cannot be shared across processes |
| SL/TP at exchange | vs bot-managed | Positions protected even when bot is down |
| API key via env var | vs database | Key is never persisted to disk DB |
| LLM as confluence | vs LLM as trigger | LLM score 0-1 only adds/reduces confidence, never the sole entry reason |
| Decimal for all prices | vs float | Float JSON loses precision silently |
| Config hot-reload via Redis | vs restart | Strategy can be changed without downtime |

---

## Skills Used

| Component | Skill |
|---|---|
| Safety rules, exchange integration | `crypto-futures` |
| Strategy implementations (6 strategies + price structure) | `crypto-futures-strategies` |
| Process topology, Redis schema, worker lifecycle | `crypto-futures-bot-architecture` |
| Database schema, migrations, query patterns | `crypto-futures-bot-db-schema` |
| Bot engine implementation | `crypto-futures-bot-engine` |
| API server (FastAPI, auth, WebSocket) | `crypto-futures-bot-api` |
| Monitoring, alerts, Telegram | `crypto-futures-bot-monitoring` |
| Dashboard (Next.js, charts, controls) | `crypto-futures-bot-dashboard` |
