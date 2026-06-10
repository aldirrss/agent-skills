# Fase 07 — Dashboard (Next.js)

Tujuan: Next.js 14 App Router dashboard dengan real-time WebSocket, charts, dan bot controls.
Prasyarat: API server (Fase 05) sudah berjalan dan bisa diakses.

---

## Prompt 7.1 — Project init dan layout

```
Gunakan @crypto-futures-bot-dashboard untuk konteks lengkap dashboard.

Inisialisasi Next.js 14 project di folder dashboard/:
- next: 14, TypeScript, App Router, Tailwind CSS
- Install dependencies:
  shadcn/ui (init dengan default theme dark)
  lightweight-charts@4
  @tanstack/react-query@5
  zustand@4
  lucide-react

Buat struktur folder:
dashboard/
├── app/
│   ├── layout.tsx          ← root layout, providers
│   ├── page.tsx            ← redirect ke /dashboard
│   ├── login/page.tsx
│   └── dashboard/
│       ├── layout.tsx      ← sidebar nav
│       ├── page.tsx        ← overview (positions + status)
│       ├── trades/page.tsx
│       ├── performance/page.tsx
│       └── settings/page.tsx
├── components/
│   ├── providers.tsx       ← QueryClientProvider + WebSocketProvider
│   ├── nav/sidebar.tsx
│   └── ui/                 ← shadcn components (auto-generated)
└── lib/
    ├── api.ts              ← fetch wrapper dengan cookie auth
    ├── types.ts            ← TypeScript types dari API schema
    └── constants.ts        ← API_URL, WS_URL dari env

Buat app/layout.tsx dengan:
- Dark mode default (class="dark" di html)
- Providers wrapper
- Geist font
```

---

## Prompt 7.2 — WebSocket client dan store

```
Gunakan @crypto-futures-bot-dashboard references/websocket-client.md.

Buat dua file:

1. lib/websocket-client.ts
   class WebSocketClient:
   - connect(url): buat WebSocket, setup handlers
   - onMessage(handler): register callback
   - send(data): kirim text message
   - startPing(interval=20000): kirim "ping" setiap 20s
   - disconnect(): close + stop ping
   - Auto-reconnect dengan backoff (1s, 2s, 4s, max 30s)
   - Emit "connected" | "disconnected" | "error" events

2. components/providers/websocket-provider.tsx
   React context + Zustand store:

   Store interface (useWebSocketStore):
   - botStatus: "running" | "paused" | "stopped" | "unknown"
   - workers: string[]
   - positions: Record<symbol, PositionState>
   - connected: boolean
   - lastUpdate: number

   Provider:
   - Connect ke /ws saat mount (URL dari env)
   - Parse message type:
     * message.status + data.status → update botStatus + workers
     * message.symbol + position → update positions[symbol]
     * "ping" → kirim "pong" balik
   - Expose store via context

3. hooks/usePositions.ts — read positions dari store
4. hooks/useBotStatus.ts — read botStatus + connected status
```

---

## Prompt 7.3 — Dashboard overview page

```
Gunakan @crypto-futures-bot-dashboard references/position-panel.md dan
references/bot-controls.md.

Buat app/dashboard/page.tsx (overview):

Layout 2-column:
- Kiri: BotStatusCard + ActivePositionsList
- Kanan: QuickActions panel

1. components/dashboard/BotStatusCard.tsx:
   - Tampilkan: status badge (Running/Paused/Stopped/Dead)
   - Active workers count
   - Heartbeat age (dari GET /health)
   - Connection indicator (WS connected/disconnected)
   - Refresh setiap 30s via react-query

2. components/dashboard/PositionCard.tsx (satu per posisi):
   - Symbol, direction (LONG/SHORT badge), entry price
   - Current price (dari state.price via API atau WS)
   - Unrealized PnL (real-time, warna hijau/merah)
   - SL price, TP price
   - pm_stage badge (initial/break_even_set/trailing_active)
   - Tombol: Emergency Close (konfirmasi dialog)

3. components/dashboard/QuickActions.tsx:
   - Tombol: Pause All / Resume All / Emergency Stop
   - Emergency Stop: Dialog konfirmasi dengan input "CONFIRM"
   - Semua actions via POST ke API endpoints
   - Loading state saat menunggu response (timeout 30s untuk emergency)
   - Toast notification hasil (shadcn Toast)
```

---

## Prompt 7.4 — Candlestick chart dan performance

```
Gunakan @crypto-futures-bot-dashboard references/chart-components.md.

Buat dua komponen chart menggunakan lightweight-charts@4:

1. components/charts/CandlestickChart.tsx:
   Props: symbol, timeframe, height=400
   - Fetch OHLCV dari exchange via /api/candles endpoint (buat endpoint
     proxy di api_server jika belum ada) atau langsung dari REST API
   - createChart + addCandlestickSeries
   - Auto-resize menggunakan ResizeObserver
   - Update real-time dari WS candle events jika tersedia
   - Tampilkan SL/TP lines sebagai horizontal price lines (merah/hijau)
     ambil dari positions store jika symbol match

2. components/charts/EquityCurveChart.tsx:
   Props: days=90, height=300
   - Fetch dari GET /metrics/equity-curve
   - addAreaSeries dengan warna hijau
   - Format tanggal di x-axis sebagai "DD MMM"
   - Tampilkan max drawdown sebagai annotation

Buat app/dashboard/performance/page.tsx:
- EquityCurveChart di atas
- Stats cards: Win Rate, Profit Factor, Avg PnL, Max Drawdown
- Data dari GET /metrics/performance
- Date range picker (7d / 30d / 90d)
```

---

## Prompt 7.5 — Trade history dan settings

```
Gunakan @crypto-futures-bot-dashboard references/trade-history.md.

Buat app/dashboard/trades/page.tsx:
- Tabel trades dari GET /trades dengan pagination
- Kolom: symbol, direction, entry, exit, PnL (warna), fee, strategy, duration, status
- Filter: symbol (select), status (select), date range
- Pagination: shadcn Pagination component
- Export CSV button (generate dari data yang sudah di-fetch)
- Semua nilai PnL: hijau jika positif, merah jika negatif

Buat app/dashboard/settings/page.tsx:
- Bagian "Add Symbol": form dengan fields:
  Symbol (text), Strategy (select 6 opsi), Leverage (1-20),
  Risk % (0.1-5), Timeframe (select), Exchange (dari GET /accounts)
  Submit → POST /bot/symbol
- Bagian "Active Workers": list dengan tombol Remove dan Config per symbol
- Bagian "Update Config": PATCH /bot/symbol/{symbol}/config per symbol
- Semua form menggunakan react-hook-form + zod validation
- Success/error feedback via shadcn Toast

Buat app/login/page.tsx:
- Form username + password
- POST /auth/login
- Redirect ke /dashboard jika sukses
- Error message jika gagal (tanpa expose detail)
- Tidak bisa akses /dashboard tanpa login (middleware.ts)
```

---

## Prompt 7.6 — Auth middleware dan API client

```
Buat dua file utility:

1. middleware.ts (Next.js middleware):
   - Protected routes: /dashboard/*
   - Cek cookie (nama dari env NEXT_PUBLIC_COOKIE_NAME atau hardcode)
   - Redirect ke /login jika tidak ada cookie
   - Jangan cek validity cookie di middleware (itu tugas API server)

2. lib/api.ts — API client:
   - Base URL dari NEXT_PUBLIC_API_URL env
   - fetch wrapper yang:
     * Selalu kirim credentials: "include" (cookie dikirim)
     * Handle 401: redirect ke /login
     * Handle network error: throw dengan message yang berguna
   - Typed functions:
     * getBotStatus() → BotStatus
     * getPositions() → Record<string, Position>
     * getTrades(params) → PaginatedTrades
     * getPerformance(params) → Performance
     * getEquityCurve(params) → EquityPoint[]
     * getHealth() → Health
     * postAddSymbol(data) → CommandResponse
     * postEmergencyStop() → CommandResponse
     * dll untuk semua endpoint

3. lib/types.ts:
   - TypeScript interfaces untuk semua response types dari API
   - Konsisten dengan schema di @crypto-futures-bot-api
   - Gunakan string untuk semua nilai finansial (bukan number)
```
