# Chart Components

lightweight-charts setup, candlestick with EMA overlay, equity curve, real-time updates.

## Table of contents
- Installation & wrapper
- CandlestickChart component
- EMA overlay
- EquityCurveChart component
- Real-time update pattern

---

## Installation & wrapper

```bash
npm install lightweight-charts
```

```tsx
// components/charts/ChartWrapper.tsx
"use client"
import { useEffect, useRef } from "react"
import { createChart, IChartApi, ColorType } from "lightweight-charts"

interface ChartWrapperProps {
  onChartReady: (chart: IChartApi, container: HTMLDivElement) => void
  height?: number
  className?: string
}

export default function ChartWrapper({ onChartReady, height = 400, className }: ChartWrapperProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef     = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      height,
      layout: {
        background: { type: ColorType.Solid, color: "#0f172a" },  // slate-900
        textColor:  "#94a3b8",                                      // slate-400
      },
      grid: {
        vertLines:  { color: "#1e293b" },   // slate-800
        horzLines:  { color: "#1e293b" },
      },
      crosshair: {
        vertLine:   { color: "#475569" },   // slate-600
        horzLine:   { color: "#475569" },
      },
      rightPriceScale:  { borderColor: "#334155" },
      timeScale:        { borderColor: "#334155", timeVisible: true },
    })

    chartRef.current = chart
    onChartReady(chart, containerRef.current)

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
    }
  }, [])

  return <div ref={containerRef} className={className} style={{ height }} />
}
```

---

## CandlestickChart component

```tsx
// components/charts/CandlestickChart.tsx
"use client"
import { useEffect, useRef, useCallback } from "react"
import { IChartApi, ISeriesApi, CandlestickData, LineData,
         createChart, ColorType, UTCTimestamp } from "lightweight-charts"
import ChartWrapper from "./ChartWrapper"

interface Props {
  symbol:     string
  candles:    CandleBar[]
  ema9?:      number[]
  ema21?:     number[]
  ema50?:     number[]
  height?:    number
}

export interface CandleBar {
  ts:    number   // unix seconds
  open:  number
  high:  number
  low:   number
  close: number
  vol:   number
}

export default function CandlestickChart({ symbol, candles, ema9, ema21, ema50, height = 400 }: Props) {
  const seriesRef = useRef<{
    candle: ISeriesApi<"Candlestick"> | null
    ema9:   ISeriesApi<"Line"> | null
    ema21:  ISeriesApi<"Line"> | null
    ema50:  ISeriesApi<"Line"> | null
  }>({ candle: null, ema9: null, ema21: null, ema50: null })

  const onChartReady = useCallback((chart: IChartApi) => {
    // Candlestick series
    const candleSeries = chart.addCandlestickSeries({
      upColor:          "#22c55e",
      downColor:        "#ef4444",
      borderUpColor:    "#22c55e",
      borderDownColor:  "#ef4444",
      wickUpColor:      "#22c55e",
      wickDownColor:    "#ef4444",
    })
    seriesRef.current.candle = candleSeries

    // EMA lines
    const emaColors = { ema9: "#f59e0b", ema21: "#3b82f6", ema50: "#8b5cf6" }
    if (ema9) {
      seriesRef.current.ema9 = chart.addLineSeries({
        color: emaColors.ema9, lineWidth: 1, priceLineVisible: false,
      })
    }
    if (ema21) {
      seriesRef.current.ema21 = chart.addLineSeries({
        color: emaColors.ema21, lineWidth: 1, priceLineVisible: false,
      })
    }
    if (ema50) {
      seriesRef.current.ema50 = chart.addLineSeries({
        color: emaColors.ema50, lineWidth: 1.5, priceLineVisible: false,
      })
    }

    // Set data
    _setData(candles, ema9, ema21, ema50)
    chart.timeScale().fitContent()
  }, [])

  function _setData(candles: CandleBar[], e9?: number[], e21?: number[], e50?: number[]) {
    const s = seriesRef.current
    if (!s.candle) return

    s.candle.setData(candles.map(c => ({
      time:  (c.ts / 1000) as UTCTimestamp,
      open:  c.open, high: c.high, low: c.low, close: c.close,
    })))

    if (s.ema9 && e9) {
      s.ema9.setData(candles.map((c, i) => ({
        time: (c.ts / 1000) as UTCTimestamp, value: e9[i],
      })).filter(d => d.value != null))
    }
    if (s.ema21 && e21) {
      s.ema21.setData(candles.map((c, i) => ({
        time: (c.ts / 1000) as UTCTimestamp, value: e21[i],
      })).filter(d => d.value != null))
    }
    if (s.ema50 && e50) {
      s.ema50.setData(candles.map((c, i) => ({
        time: (c.ts / 1000) as UTCTimestamp, value: e50[i],
      })).filter(d => d.value != null))
    }
  }

  // Update single candle (real-time, O(1))
  function updateCandle(bar: CandleBar) {
    seriesRef.current.candle?.update({
      time:  (bar.ts / 1000) as UTCTimestamp,
      open:  bar.open, high: bar.high, low: bar.low, close: bar.close,
    })
  }

  // Re-set when candles prop changes (symbol switch)
  useEffect(() => {
    _setData(candles, ema9, ema21, ema50)
  }, [symbol, candles])

  return (
    <div className="rounded-lg overflow-hidden border border-slate-800">
      <div className="px-4 py-2 bg-slate-900 flex items-center gap-4 text-sm">
        <span className="font-medium text-slate-100">{symbol}</span>
        <span className="text-amber-400">EMA9</span>
        <span className="text-blue-400">EMA21</span>
        <span className="text-violet-400">EMA50</span>
      </div>
      <ChartWrapper onChartReady={onChartReady} height={height} />
    </div>
  )
}
```

---

## EquityCurveChart component

```tsx
// components/charts/EquityCurveChart.tsx
"use client"
import { useCallback } from "react"
import { IChartApi, UTCTimestamp, ColorType } from "lightweight-charts"
import ChartWrapper from "./ChartWrapper"

interface Props {
  data:    { ts: string; equity: number }[]
  height?: number
}

export default function EquityCurveChart({ data, height = 200 }: Props) {
  const onChartReady = useCallback((chart: IChartApi) => {
    const series = chart.addAreaSeries({
      lineColor:        "#3b82f6",
      topColor:         "#3b82f620",
      bottomColor:      "#3b82f600",
      lineWidth:        2,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
    })

    series.setData(data.map(d => ({
      time:  (new Date(d.ts).getTime() / 1000) as UTCTimestamp,
      value: d.equity,
    })))

    chart.timeScale().fitContent()
  }, [data])

  return (
    <div className="rounded-lg overflow-hidden border border-slate-800">
      <div className="px-4 py-2 bg-slate-900 text-sm font-medium text-slate-100">
        Equity Curve
      </div>
      <ChartWrapper onChartReady={onChartReady} height={height} />
    </div>
  )
}
```

---

## Real-time update pattern

**Key rule:** call `series.update()` for the current candle — never `setData()` on every tick.

```tsx
// In a component that receives live candle data from WebSocket:
const lastCandleRef = useRef<CandleBar | null>(null)

// On WebSocket candle message:
function handleLiveCandle(bar: CandleBar) {
  const same = lastCandleRef.current?.ts === bar.ts
  if (same) {
    // Update forming candle — O(1), no re-render
    candleSeriesRef.current?.update({
      time:  (bar.ts / 1000) as UTCTimestamp,
      open:  bar.open, high: bar.high, low: bar.low, close: bar.close,
    })
  } else {
    // New candle — add to series
    candleSeriesRef.current?.update({
      time:  (bar.ts / 1000) as UTCTimestamp,
      open:  bar.open, high: bar.high, low: bar.low, close: bar.close,
    })
  }
  lastCandleRef.current = bar
}
```
