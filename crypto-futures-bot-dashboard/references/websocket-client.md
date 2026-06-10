# WebSocket Client

useWebSocket hook, Zustand store, reconnect logic, and event routing.

## Table of contents
- Zustand store
- WebSocketProvider
- useWebSocket hook
- Event routing
- API client (REST)

---

## Zustand store

Single source of truth for all real-time bot state.

```typescript
// store/botStore.ts
import { create } from "zustand"

export type BotStatus = "running" | "paused" | "stopped" | "unknown"

export interface PositionState {
  symbol:      string
  direction:   "long" | "short"
  qty:         string
  entry_price: string
  sl_price:    string
  tp_price?:   string
  leverage:    string
  opened_at:   string
  // computed client-side:
  current_price?: string
  unrealized_pnl?: number
}

export interface TradeAlert {
  id:         string
  type:       string
  symbol:     string
  message:    string
  severity:   "info" | "warning" | "critical"
  ts:         string
}

interface BotStore {
  // Connection
  wsConnected:    boolean
  setWsConnected: (v: boolean) => void

  // Bot state
  botStatus:       BotStatus
  activeWorkers:   string[]
  setBotStatus:    (s: BotStatus) => void
  setWorkers:      (w: string[]) => void

  // Positions (keyed by symbol)
  positions:       Record<string, PositionState>
  openPosition:    (pos: PositionState) => void
  closePosition:   (symbol: string) => void
  updatePrice:     (symbol: string, price: number) => void

  // Alerts feed (last 50)
  alerts:          TradeAlert[]
  addAlert:        (a: TradeAlert) => void

  // Pending commands (req_id → resolve fn)
  pendingCmds:     Record<string, (result: unknown) => void>
  addPending:      (reqId: string, resolve: (r: unknown) => void) => void
  resolvePending:  (reqId: string, result: unknown) => void
}

export const useBotStore = create<BotStore>((set, get) => ({
  wsConnected:    false,
  setWsConnected: v => set({ wsConnected: v }),

  botStatus:    "unknown",
  activeWorkers: [],
  setBotStatus: s => set({ botStatus: s }),
  setWorkers:   w => set({ activeWorkers: w }),

  positions:     {},
  openPosition:  pos => set(s => ({
    positions: { ...s.positions, [pos.symbol]: pos },
  })),
  closePosition: symbol => set(s => {
    const { [symbol]: _, ...rest } = s.positions
    return { positions: rest }
  }),
  updatePrice: (symbol, price) => set(s => {
    const pos = s.positions[symbol]
    if (!pos) return {}
    const entry = parseFloat(pos.entry_price)
    const qty   = parseFloat(pos.qty)
    const sign  = pos.direction === "long" ? 1 : -1
    const unrealized_pnl = sign * (price - entry) * qty
    return {
      positions: {
        ...s.positions,
        [symbol]: { ...pos, current_price: String(price), unrealized_pnl },
      },
    }
  }),

  alerts:     [],
  addAlert:   a => set(s => ({
    alerts: [a, ...s.alerts].slice(0, 50),
  })),

  pendingCmds: {},
  addPending:  (reqId, resolve) => set(s => ({
    pendingCmds: { ...s.pendingCmds, [reqId]: resolve },
  })),
  resolvePending: (reqId, result) => {
    const fn = get().pendingCmds[reqId]
    if (fn) {
      fn(result)
      set(s => {
        const { [reqId]: _, ...rest } = s.pendingCmds
        return { pendingCmds: rest }
      })
    }
  },
}))
```

---

## WebSocketProvider

```tsx
// components/providers/WebSocketProvider.tsx
"use client"
import { createContext, useContext, useEffect, useRef } from "react"
import { useBotStore } from "@/store/botStore"
import { routeWsEvent } from "@/lib/wsEventRouter"

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws"

const WebSocketContext = createContext<{ send: (data: string) => void }>({
  send: () => {},
})

export function useWsSend() {
  return useContext(WebSocketContext).send
}

export default function WebSocketProvider({ children }: { children: React.ReactNode }) {
  const wsRef          = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<NodeJS.Timeout>()
  const store          = useBotStore

  function connect() {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      store.getState().setWsConnected(true)
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        routeWsEvent(data, store.getState())
      } catch (e) {
        console.error("WS parse error", e)
      }
    }

    ws.onclose = () => {
      store.getState().setWsConnected(false)
      // Reconnect after 3s
      reconnectTimer.current = setTimeout(connect, 3_000)
    }

    ws.onerror = () => ws.close()
  }

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [])

  function send(data: string) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data)
    }
  }

  return (
    <WebSocketContext.Provider value={{ send }}>
      {children}
    </WebSocketContext.Provider>
  )
}
```

---

## Event routing

```typescript
// lib/wsEventRouter.ts
import { BotStore, TradeAlert } from "@/store/botStore"
import { nanoid } from "nanoid"

export function routeWsEvent(data: Record<string, unknown>, store: BotStore): void {
  // Command response (has req_id)
  if (data.req_id) {
    store.resolvePending(data.req_id as string, data)
    return
  }

  // Position update
  if ("status" in data && "symbol" in data && !("req_id" in data)) {
    const event = data as {
      symbol: string; status: "open" | "closed";
      position?: Record<string, string>; outcome?: string; net_pnl?: string
    }
    if (event.status === "open" && event.position) {
      store.openPosition({ symbol: event.symbol, ...event.position } as any)
    } else if (event.status === "closed") {
      store.closePosition(event.symbol)
      store.addAlert({
        id:       nanoid(),
        type:     "trade_closed",
        symbol:   event.symbol,
        message:  `Closed ${event.symbol} — ${event.outcome} — PnL: ${event.net_pnl} USDT`,
        severity: (parseFloat(event.net_pnl ?? "0") >= 0) ? "info" : "warning",
        ts:       String(Date.now()),
      })
    }
    return
  }

  // Bot status broadcast
  if ("status" in data && "message" in data) {
    const event = data as { status: string; message: string; data?: string }
    if (event.data) {
      try {
        const parsed = JSON.parse(event.data)
        if (parsed.status)  store.setBotStatus(parsed.status)
        if (parsed.workers) store.setWorkers(parsed.workers)
      } catch (_) {}
    }
    store.addAlert({
      id:       nanoid(),
      type:     "bot_event",
      symbol:   "global",
      message:  event.message,
      severity: event.status === "error" ? "warning" : "info",
      ts:       String(Date.now()),
    })
  }
}
```

---

## API client (REST)

```typescript
// lib/api.ts
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    credentials: "include",
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail ?? "API error")
  }
  return res.json()
}

export const api = {
  // Bot control
  getStatus:       ()                        => apiFetch("/bot/status"),
  addSymbol:       (body: AddSymbolPayload)  => apiFetch("/bot/symbol", { method: "POST", body: JSON.stringify(body) }),
  removeSymbol:    (symbol: string)          => apiFetch(`/bot/symbol/${symbol}`, { method: "DELETE" }),
  pauseSymbol:     (symbol: string)          => apiFetch(`/bot/symbol/${symbol}/pause`, { method: "POST" }),
  resumeSymbol:    (symbol: string)          => apiFetch(`/bot/symbol/${symbol}/resume`, { method: "POST" }),
  updateConfig:    (symbol: string, cfg: object) => apiFetch(`/bot/symbol/${symbol}/config`, { method: "PATCH", body: JSON.stringify(cfg) }),
  emergencyStop:   ()                        => apiFetch("/bot/emergency-stop", { method: "POST" }),

  // Data
  getTrades:       (params: TradeParams)     => apiFetch(`/trades?${new URLSearchParams(params as any)}`),
  getEquityCurve:  (hours = 24)              => apiFetch(`/metrics/equity-curve?hours=${hours}`),
  getPerformance:  ()                        => apiFetch("/metrics/performance"),
  getAccounts:     ()                        => apiFetch("/accounts"),
}

export interface AddSymbolPayload {
  symbol:    string
  strategy:  string
  leverage:  number
  risk_pct:  number
  timeframe: string
}

export interface TradeParams {
  limit?:     number
  offset?:    number
  symbol?:    string
  strategy?:  string
  from_date?: string
  to_date?:   string
}
```
