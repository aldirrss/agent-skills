---
name: web3-solana-dashboard
description: >
  Full-stack trading dashboard for the Solana DEX bot — FastAPI bridge server
  (Redis pub/sub → WebSocket, Redis state → REST, PostgreSQL → REST) and Next.js
  frontend (real-time positions, trade history, strategy performance, bot control).
  Use this whenever the user is building any part of the dashboard: API server,
  WebSocket relay, trade history table, PnL chart, open positions panel, bot
  control UI, strategy stats, or KOL wallet leaderboard. Trigger on: "dashboard",
  "frontend", "UI", "trade history", "open positions panel", "WebSocket", "PnL chart",
  "strategy performance", "bot control UI", "equity curve", "win rate UI".
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-db-schema
---

# web3-solana-dashboard

Two-process setup: a **FastAPI bridge server** that exposes Redis state and PostgreSQL
history over HTTP + WebSocket, and a **Next.js frontend** that consumes it.

The bot engine process and the dashboard API server run independently — they only share
Redis and PostgreSQL.

---

## Architecture

```
Bot Engine (asyncio)
    │
    ├── writes → Redis pub/sub (position.updates, state.bot.status)
    ├── writes → Redis keys (state.position.*, state.price.*)
    └── writes → PostgreSQL (trades, strategy_stats, signal_rejections)

FastAPI Bridge Server (separate process)
    ├── GET  /api/positions      ← reads Redis state.position.*
    ├── GET  /api/bot/status     ← reads Redis state.bot.status
    ├── POST /api/bot/command    ← XADD stream.commands
    ├── GET  /api/trades         ← queries PostgreSQL trades table
    ├── GET  /api/metrics/performance  ← aggregates PostgreSQL
    ├── GET  /api/metrics/strategy     ← reads PostgreSQL strategy_stats
    ├── GET  /api/wallets/kol          ← reads PostgreSQL kol_wallets
    └── WS   /ws                 ← relays Redis pub/sub to browser

Next.js Frontend (browser)
    ├── React Query  ← REST polling for historical data
    ├── zustand      ← live state from WebSocket events
    └── lightweight-charts  ← PnL equity curve
```

---

## Data Sources

| Data | Source | Update frequency |
|---|---|---|
| Open positions | Redis `state.position.{mint}` | Real-time (via WebSocket `position.updates`) |
| Bot status | Redis `state.bot.status` | Real-time (via WebSocket) |
| Live PnL | Redis `state.position.*` + `state.price.*` | Polled every 5s |
| Trade history | PostgreSQL `trades` | On-demand (paginated REST) |
| Win rate / total PnL | PostgreSQL `trades` aggregation | Polled every 60s |
| Per-strategy stats | PostgreSQL `strategy_stats` | Polled every 60s |
| KOL wallet leaderboard | PostgreSQL `kol_wallets` | Polled every 5 min |
| Signal rejection log | PostgreSQL `signal_rejections` | On-demand (paginated REST) |

---

## Tech Stack

### API Server
```
fastapi          # async API server
uvicorn          # ASGI server
redis[hiredis]   # Redis async client
asyncpg          # PostgreSQL async driver
python-dotenv    # env config
```

### Frontend
```
next            latest (App Router)
tailwindcss     latest
shadcn/ui       latest   (Card, Table, Badge, Button, Dialog, Toast)
lightweight-charts latest  (equity curve)
@tanstack/react-query latest (REST data fetching + caching)
zustand         latest   (WebSocket live state)
lucide-react    latest   (icons)
```

---

## Page Map

```
app/
├── (auth)/login/page.tsx             ← password gate (cookie session)
├── (dashboard)/
│   ├── layout.tsx                    ← sidebar + WebSocket provider
│   ├── dashboard/page.tsx            ← Overview: status + positions + PnL
│   ├── trades/page.tsx               ← Trade history + performance metrics
│   ├── strategies/page.tsx           ← Per-strategy breakdown
│   ├── wallets/page.tsx              ← KOL wallet leaderboard
│   └── control/page.tsx             ← Bot commands + circuit breaker
```

---

## Design Tokens

```css
/* globals.css */
:root {
  --color-profit:      #22c55e;   /* green-500 — profit, buy, positive */
  --color-loss:        #ef4444;   /* red-500 — loss, sell, negative */
  --color-neutral:     #94a3b8;   /* slate-400 — neutral/unknown */
  --color-warning:     #f59e0b;   /* amber-500 — warnings */
  --color-critical:    #dc2626;   /* red-600 — circuit breaker, emergency */
  --color-chart-bg:    #0f172a;   /* slate-900 — chart background */
  --color-chart-grid:  #1e293b;   /* slate-800 — grid lines */
}
```

Bot status badge colors:
- `running` → green (`--color-profit`)
- `paused` → amber (`--color-warning`)
- `stopped` → slate (`--color-neutral`)
- circuit breaker open → red (`--color-critical`)

---

## WebSocket Event Schema

The `/ws` endpoint relays two Redis pub/sub channels to the browser:

```typescript
// position.updates — emitted by PositionTracker after every fill or PnL tick
type PositionUpdateEvent = {
  type:          "position.update"
  mint:          string
  symbol:        string
  side:          "LONG"
  entry_price:   string
  current_price: string
  amount_tokens: string
  pnl_usdc:      string
  pnl_pct:       number
  ts:            string
}

// position.closed — emitted when SELL fill confirmed
type PositionClosedEvent = {
  type:       "position.closed"
  mint:       string
  symbol:     string
  pnl_usdc:   string
  pnl_pct:    number
  reason:     "stop_loss" | "take_profit" | "max_hold_time" | "emergency_stop" | "strategy"
  ts:         string
}

// bot.status — emitted on any status change
type BotStatusEvent = {
  type:    "bot.status"
  status:  "running" | "paused" | "stopped"
  ts:      string
}

// command.ack — response to POST /api/bot/command
type CommandAckEvent = {
  type:    "command.ack"
  cmd:     string
  status:  "ok" | "error"
  message: string
  ts:      string
}
```

---

## REST API Endpoints

```
GET  /api/positions
     → list[PositionState]  (from Redis state.position.* + state.price.*)

GET  /api/bot/status
     → { status: string, circuit_breaker: "open"|"closed", daily_loss_pct: float }

POST /api/bot/command
     body: { cmd: "START"|"STOP"|"PAUSE"|"RESUME"|"EMERGENCY_STOP" }
     → { queued: true }  (XADD stream.commands, no wait for ack)

GET  /api/trades?page=1&limit=50&strategy=kol_copy_trade&side=BUY
     → { items: list[Trade], total: int, page: int }

GET  /api/metrics/performance
     → { total_trades, win_rate, total_pnl_usdc, avg_pnl_usdc, best_trade, worst_trade }

GET  /api/metrics/strategy
     → list[{ strategy, total_trades, win_rate, total_pnl_usdc, avg_hold_time_s }]

GET  /api/wallets/kol?limit=20
     → list[{ address, label, total_trades, win_rate, total_pnl_usdc }]

GET  /api/rejections?page=1&limit=50&reason=circuit_breaker
     → { items: list[SignalRejection], total: int }
```

---

## Reference Files

| Building… | Read |
|---|---|
| FastAPI bridge server (full implementation) | `references/api-server.md` |
| Next.js page implementations + key components | `references/frontend.md` |
