# Trade History

Trade history table, performance stats cards, and PnL calendar heatmap.

## Table of contents
- PerformanceStatsRow
- TradeHistoryTable
- PnLCalendar
- Trades page

---

## PerformanceStatsRow

```tsx
// components/trades/PerformanceStatsRow.tsx
"use client"
import { useQuery } from "@tanstack/react-query"
import { api } from "@/lib/api"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { TrendingUp, TrendingDown, Target, BarChart2 } from "lucide-react"

interface PerformanceData {
  net_pnl:       number
  win_rate_pct:  number
  profit_factor: number
  max_drawdown_pct: number
  total_trades:  number
  avg_r_multiple: number
}

export default function PerformanceStatsRow() {
  const { data, isLoading } = useQuery<PerformanceData>({
    queryKey: ["performance"],
    queryFn:  api.getPerformance,
  })

  const stats = [
    {
      label: "Net PnL",
      value: data ? `${data.net_pnl >= 0 ? "+" : ""}${data.net_pnl.toFixed(2)}` : "—",
      unit:  "USDT",
      icon:  data?.net_pnl >= 0 ? TrendingUp : TrendingDown,
      color: !data ? "text-slate-400"
                   : data.net_pnl >= 0 ? "text-green-400" : "text-red-400",
    },
    {
      label: "Win Rate",
      value: data ? data.win_rate_pct.toFixed(1) : "—",
      unit:  "%",
      icon:  Target,
      color: !data ? "text-slate-400"
                   : data.win_rate_pct >= 50 ? "text-green-400" : "text-amber-400",
    },
    {
      label: "Profit Factor",
      value: data ? data.profit_factor.toFixed(2) : "—",
      unit:  "×",
      icon:  BarChart2,
      color: !data ? "text-slate-400"
                   : data.profit_factor >= 1.5 ? "text-green-400"
                   : data.profit_factor >= 1   ? "text-amber-400" : "text-red-400",
    },
    {
      label: "Max Drawdown",
      value: data ? data.max_drawdown_pct.toFixed(2) : "—",
      unit:  "%",
      icon:  TrendingDown,
      color: !data ? "text-slate-400"
                   : data.max_drawdown_pct < 10 ? "text-green-400"
                   : data.max_drawdown_pct < 20 ? "text-amber-400" : "text-red-400",
    },
  ]

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map(({ label, value, unit, icon: Icon, color }) => (
        <Card key={label} className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4 pb-3">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-2">
              <Icon size={12} />
              {label}
            </div>
            <p className={cn("text-2xl font-bold tabular-nums", color)}>
              {isLoading ? <span className="text-slate-600">—</span> : value}
              <span className="text-sm font-normal text-slate-500 ml-1">{unit}</span>
            </p>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

---

## TradeHistoryTable

```tsx
// components/trades/TradeHistoryTable.tsx
"use client"
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { api, TradeParams } from "@/lib/api"
import {
  Table, TableBody, TableCell, TableHead,
  TableHeader, TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { ChevronLeft, ChevronRight } from "lucide-react"

const OUTCOME_COLORS: Record<string, string> = {
  tp_hit:          "bg-green-500/20 text-green-400 border-green-500/30",
  sl_hit:          "bg-red-500/20 text-red-400 border-red-500/30",
  manual_close:    "bg-blue-500/20 text-blue-400 border-blue-500/30",
  emergency_close: "bg-amber-500/20 text-amber-400 border-amber-500/30",
}

interface Trade {
  id:          number
  symbol:      string
  strategy:    string
  direction:   "long" | "short"
  entry_price: number
  exit_price:  number | null
  net_pnl:     number | null
  r_multiple:  number | null
  outcome:     string | null
  opened_at:   string
  closed_at:   string | null
  duration_seconds: number | null
}

export default function TradeHistoryTable() {
  const [page, setPage]         = useState(0)
  const [symbol, setSymbol]     = useState<string>("all")
  const [strategy, setStrategy] = useState<string>("all")
  const LIMIT = 20

  const params: TradeParams = {
    limit:    LIMIT,
    offset:   page * LIMIT,
    ...(symbol   !== "all" && { symbol }),
    ...(strategy !== "all" && { strategy }),
  }

  const { data, isLoading } = useQuery({
    queryKey: ["trades", params],
    queryFn:  () => api.getTrades(params),
  })

  const trades: Trade[] = data?.items ?? []
  const total: number   = data?.total ?? 0

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex gap-3">
        <Select value={symbol} onValueChange={setSymbol}>
          <SelectTrigger className="w-36 bg-slate-900 border-slate-700 text-sm">
            <SelectValue placeholder="Symbol" />
          </SelectTrigger>
          <SelectContent className="bg-slate-900 border-slate-800">
            <SelectItem value="all">All symbols</SelectItem>
            <SelectItem value="BTCUSDT">BTCUSDT</SelectItem>
            <SelectItem value="ETHUSDT">ETHUSDT</SelectItem>
          </SelectContent>
        </Select>

        <Select value={strategy} onValueChange={setStrategy}>
          <SelectTrigger className="w-36 bg-slate-900 border-slate-700 text-sm">
            <SelectValue placeholder="Strategy" />
          </SelectTrigger>
          <SelectContent className="bg-slate-900 border-slate-800">
            <SelectItem value="all">All strategies</SelectItem>
            {["trend", "breakout", "momentum", "sr_bounce", "funding", "liquidation"]
              .map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="border-slate-800 hover:bg-transparent">
              {["Symbol","Direction","Entry","Exit","PnL","R","Outcome","Duration","Opened"].map(h => (
                <TableHead key={h} className="text-slate-500 text-xs font-medium">{h}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i} className="border-slate-800">
                  {Array.from({ length: 9 }).map((_, j) => (
                    <TableCell key={j}>
                      <div className="h-4 bg-slate-800 rounded animate-pulse w-16" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : trades.map(trade => (
              <TableRow key={trade.id}
                className="border-slate-800 hover:bg-slate-800/30 text-sm">
                <TableCell className="font-medium text-slate-200">{trade.symbol}</TableCell>
                <TableCell>
                  <span className={cn("text-xs font-medium",
                    trade.direction === "long" ? "text-green-400" : "text-red-400")}>
                    {trade.direction.toUpperCase()}
                  </span>
                </TableCell>
                <TableCell className="font-mono text-slate-300">
                  {trade.entry_price.toFixed(2)}
                </TableCell>
                <TableCell className="font-mono text-slate-300">
                  {trade.exit_price?.toFixed(2) ?? "—"}
                </TableCell>
                <TableCell className={cn("font-mono font-medium",
                  trade.net_pnl == null ? "text-slate-500"
                  : trade.net_pnl >= 0  ? "text-green-400" : "text-red-400")}>
                  {trade.net_pnl == null ? "—"
                   : `${trade.net_pnl >= 0 ? "+" : ""}${trade.net_pnl.toFixed(4)}`}
                </TableCell>
                <TableCell className="font-mono text-slate-400">
                  {trade.r_multiple != null ? `${trade.r_multiple.toFixed(2)}R` : "—"}
                </TableCell>
                <TableCell>
                  {trade.outcome ? (
                    <Badge variant="outline"
                      className={cn("text-xs", OUTCOME_COLORS[trade.outcome] ?? "")}>
                      {trade.outcome.replace("_", " ")}
                    </Badge>
                  ) : <span className="text-slate-600 text-xs">open</span>}
                </TableCell>
                <TableCell className="text-slate-500 text-xs">
                  {trade.duration_seconds != null
                    ? formatDurationSec(trade.duration_seconds)
                    : "—"}
                </TableCell>
                <TableCell className="text-slate-500 text-xs">
                  {new Date(trade.opened_at).toLocaleDateString()}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-slate-500">
        <span>{total} total trades</span>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline"
            className="border-slate-700 bg-slate-900"
            disabled={page === 0} onClick={() => setPage(p => p - 1)}>
            <ChevronLeft size={14} />
          </Button>
          <span>Page {page + 1} of {Math.ceil(total / LIMIT)}</span>
          <Button size="sm" variant="outline"
            className="border-slate-700 bg-slate-900"
            disabled={(page + 1) * LIMIT >= total} onClick={() => setPage(p => p + 1)}>
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  )
}

function formatDurationSec(s: number): string {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}
```

---

## Trades page

```tsx
// app/(dashboard)/trades/page.tsx
import PerformanceStatsRow from "@/components/trades/PerformanceStatsRow"
import TradeHistoryTable   from "@/components/trades/TradeHistoryTable"

export default function TradesPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold text-slate-100">Trade History</h1>
      <PerformanceStatsRow />
      <TradeHistoryTable />
    </div>
  )
}
```
