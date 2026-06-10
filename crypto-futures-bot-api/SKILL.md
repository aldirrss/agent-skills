---
name: crypto-futures-bot-api
description: FastAPI API server for crypto futures trading bot — app setup, cookie auth, REST bot control endpoints, trade/metrics data endpoints, and WebSocket relay from Redis pub/sub to browser clients. Use this whenever the user is building the API layer: FastAPI lifespan, dependency injection, /auth/login, /bot/symbol, /bot/emergency-stop, /trades, /metrics/performance, /metrics/equity-curve, /health, /ws WebSocket, ConnectionManager, send_command() dispatch, or Redis-to-WebSocket relay. Trigger even when the user mentions one component (e.g. "how to relay Redis pub/sub to WebSocket clients", "command dispatch with timeout", "cookie auth for internal tool", "how does the API tell the bot to add a symbol"). API server runs as a SEPARATE process from the bot engine — all bot state changes go through stream.commands, never direct DB writes for order operations.
requires:
  - crypto-futures-bot-architecture
  - crypto-futures-bot-db-schema
---

# Crypto Futures Bot API Server

FastAPI process that sits between the Next.js dashboard and the bot engine. It speaks REST + WebSocket to the browser, and Redis Streams + Pub/Sub to the bot engine. It never calls `exchange.create_order` and never writes to `orders` or `trades` tables directly.

## Process Topology

```
Browser (Next.js)
    │  REST /api/*          │  WebSocket /ws
    ▼                       ▼
┌──────────────────────────────────────────┐
│  API SERVER (FastAPI + uvicorn)           │
│  Auth middleware · REST routers           │
│  ConnectionManager · WS relay task        │
└──────────┬───────────────────────────────┘
           │ stream.commands (WRITE)
           │ Redis state keys (READ)
           │ bot.status pub/sub (READ)
           │ position.updates pub/sub (READ)
           │ PostgreSQL (READ for history/metrics)
           ▼
    Redis + PostgreSQL ←→ Bot Engine
```

## API Endpoint Map

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/auth/login` | public | Password login → set session cookie |
| POST | `/auth/logout` | cookie | Clear session cookie |
| GET | `/bot/status` | cookie | Bot status + active workers from Redis |
| POST | `/bot/symbol` | cookie | Add symbol worker → `stream.commands` |
| DELETE | `/bot/symbol/{symbol}` | cookie | Remove symbol worker |
| POST | `/bot/symbol/{symbol}/pause` | cookie | Pause worker signals |
| POST | `/bot/symbol/{symbol}/resume` | cookie | Resume worker signals |
| PATCH | `/bot/symbol/{symbol}/config` | cookie | Hot-reload worker config |
| POST | `/bot/emergency-stop` | cookie | Emergency close all + stop bot |
| GET | `/trades` | cookie | Trade history (paginated, filterable) |
| GET | `/metrics/performance` | cookie | Win rate, drawdown, PnL, profit factor |
| GET | `/metrics/equity-curve` | cookie | Equity snapshots for charting |
| GET | `/health` | cookie | Bot heartbeat + component health |
| GET | `/health/alerts` | cookie | Active throttled alerts from Redis |
| GET | `/accounts` | cookie | Exchange accounts list |
| WS | `/ws` | cookie | Bidirectional: relay + command responses |

## Auth Pattern

Cookie-based session auth for internal tool use:
1. `POST /auth/login` validates password with bcrypt → stores `session:{token}` in Redis (TTL 24h) → sets HttpOnly cookie
2. Auth middleware reads cookie → validates token against Redis → injects user context
3. WS endpoint validates cookie on upgrade (before `accept()`)
4. `POST /auth/logout` deletes Redis key + clears cookie

Admin password hash stored in env var `ADMIN_PASSWORD_HASH` (never plaintext).

## WebSocket Event Flow

```
Redis pub/sub                  API Server                    Browser
─────────────                  ──────────                    ───────
bot.status     ──message──▶  relay task ──broadcast──▶   WS client
position.updates──message──▶  relay task ──broadcast──▶   WS client

Browser                        API Server                    Bot Engine
───────                        ──────────                    ──────────
WS send(cmd) ──▶  /ws handler ──▶  stream.commands ──▶  CommandListener
                                ◀── bot.status (req_id match) ◀─
```

On WS connect, server pushes initial state (bot status + all open positions) so the dashboard renders immediately without waiting for the next event.

## Fixed Rules

1. **API server never calls `exchange.create_order`** — all order operations go through `stream.commands` to the bot engine.
2. **API server never writes to `orders`, `trades`, or `signals` tables** — those are bot engine's domain. API reads from them for the dashboard.
3. **`send_command()` subscribes to `bot.status` BEFORE publishing** — eliminates the race condition where the response arrives before the listener is ready.
4. **Every command carries a `req_id`** — the bot engine echoes it back so the API can correlate responses across concurrent requests.
5. **WebSocket relay is a single shared task** — one Redis pub/sub connection for all browser clients, not one per client.
6. **Auth cookie is HttpOnly + SameSite=strict** — XSS cannot steal it; CSRF is mitigated.

## Directory Layout

```
api_server/
├── main.py                   ← uvicorn entry point
├── app.py                    ← FastAPI factory + lifespan
├── config.py                 ← Pydantic Settings
├── dependencies.py           ← get_redis, get_session, get_current_user
├── auth/
│   ├── __init__.py
│   ├── router.py             ← POST /auth/login, /auth/logout
│   ├── security.py           ← bcrypt helpers, session token
│   └── middleware.py         ← protect /api/* and /ws
├── routers/
│   ├── __init__.py
│   ├── bot_control.py        ← /bot/* endpoints + send_command()
│   ├── data.py               ← /trades, /metrics, /accounts
│   └── health.py             ← /health, /health/alerts
└── ws/
    ├── __init__.py
    ├── manager.py            ← ConnectionManager
    └── relay.py              ← /ws endpoint + Redis relay task
```

## Reference Files

| Building… | Read |
|---|---|
| App factory, lifespan, CORS, DI, uvicorn entrypoint | `references/app-setup.md` |
| bcrypt, session tokens, login/logout, auth middleware | `references/auth.md` |
| Bot control endpoints, send_command() dispatch | `references/bot-control-endpoints.md` |
| Trade/metrics/health data endpoints | `references/data-endpoints.md` |
| ConnectionManager, /ws endpoint, Redis relay | `references/websocket-relay.md` |
