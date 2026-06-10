# Position Panel

Live position cards, real-time PnL calculation, unrealized PnL color coding.

## Table of contents
- PositionCard component
- Live PnL hook
- Positions page
- Empty state

---

## PositionCard component

```tsx
// components/positions/PositionCard.tsx
"use client"
import { useBotStore, PositionState } from "@/store/botStore"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TrendingUp, TrendingDown, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import { useLivePnL } from "@/hooks/useLivePnL"
import ClosePositionButton from "./ClosePositionButton"
import { formatDuration } from "@/lib/format"

interface Props {
  position: PositionState
}

export default function PositionCard({ position }: Props) {
  const { unrealizedPnl, pnlPct, isLoading } = useLivePnL(position)
  const isLong    = position.direction === "long"
  const isProfit  = (unrealizedPnl ?? 0) >= 0

  return (
    <Card className={cn(
      "bg-slate-900 border transition-colors",
      isLong ? "border-green-500/30" : "border-red-500/30"
    )}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between">
        <div className="flex items-center gap-2">
          {isLong
            ? <TrendingUp size={16} className="text-green-400" />
            : <TrendingDown size={16} className="text-red-400" />}
          <span className="font-semibold text-slate-100">{position.symbol}</span>
          <Badge variant="outline"
            className={cn(
              "text-xs",
              isLong
                ? "border-green-500/40 text-green-400"
                : "border-red-500/40 text-red-400"
            )}>
            {position.direction.toUpperCase()}
          </Badge>
          <Badge variant="outline" className="text-xs border-slate-700 text-slate-400">
            {position.leverage}x
          </Badge>
        </div>
        <ClosePositionButton symbol={position.symbol} />
      </CardHeader>

      <CardContent className="space-y-3">
        {/* PnL — primary metric, most prominent */}
        <div className="text-center py-2">
          <p className={cn(
            "text-2xl font-bold tabular-nums",
            isLoading   ? "text-slate-500" :
            isProfit    ? "text-green-400" : "text-red-400"
          )}>
            {isLoading ? "—" : `${isProfit ? "+" : ""}${unrealizedPnl?.toFixed(4)} USDT`}
          </p>
          <p className={cn(
            "text-sm tabular-nums",
            isProfit ? "text-green-500/70" : "text-red-500/70"
          )}>
            {isLoading ? "" : `${isProfit ? "+" : ""}${pnlPct?.toFixed(2)}%`}
          </p>
        </div>

        {/* Position details */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <PositionRow label="Entry"   value={parseFloat(position.entry_price).toFixed(2)} />
          <PositionRow label="Current" value={position.current_price
            ? parseFloat(position.current_price).toFixed(2) : "—"} />
          <PositionRow label="SL"
            value={parseFloat(position.sl_price).toFixed(2)}
            valueClass="text-red-400" />
          <PositionRow label="TP"
            value={position.tp_price
              ? parseFloat(position.tp_price).toFixed(2) : "—"}
            valueClass="text-green-400" />
          <PositionRow label="Qty"     value={parseFloat(position.qty).toFixed(4)} />
          <PositionRow label="Open"
            value={formatDuration(new Date(parseInt(position.opened_at)).getTime())} />
        </div>
      </CardContent>
    </Card>
  )
}

function PositionRow({ label, value, valueClass }: {
  label: string; value: string; valueClass?: string
}) {
  return (
    <>
      <span className="text-slate-500">{label}</span>
      <span className={cn("text-right font-mono text-slate-300", valueClass)}>
        {value}
      </span>
    </>
  )
}
```

---

## Live PnL hook

Computes unrealized PnL client-side from current price in Zustand store. No API call on every tick.

```typescript
// hooks/useLivePnL.ts
import { useBotStore, PositionState } from "@/store/botStore"
import { useMemo } from "react"

export function useLivePnL(position: PositionState) {
  const currentPriceStr = useBotStore(s => s.positions[position.symbol]?.current_price)

  return useMemo(() => {
    if (!currentPriceStr) return { unrealizedPnl: null, pnlPct: null, isLoading: true }

    const current  = parseFloat(currentPriceStr)
    const entry    = parseFloat(position.entry_price)
    const qty      = parseFloat(position.qty)
    const sign     = position.direction === "long" ? 1 : -1

    const unrealizedPnl = sign * (current - entry) * qty
    const notional      = entry * qty
    const pnlPct        = notional > 0 ? (unrealizedPnl / notional) * 100 : 0

    return { unrealizedPnl, pnlPct, isLoading: false }
  }, [currentPriceStr, position.entry_price, position.qty, position.direction])
}
```

---

## ClosePositionButton

```tsx
// components/positions/ClosePositionButton.tsx
"use client"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { api } from "@/lib/api"
import { useToast } from "@/components/ui/use-toast"
import { X } from "lucide-react"

export default function ClosePositionButton({ symbol }: { symbol: string }) {
  const [loading, setLoading] = useState(false)
  const { toast } = useToast()

  async function handleClose() {
    setLoading(true)
    try {
      await api.removeSymbol(symbol)
      toast({ title: "Close order submitted", description: symbol })
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    } finally {
      setLoading(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button size="icon" variant="ghost"
          className="h-7 w-7 text-slate-500 hover:text-red-400 hover:bg-red-400/10">
          <X size={14} />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="bg-slate-900 border-slate-800">
        <AlertDialogHeader>
          <AlertDialogTitle>Close {symbol}?</AlertDialogTitle>
          <AlertDialogDescription className="text-slate-400">
            This will submit a market close order. The position will close at current market price.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="bg-slate-800 border-slate-700">Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleClose} disabled={loading}
            className="bg-red-600 hover:bg-red-700">
            {loading ? "Submitting…" : "Close Position"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

---

## Positions page

```tsx
// app/(dashboard)/positions/page.tsx
"use client"
import { useBotStore } from "@/store/botStore"
import PositionCard from "@/components/positions/PositionCard"
import EmergencyStopButton from "@/components/controls/EmergencyStopButton"

export default function PositionsPage() {
  const positions = useBotStore(s => Object.values(s.positions))

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-100">Open Positions</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            {positions.length} active position{positions.length !== 1 ? "s" : ""}
          </p>
        </div>
        <EmergencyStopButton />
      </div>

      {positions.length === 0 ? (
        <EmptyPositions />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {positions.map(pos => (
            <PositionCard key={pos.symbol} position={pos} />
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyPositions() {
  return (
    <div className="flex flex-col items-center justify-center h-48
                    border border-dashed border-slate-800 rounded-lg">
      <p className="text-slate-500 text-sm">No open positions</p>
      <p className="text-slate-600 text-xs mt-1">
        Active positions will appear here
      </p>
    </div>
  )
}
```

---

## Format utilities

```typescript
// lib/format.ts
export function formatDuration(openedAtMs: number): string {
  const diffMs = Date.now() - openedAtMs
  const mins   = Math.floor(diffMs / 60_000)
  const hours  = Math.floor(mins / 60)
  const days   = Math.floor(hours / 24)
  if (days > 0)          return `${days}d ${hours % 24}h`
  if (hours > 0)         return `${hours}h ${mins % 60}m`
  return `${mins}m`
}

export function formatPnl(value: number | null | undefined): string {
  if (value == null) return "—"
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(4)} USDT`
}

export function formatPct(value: number | null | undefined): string {
  if (value == null) return "—"
  const sign = value >= 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}%`
}
```
