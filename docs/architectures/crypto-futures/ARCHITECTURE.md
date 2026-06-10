# [PROJECT_NAME] — Architecture

## Overview

[PROJECT_NAME] adalah platform otomasi trading crypto futures berbasis web.
Pengguna dapat menghubungkan akun exchange mereka, memilih strategi trading,
dan memantau posisi serta performa secara real-time melalui dashboard web.

**Target pengguna:** Trader individu yang ingin mengotomasi strategi futures
tanpa harus menulis kode sendiri.

**Prinsip desain:**
- Self-hosted — data dan API key tidak meninggalkan server pengguna
- Dashboard-first — semua operasi bisa dilakukan dari web, tidak perlu CLI
- Fail-safe — posisi selalu terlindungi oleh SL/TP order di exchange

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

## Komponen

### Bot Engine
- **Skill:** `crypto-futures-bot-engine`
- **Runtime:** Single asyncio process, semua komponen sebagai coroutine
- **Entry:** `bot_engine/main.py`
- **Key rule:** Satu `asyncio.Lock` per symbol di OrderExecutor — tidak ada duplicate order
- **Config hot-reload:** Config dibaca dari Redis setiap candle, tidak perlu restart

| Komponen | Fungsi |
|---|---|
| DataCollector | Subscribe exchange WebSocket, publish closed candles + CVD ke Redis |
| StrategyWorker | Evaluasi sinyal dari candle, publish ke stream.signals |
| RiskManager | Gate 5 kondisi, sizing posisi, forward ke stream.orders |
| OrderExecutor | Eksekusi order + SL/TP di exchange, publish ke stream.fills |
| PositionTracker | Maintain state posisi di Redis, sync ke PostgreSQL |
| PositionManager | Trailing stop, break-even, partial TP, time exit (polling 10s) |
| LiquidationCollector | Binance forceOrder WebSocket, rolling summary liquidation |
| LLMSignalAgent | Refresh sinyal LLM setiap 4 menit, cache di Redis |
| CommandListener | Consume stream.commands dari API, spawn/stop workers |

### API Server
- **Skill:** `crypto-futures-bot-api`
- **Runtime:** Uvicorn, `workers=1` (ConnectionManager in-process, tidak thread-safe)
- **Auth:** Cookie HttpOnly + bcrypt, session di Redis (sliding TTL)
- **WebSocket:** Single relay task subscribe Redis PubSub → broadcast ke semua browser tab

### Dashboard
- **Skill:** `crypto-futures-bot-dashboard`
- **Stack:** Next.js App Router + Tailwind + shadcn/ui + lightweight-charts
- **State:** Zustand store di-update via WebSocket events
- **Data fetch:** React Query untuk REST (polling), Zustand untuk real-time WS

### Monitoring
- **Skill:** `crypto-futures-bot-monitoring`
- **Runtime:** Asyncio daemon terpisah dari bot engine
- **Alert channels:** Telegram (primary), email (optional fallback)
- **Checks:** Heartbeat age, position SL coverage, stream lag, DB fallback file

---

## Infrastructure

### Development
```
docker-compose.yml
├── redis:latest-alpine      port 6379
├── postgres:latest-alpine   port 5432
├── bot_engine               (volume mount untuk hot-reload)
├── api_server               port 8000
└── monitoring
```

### Production (minimal VPS)
```
VPS (min 2 vCPU, 4GB RAM)
├── nginx (reverse proxy, SSL termination, WS upgrade)
│   └── → api_server:8000
├── bot_engine    (systemd unit atau docker)
├── api_server    (systemd unit atau docker)
├── monitoring    (systemd unit atau docker)
├── redis         (requirepass, AOF persistence)
├── postgres      (tidak expose port ke public)
└── dashboard     (static export atau serve via Next.js)
```

### Redis key space

```
state.bot.status          running | paused | stopped
state.bot.workers         SET of active symbols
state.position.{symbol}   JSON posisi aktif
state.price.{symbol}      harga terkini (TTL 10s)
config.worker.{symbol}    konfigurasi strategy per symbol
stream.signals            Redis Stream: sinyal dari StrategyWorker
stream.orders             Redis Stream: order dari RiskManager
stream.fills              Redis Stream: fill dari OrderExecutor
stream.commands           Redis Stream: command dari API
bot.status                PubSub channel: status update
position.updates          PubSub channel: update posisi real-time
```

Full schema di `crypto-futures-bot-architecture` skill.

### PostgreSQL schema

```
accounts      exchange accounts (api_key_ref ke env var, bukan key langsung)
symbols       active trading symbols per account
trades        immutable trade log (entry/exit/pnl/fee)
signals       sinyal yang di-act (untuk analisis strategi)
daily_pnl     snapshot harian untuk equity curve
```

Full DDL di `crypto-futures-bot-db-schema` skill.

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
    │ hitung qty dari risk_pct dan ATR
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
    │ baca state.position.{symbol}
    │ evaluasi 5 rules (priority order):
    │   1. Time exit (>24h tanpa capai 1R)
    │   2. Trailing active (update peak, move SL)
    │   3. Trailing activate (profit >= 1.5R)
    │   4. Break-even (profit >= 1R → SL ke entry)
    │   5. Partial TP (profit >= 2R → close 50%)
    ▼
OrderExecutor.modify_sl() atau partial_close()
    │ jika modify_sl gagal: CRITICAL alert + emergency_close
    ▼
stream.fills ──► PositionTracker (update state)
```

### 4. Dashboard Real-time Update

```
Browser (WebSocket /ws)
    │ connect → auth cookie check
    │ server push: initial state (bot status + semua posisi)
    ▼
Redis PubSub (bot.status + position.updates)
    │ setiap event: API Server relay task
    ▼
ConnectionManager.broadcast()
    ▼
Semua tab browser terbuka (termasuk tab yang baru connect)
```

---

## Keputusan Desain

| Keputusan | Pilihan | Alasan |
|---|---|---|
| Single asyncio process | vs multiprocess | Shared Lock per symbol, tanpa IPC overhead |
| Redis hybrid (Stream + PubSub) | vs Kafka, RabbitMQ | Cukup untuk throughput ini, operasional lebih sederhana |
| Uvicorn workers=1 | vs workers=N | ConnectionManager in-memory, tidak bisa di-share antar process |
| SL/TP di exchange | vs bot-managed | Posisi terlindungi saat bot down |
| API key via env var | vs database | Key tidak pernah di-persist ke disk DB |
| LLM sebagai confluence | vs LLM sebagai trigger | LLM score 0-1 hanya menambah/mengurangi confidence, tidak pernah satu-satunya alasan entry |
| Decimal untuk semua harga | vs float | Float JSON loses precision secara silent |
| Config hot-reload via Redis | vs restart | Strategy bisa diganti tanpa downtime |

---

## Skills yang Digunakan

| Komponen | Skill |
|---|---|
| Safety rules, exchange integration | `crypto-futures` |
| Strategy implementations (6 strategi + price structure) | `crypto-futures-strategies` |
| Process topology, Redis schema, worker lifecycle | `crypto-futures-bot-architecture` |
| Database schema, migrations, query patterns | `crypto-futures-bot-db-schema` |
| Bot engine implementation | `crypto-futures-bot-engine` |
| API server (FastAPI, auth, WebSocket) | `crypto-futures-bot-api` |
| Monitoring, alerts, Telegram | `crypto-futures-bot-monitoring` |
| Dashboard (Next.js, charts, controls) | `crypto-futures-bot-dashboard` |
