# [PROJECT_NAME]

## Project

**[PROJECT_NAME]** — platform otomasi trading crypto futures berbasis web.
Single-user, self-hosted. Trader connect akun exchange mereka, pilih strategi,
pantau posisi via dashboard real-time.

## Tech Stack

**Backend (Bot Engine):** Python, asyncio, ccxt/ccxt.pro, Redis Streams + PubSub, PostgreSQL, SQLModel, Pydantic Settings, Loguru

**Backend (API Server):** FastAPI, Uvicorn (workers=1), bcrypt, aioredis

**Frontend:** Next.js App Router, Tailwind CSS, shadcn/ui, lightweight-charts, Zustand, React Query

**Infrastructure:** Docker Compose (dev), Redis, PostgreSQL

## Skills yang Relevan

Selalu load skill yang sesuai saat mengerjakan komponen:

| Sedang mengerjakan | Load skill |
|---|---|
| Exchange integration, safety rules, risk sizing | `crypto-futures` |
| Strategy logic (EMA, breakout, CVD, funding, liquidation) | `crypto-futures-strategies` |
| Process topology, Redis schema, worker lifecycle | `crypto-futures-bot-architecture` |
| Database models, migration, query patterns | `crypto-futures-bot-db-schema` |
| Bot engine components (DataCollector, StrategyWorker, dll) | `crypto-futures-bot-engine` |
| FastAPI server, auth, endpoints, WebSocket | `crypto-futures-bot-api` |
| Metrics, health checks, alerts, Telegram | `crypto-futures-bot-monitoring` |
| Next.js dashboard, charts, position panel | `crypto-futures-bot-dashboard` |

## Struktur Project

```
[PROJECT_NAME]/
├── bot_engine/
│   ├── main.py                  ← entry point asyncio
│   ├── config.py                ← Pydantic Settings
│   ├── logger_setup.py
│   ├── registry.py              ← WorkerRegistry + spawn_worker
│   ├── health.py
│   ├── components/
│   │   ├── data_collector.py
│   │   ├── strategy_worker.py
│   │   ├── price_structure.py
│   │   ├── risk_manager.py
│   │   ├── order_executor.py
│   │   ├── position_tracker.py
│   │   ├── position_manager.py
│   │   ├── db_writer.py
│   │   ├── command_listener.py
│   │   ├── liquidation_collector.py
│   │   └── llm_signal_agent.py
│   └── db/
│       ├── models.py
│       ├── engine.py
│       └── queries.py
├── api_server/
│   ├── main.py
│   ├── app.py
│   ├── config.py
│   ├── dependencies.py
│   ├── auth/
│   │   ├── security.py
│   │   ├── router.py
│   │   └── middleware.py
│   ├── routers/
│   │   ├── bot.py
│   │   ├── data.py
│   │   └── _command.py
│   └── ws/
│       ├── manager.py
│       └── relay.py
├── monitoring/
│   ├── main.py
│   ├── config.py
│   ├── metrics_collector.py
│   ├── health_checker.py
│   ├── alert_manager.py
│   └── alerts/
│       ├── rules.py
│       └── notifier.py
├── dashboard/                   ← Next.js App Router
│   ├── app/
│   ├── components/
│   └── lib/
├── docs/
│   ├── ARCHITECTURE.md
│   └── ROADMAP.md
├── scripts/
│   ├── smoke_test.py
│   ├── seed.py
│   └── migrate.sh
├── docker-compose.yml
├── .env
└── .env.example
```

## Aturan Wajib (Jangan Dilanggar)

1. **Decimal untuk semua harga, qty, PnL, fee** — JANGAN float. Float JSON loses precision secara silent.
2. **`await ex.load_markets()`** — selalu async, jangan panggil tanpa await.
3. **Satu asyncio.Lock per symbol di OrderExecutor** — mencegah duplicate order.
4. **Subscribe bot.status SEBELUM xadd stream.commands** — menghindari race condition.
5. **API key exchange TIDAK PERNAH disimpan ke database** — hanya `api_key_ref` (nama env var).
6. **Uvicorn workers=1** — ConnectionManager tidak thread-safe, tidak bisa multi-worker.
7. **Config dibaca dari Redis setiap candle** — jangan cache config di memory StrategyWorker.
8. **Shutdown order:** DataCollector → StrategyWorker → RiskManager → OrderExecutor. Jangan kill OrderExecutor saat memegang Lock.
9. **Setiap exception di order path harus di-log** — tidak ada `except: pass`.
10. **asyncio.get_running_loop()** bukan `get_event_loop()` — deprecated di Python 3.10+.

## Commands

```bash
# Development
docker-compose up redis postgres          # start dependencies
python bot_engine/main.py                 # run bot engine
uvicorn api_server.main:app --reload      # run API server
python monitoring/main.py                 # run monitoring

# Database
bash scripts/migrate.sh                   # run alembic migrations
python scripts/seed.py                    # seed initial data
python scripts/smoke_test.py             # verify all components

# Dashboard
cd dashboard && npm run dev              # start Next.js dev server
```

## Environment Variables Penting

```bash
REDIS_URL=redis://:password@localhost:6379/0
DATABASE_URL=postgresql+asyncpg://user:pass@localhost/[db_name]
ADMIN_PASSWORD_HASH=<bcrypt hash>
SESSION_SECRET=<32 bytes hex>
EXCHANGE_1_KEY=<api key>
EXCHANGE_1_SECRET=<api secret>
LLM_PROVIDER=openai
LLM_API_KEY=<openai key>
TELEGRAM_BOT_TOKEN=<bot token>
TELEGRAM_CHAT_ID=<chat id>
```

## Redis Key Conventions

```
state.bot.status            running | paused | stopped
state.bot.workers           SET: active symbols
state.position.{symbol}     JSON: posisi aktif
state.price.{symbol}        harga terkini (TTL 10s)
config.worker.{symbol}      JSON: config strategy
stream.signals              Stream: sinyal dari StrategyWorker
stream.orders               Stream: order dari RiskManager
stream.fills                Stream: fill dari OrderExecutor
stream.commands             Stream: command dari API
bot.status                  PubSub: status + command responses
position.updates            PubSub: posisi real-time
llm.signal.{symbol}         JSON: LLM signal cache (TTL 480s)
funding.cache.{symbol}      JSON: funding rate cache (TTL 480s)
liq.events.{symbol}         Stream: liquidation events
liq.summary.{symbol}.5m     JSON: rolling 5m liquidation summary
cvd.candles.{symbol}.{tf}   LIST: CVD per candle (maxlen 500)
```

## Hal yang Perlu Diperhatikan

- **LiquidationCollector** hanya support Binance USDM futures. Bybit/OKX → data likuidasi tidak tersedia, strategi `liquidation` akan return None (graceful degradation).
- **LLMSignalAgent** adalah optional soft signal. Jika LLM gagal, strategy tetap berjalan — LLM score hanya menambah confluence, bukan trigger.
- **PositionManager** berjalan setiap 10 detik. Ada window ~200ms saat modify SL (cancel lama, pasang baru) di mana posisi tidak terlindungi. Jika pasang SL baru gagal: CRITICAL alert + emergency_close otomatis.
- **WebSocket dashboard** — saat connect, server langsung push initial state (semua posisi + bot status) sehingga dashboard tidak blank menunggu event pertama.
- **Testnet dulu** sebelum live trading. Gunakan `is_testnet: true` di config.worker.{symbol}.

## [SESUAIKAN] Informasi Spesifik Project

```
Exchange utama     : [binance / bybit / okx]
Server             : [VPS provider + region]
Domain dashboard   : [https://...]
Telegram chat      : [chat ID]
LLM provider       : [openai / anthropic]
Strategi aktif     : [trend / breakout / momentum / dll]
Symbol pertama     : [BTCUSDT / ETHUSDT / dll]
```
