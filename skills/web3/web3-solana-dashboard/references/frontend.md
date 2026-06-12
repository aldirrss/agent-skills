# Next.js Frontend

App Router + Tailwind CSS + shadcn/ui + lightweight-charts.

---

## WebSocket Provider

Single WS connection per session, shared via React context.

```tsx
// lib/ws-provider.tsx
"use client"

import { createContext, useContext, useEffect, useRef } from "react"
import { useStore } from "./store"

const WsContext = createContext<null>(null)

export function WsProvider({ children }: { children: React.ReactNode }) {
  const ws = useRef<WebSocket | null>(null)
  const { setStatus, upsertPosition, removePosition } = useStore()

  useEffect(() => {
    const connect = () => {
      ws.current = new WebSocket(
        process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8001/ws"
      )

      ws.current.onmessage = (e) => {
        const event = JSON.parse(e.data)

        switch (event.type) {
          case "position_updates":
            upsertPosition(event)
            break
          case "position_closed":
            removePosition(event.mint)
            break
          case "bot_status":
            setStatus(event.status)
            break
        }
      }

      ws.current.onclose = () => {
        // Reconnect after 3s
        setTimeout(connect, 3000)
      }
    }

    connect()
    return () => ws.current?.close()
  }, [])

  return <WsContext.Provider value={null}>{children}</WsContext.Provider>
}
```

---

## Zustand Store

```tsx
// lib/store.ts
import { create } from "zustand"

type Position = {
  mint:          string
  symbol:        string
  entry_price:   string
  current_price: string
  pnl_usdc:      string
  pnl_pct:       number
  amount_tokens: string
}

type Store = {
  status:          string
  positions:       Record<string, Position>
  setStatus:       (s: string) => void
  upsertPosition:  (p: Position) => void
  removePosition:  (mint: string) => void
}

export const useStore = create<Store>((set) => ({
  status:    "unknown",
  positions: {},

  setStatus: (status) => set({ status }),

  upsertPosition: (pos) =>
    set((s) => ({ positions: { ...s.positions, [pos.mint]: pos } })),

  removePosition: (mint) =>
    set((s) => {
      const next = { ...s.positions }
      delete next[mint]
      return { positions: next }
    }),
}))
```

---

## dashboard/page.tsx — Overview

```tsx
// app/(dashboard)/dashboard/page.tsx
import { Suspense } from "react"
import { BotStatusCard } from "@/components/bot-status-card"
import { OpenPositionsPanel } from "@/components/open-positions-panel"
import { PerformanceSummary } from "@/components/performance-summary"

export default function DashboardPage() {
  return (
    <div className="space-y-6 p-6">
      <BotStatusCard />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Suspense fallback={null}>
          <PerformanceSummary />
        </Suspense>
      </div>
      <OpenPositionsPanel />
    </div>
  )
}
```

---

## BotStatusCard Component

```tsx
// components/bot-status-card.tsx
"use client"

import { useStore } from "@/lib/store"
import { useQuery } from "@tanstack/react-query"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  paused:  "bg-amber-500",
  stopped: "bg-slate-400",
  unknown: "bg-slate-600",
}

export function BotStatusCard() {
  const liveStatus = useStore((s) => s.status)

  const { data } = useQuery({
    queryKey: ["bot-status"],
    queryFn:  () => fetch("/api/bot/status").then((r) => r.json()),
    refetchInterval: 10_000,
  })

  const status          = liveStatus !== "unknown" ? liveStatus : data?.status ?? "unknown"
  const circuitBreaker  = data?.circuit_breaker ?? "closed"
  const dailyLossPct    = data?.daily_loss_pct ?? 0
  const openPositions   = data?.open_positions ?? 0

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader>
        <CardTitle className="text-slate-200 text-sm font-medium">Bot Status</CardTitle>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <Badge className={STATUS_COLORS[status]}>{status.toUpperCase()}</Badge>

        {circuitBreaker === "open" && (
          <Badge className="bg-red-600 animate-pulse">CIRCUIT BREAKER OPEN</Badge>
        )}

        <span className="text-slate-400 text-sm">
          {openPositions} open · Daily PnL:{" "}
          <span className={dailyLossPct >= 0 ? "text-green-400" : "text-red-400"}>
            {dailyLossPct.toFixed(2)}%
          </span>
        </span>
      </CardContent>
    </Card>
  )
}
```

---

## OpenPositionsPanel Component

```tsx
// components/open-positions-panel.tsx
"use client"

import { useStore } from "@/lib/store"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export function OpenPositionsPanel() {
  const positions = useStore((s) => Object.values(s.positions))

  if (positions.length === 0) {
    return (
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-slate-200 text-sm font-medium">
            Open Positions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-slate-500 text-sm">No open positions.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="bg-slate-900 border-slate-800">
      <CardHeader>
        <CardTitle className="text-slate-200 text-sm font-medium">
          Open Positions ({positions.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-500 text-left border-b border-slate-800">
              <th className="pb-2">Token</th>
              <th className="pb-2">Entry</th>
              <th className="pb-2">Current</th>
              <th className="pb-2 text-right">PnL</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => (
              <tr key={pos.mint} className="border-b border-slate-800/50">
                <td className="py-2 text-slate-200 font-medium">{pos.symbol}</td>
                <td className="py-2 text-slate-400">${pos.entry_price}</td>
                <td className="py-2 text-slate-300">${pos.current_price}</td>
                <td className={`py-2 text-right font-medium ${
                  pos.pnl_pct >= 0 ? "text-green-400" : "text-red-400"
                }`}>
                  {pos.pnl_pct >= 0 ? "+" : ""}{pos.pnl_pct.toFixed(2)}%
                  <span className="text-slate-500 text-xs ml-1">
                    (${pos.pnl_usdc})
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}
```

---

## trades/page.tsx — Trade History

```tsx
// app/(dashboard)/trades/page.tsx
"use client"

import { useQuery } from "@tanstack/react-query"
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

export default function TradesPage() {
  const [page, setPage] = useState(1)

  const { data, isLoading } = useQuery({
    queryKey: ["trades", page],
    queryFn: () =>
      fetch(`/api/trades?page=${page}&limit=50`).then((r) => r.json()),
    placeholderData: (prev) => prev,
  })

  const { data: perf } = useQuery({
    queryKey: ["performance"],
    queryFn: () => fetch("/api/metrics/performance").then((r) => r.json()),
    refetchInterval: 60_000,
  })

  return (
    <div className="space-y-6 p-6">
      {/* Performance summary row */}
      {perf && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: "Total Trades", value: perf.total_trades },
            { label: "Win Rate", value: `${perf.win_rate}%` },
            { label: "Total PnL", value: `$${perf.total_pnl_usdc}` },
            { label: "Avg PnL", value: `$${perf.avg_pnl_usdc}` },
          ].map((m) => (
            <Card key={m.label} className="bg-slate-900 border-slate-800">
              <CardContent className="pt-4">
                <p className="text-slate-500 text-xs">{m.label}</p>
                <p className="text-slate-100 text-xl font-bold">{m.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Trade history table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader>
          <CardTitle className="text-slate-200 text-sm font-medium">
            Trade History
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-slate-500 text-sm">Loading…</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-slate-500 text-left border-b border-slate-800">
                  <th className="pb-2">Token</th>
                  <th className="pb-2">Strategy</th>
                  <th className="pb-2 text-right">PnL USDC</th>
                  <th className="pb-2 text-right">PnL %</th>
                  <th className="pb-2 text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {data?.items?.map((t: any) => (
                  <tr key={`${t.mint}-${t.created_at}`}
                      className="border-b border-slate-800/50">
                    <td className="py-2 text-slate-200">{t.symbol}</td>
                    <td className="py-2 text-slate-400 text-xs">{t.strategy}</td>
                    <td className={`py-2 text-right font-medium ${
                      t.pnl_usdc >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {t.pnl_usdc >= 0 ? "+" : ""}${t.pnl_usdc}
                    </td>
                    <td className={`py-2 text-right ${
                      t.pnl_pct >= 0 ? "text-green-400" : "text-red-400"
                    }`}>
                      {t.pnl_pct >= 0 ? "+" : ""}{t.pnl_pct?.toFixed(2)}%
                    </td>
                    <td className="py-2 text-right text-slate-500 text-xs">
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
```

---

## control/page.tsx — Bot Control

```tsx
// app/(dashboard)/control/page.tsx
"use client"

import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"

const COMMANDS = [
  { cmd: "START",          label: "Start",           variant: "default"     },
  { cmd: "PAUSE",          label: "Pause",           variant: "outline"     },
  { cmd: "RESUME",         label: "Resume",          variant: "outline"     },
  { cmd: "STOP",           label: "Stop",            variant: "destructive" },
  { cmd: "EMERGENCY_STOP", label: "Emergency Stop",  variant: "destructive" },
] as const

export default function ControlPage() {
  const qc = useQueryClient()

  const { mutate, isPending } = useMutation({
    mutationFn: (cmd: string) =>
      fetch("/api/bot/command", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ cmd }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bot-status"] })
    },
  })

  return (
    <div className="p-6">
      <Card className="bg-slate-900 border-slate-800 max-w-md">
        <CardHeader>
          <CardTitle className="text-slate-200 text-sm font-medium">
            Bot Control
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          {COMMANDS.map(({ cmd, label, variant }) => (
            <Button
              key={cmd}
              variant={variant as any}
              disabled={isPending}
              onClick={() => mutate(cmd)}
              className={cmd === "EMERGENCY_STOP" ? "w-full mt-4" : ""}
            >
              {label}
            </Button>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
```

---

## next.config.ts

```ts
// next.config.ts
import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source:      "/api/:path*",
        destination: `${process.env.API_URL ?? "http://localhost:8001"}/api/:path*`,
      },
      {
        source:      "/ws",
        destination: `${process.env.WS_URL ?? "ws://localhost:8001"}/ws`,
      },
    ]
  },
}

export default nextConfig
```

---

## .env.local

```bash
NEXT_PUBLIC_WS_URL=ws://localhost:8001/ws
API_URL=http://localhost:8001
```
