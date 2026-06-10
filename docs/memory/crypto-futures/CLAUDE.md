# [PROJECT_NAME]

## Project

**[PROJECT_NAME]** — web-based crypto futures trading automation platform.
Traders connect their exchange accounts, select strategies,
and monitor positions via real-time dashboard.

## Tech Stack

**Backend (Bot Engine):** Python, asyncio, ccxt/ccxt.pro, Redis Streams + PubSub, PostgreSQL, SQLModel, Pydantic Settings, Loguru

**Backend (API Server):** FastAPI, Uvicorn (workers=1), bcrypt, aioredis

**Frontend:** Next.js App Router, Tailwind CSS, shadcn/ui, lightweight-charts, Zustand, React Query

**Infrastructure:** Docker Compose (dev), Redis, PostgreSQL

## Relevant Skills

Always load the matching skill when working on a component:

| Working on | Load skill |
|---|---|
| Exchange integration, safety rules, risk sizing | `crypto-futures` |
| Strategy logic (EMA, breakout, CVD, funding, liquidation) | `crypto-futures-strategies` |
| Process topology, Redis schema, worker lifecycle | `crypto-futures-bot-architecture` |
| Database models, migration, query patterns | `crypto-futures-bot-db-schema` |
| Bot engine components (DataCollector, StrategyWorker, etc.) | `crypto-futures-bot-engine` |
| FastAPI server, auth, endpoints, WebSocket | `crypto-futures-bot-api` |
| Metrics, health checks, alerts, Telegram | `crypto-futures-bot-monitoring` |
| Next.js dashboard, charts, position panel | `crypto-futures-bot-dashboard` |

## Project Structure

```
[PROJECT_NAME]/
├── bot_engine/
│   ├── main.py                  ← asyncio entry point
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

## Mandatory Rules (Never Break)

1. **Decimal for all prices, qty, PnL, fee** — NO float. Float JSON loses precision silently.
2. **`await ex.load_markets()`** — always async, never call without await.
3. **One asyncio.Lock per symbol in OrderExecutor** — prevents duplicate orders.
4. **Subscribe bot.status BEFORE xadd stream.commands** — avoids race condition.
5. **Exchange API keys NEVER stored in database** — only `api_key_ref` (env var name).
6. **Uvicorn workers=1** — ConnectionManager is not thread-safe, cannot run multi-worker.
7. **Config read from Redis every candle** — do not cache config in StrategyWorker memory.
8. **Shutdown order:** DataCollector → StrategyWorker → RiskManager → OrderExecutor. Never kill OrderExecutor while holding a Lock.
9. **Every exception in the order path must be logged** — no `except: pass`.
10. **asyncio.get_running_loop()** not `get_event_loop()` — deprecated in Python 3.10+.

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

## Environment Variables

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
state.position.{symbol}     JSON: active position
state.price.{symbol}        current price (TTL 10s)
config.worker.{symbol}      JSON: strategy config
stream.signals              Stream: signals from StrategyWorker
stream.orders               Stream: orders from RiskManager
stream.fills                Stream: fills from OrderExecutor
stream.commands             Stream: commands from API
bot.status                  PubSub: status + command responses
position.updates            PubSub: real-time position updates
llm.signal.{symbol}         JSON: LLM signal cache (TTL 480s)
funding.cache.{symbol}      JSON: funding rate cache (TTL 480s)
liq.events.{symbol}         Stream: liquidation events
liq.summary.{symbol}.5m     JSON: rolling 5m liquidation summary
cvd.candles.{symbol}.{tf}   LIST: CVD per candle (maxlen 500)
```

## Important Notes

- **LiquidationCollector** only supports Binance USDM futures. Bybit/OKX → liquidation data unavailable, `liquidation` strategy returns None (graceful degradation).
- **LLMSignalAgent** is an optional soft signal. If LLM fails, strategy keeps running — LLM score only adds confluence, never a trigger.
- **PositionManager** runs every 10 seconds. There is a ~200ms window during SL modification (cancel old, place new) where the position is unprotected. If placing the new SL fails: CRITICAL alert + automatic emergency_close.
- **WebSocket dashboard** — on connect, the server immediately pushes initial state (all positions + bot status) so the dashboard is never blank waiting for the first event.
- **Use testnet first** before live trading. Set `is_testnet: true` in config.worker.{symbol}.

## Agent Layer *(optional — requires `crypto-futures-agent` skill)*

Only fill this section if you are using the AI confirmation layer.

### Additional Mandatory Rules (Agent Layer)

11. **Agent never places orders** — `AgentConfirmer` output is always approve/reject into `stream.signals`. No direct order calls.
12. **`AGENT_PASSTHROUGH_ON_FAIL=true` is the safe default** — trading must never be blocked by LLM downtime.
13. **LLM API keys via env var only** — same rule as exchange keys: `GROQ_API_KEY_1`, `GROQ_API_KEY_2`, etc. Never in Redis or DB.
14. **Decimal for refined SL/TP from agent** — validate via `_safe_decimal()` before use. Discard refinement (keep original) if parsing fails.
15. **One asyncio.Lock per symbol in AgentConfirmer** — same pattern as OrderExecutor.
16. **Do not call LLM if position already open** — check `state.position.{symbol}` before LLM call; discard pre-signal if position exists.

### Agent Environment Variables

```bash
# Agent Layer (optional)
AGENT_ENABLED=true
AGENT_PROVIDER=groq                       # primary provider
AGENT_FALLBACK_CHAIN=openrouter,deepseek  # comma-separated fallback order
AGENT_PRE_SIGNAL_THRESHOLD=0.4
AGENT_PASSTHROUGH_ON_FAIL=true
AGENT_TIMEOUT_SECONDS=20

# Key pools — append _1 _2 _3 for multiple keys per provider
GROQ_API_KEY_1=
GROQ_API_KEY_2=
GROQ_API_KEY_3=
OPENROUTER_API_KEY_1=
DEEPSEEK_API_KEY_1=
GEMINI_API_KEY_1=
OPENAI_API_KEY_1=
ANTHROPIC_API_KEY_1=
```

### Additional Redis Keys (Agent Layer)

```
stream.pre_signals                       Stream: candidate signals pending agent review
llm.pool.{provider}.{idx}.requests_today counter (TTL 86400s — auto daily reset)
llm.pool.{provider}.{idx}.tokens_today   counter (TTL 86400s)
llm.pool.{provider}.{idx}.cooldown_until float unix ts (set on 429)
llm.pool.{provider}.rotation_idx         int — round-robin pointer
```

### config.worker.{symbol} Additional Fields (Agent Layer)

```json
{
    "signal_threshold":     0.6,
    "pre_signal_threshold": 0.4,
    "agent_enabled":        "true"
}
```

---

## [CUSTOMIZE] Project-Specific Info

```
Primary exchange   : [binance / bybit / okx]
Server             : [VPS provider + region]
Dashboard domain   : [https://...]
Telegram chat      : [chat ID]
LLM provider       : [openai / anthropic]
Active strategies  : [trend / breakout / momentum / etc.]
First symbol       : [BTCUSDT / ETHUSDT / etc.]
```
