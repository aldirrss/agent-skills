---
name: crypto-futures-bot-dashboard
description: Next.js (latest) trading bot dashboard with real-time WebSocket, lightweight-charts candlestick charts, position monitoring, and bot controls. Use this whenever the user is building any part of the trading bot frontend — pages, components, WebSocket hooks, charts, position cards, trade history, or bot control UI. Trigger on mentions of dashboard, position monitor, equity curve, candlestick chart, bot control panel, add symbol form, emergency stop button, trade history table, or performance metrics UI. Requires crypto-futures-bot-architecture for API endpoints and WebSocket event schema.
requires:
  - crypto-futures-bot-architecture
  - crypto-futures-bot-api
---

# Crypto Futures Bot Dashboard

Next.js (App Router, latest) + Tailwind CSS + shadcn/ui + lightweight-charts. Multi-page trading dashboard that connects to the FastAPI bot engine via REST and WebSocket.

## Tech Stack

```
next: latest (App Router)
tailwindcss: latest
shadcn/ui: latest          (Card, Table, Badge, Dialog, Form, Select, Toast)
lightweight-charts: latest (candlestick + equity curve)
@tanstack/react-query: latest (server state, REST fetching)
zustand: latest            (client state: WS events, bot status)
lucide-react: latest       (icons)
```

## Page Map

```
app/
├── (auth)/
│   └── login/page.tsx          ← simple password gate
├── (dashboard)/
│   ├── layout.tsx              ← sidebar + WS provider
│   ├── page.tsx                → redirect /dashboard
│   ├── dashboard/page.tsx      ← Overview: equity curve + positions + status
│   ├── positions/page.tsx      ← Active positions detail
│   ├── trades/page.tsx         ← Trade history + performance metrics
│   └── settings/page.tsx       ← Accounts + workers + alert config
```

## Design Tokens

Trading dashboards need a dark theme with precise status colors. Use these consistently:

```css
/* globals.css additions */
:root {
  --color-long:        #22c55e;   /* green-500 — long positions, profits */
  --color-short:       #ef4444;   /* red-500 — short positions, losses */
  --color-neutral:     #94a3b8;   /* slate-400 — neutral/unknown */
  --color-warning:     #f59e0b;   /* amber-500 — warnings */
  --color-critical:    #dc2626;   /* red-600 — critical alerts */
  --color-chart-bg:    #0f172a;   /* slate-900 — chart background */
  --color-chart-grid:  #1e293b;   /* slate-800 — grid lines */
  --color-candle-up:   #22c55e;
  --color-candle-down: #ef4444;
}
```

## WebSocket Event Schema

Dashboard subscribes to two Redis pub/sub channels via the WS endpoint:

```typescript
// bot.status events
type BotStatusEvent = {
  req_id?:  string          // present for command responses
  status:   "ok" | "error"
  message:  string
  data?:    string          // JSON string with response payload
  ts:       string
}

// position.updates events
type PositionUpdateEvent = {
  symbol:    string
  status:    "open" | "closed"
  position?: PositionState  // present when status = "open"
  outcome?:  string         // present when status = "closed"
  net_pnl?:  string         // present when status = "closed"
  ts:        string
}
```

## Component Hierarchy

```
DashboardLayout
├── Sidebar (nav + bot status badge)
├── WebSocketProvider (global WS connection)
│
├── /dashboard
│   ├── BotStatusBar          (running/paused/stopped + active workers)
│   ├── EquityCurveChart      (lightweight-charts, 24h)
│   ├── OpenPositionsSummary  (compact cards)
│   └── RecentAlertsFeed      (last 10 alert events)
│
├── /positions
│   ├── PositionCard[]        (per symbol, live PnL)
│   └── EmergencyStopButton
│
├── /trades
│   ├── PerformanceStatsRow   (win rate, net PnL, drawdown, Sharpe)
│   ├── TradeHistoryTable     (sortable, filterable)
│   └── PnLCalendar           (daily PnL heatmap)
│
└── /settings
    ├── ExchangeAccountsPanel
    ├── WorkerConfigPanel
    └── AlertSettingsPanel
```

## Key Rules

1. **Never poll — use React Query for REST, Zustand for WS state**. Polling kills the server and creates stale UI.
2. **Live PnL is computed client-side** from `entry_price`, `current_price` (from WS), and `qty` — never fetched from API on every tick.
3. **Emergency stop requires confirmation dialog** — no single-click destructive actions.
4. **All monetary values display 4 decimal places** for USDT, 2 for percentages.
5. **Color long=green, short=red consistently** — never invert, never use for other purposes.

## Reference Files

| Building… | Read |
|---|---|
| App Router layout, sidebar, auth guard, page skeletons | `references/layout-routing.md` |
| useWebSocket hook, Zustand store, event routing | `references/websocket-client.md` |
| lightweight-charts candlestick, EMA overlay, equity curve | `references/chart-components.md` |
| PositionCard, live PnL, unrealized color coding | `references/position-panel.md` |
| Trade table, performance stats, PnL calendar | `references/trade-history.md` |
| BotControls, AddSymbol form, EmergencyStop dialog | `references/bot-controls.md` |
