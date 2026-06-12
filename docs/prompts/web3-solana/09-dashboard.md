# Fase 09 — Dashboard (FastAPI Bridge + Next.js Frontend)

Tujuan: Observability UI real-time — open positions, trade history, strategy stats,
bot control. Dua proses terpisah: FastAPI bridge server dan Next.js frontend.
Prasyarat: Fase 01-08 selesai — bot engine berjalan, Redis dan PostgreSQL terisi data.

---

## Prompt 9.1 — FastAPI bridge server

```
Gunakan @web3-solana-dashboard secara lengkap, termasuk references/api-server.md.

Buat direktori dashboard-api/ dengan layout:
  main.py, config.py, deps.py, ws.py
  routers/positions.py, bot.py, trades.py, metrics.py, wallets.py

Poin kunci:
- Proses terpisah dari bot engine — hanya share Redis dan PostgreSQL
- ws.py: subscribe Redis pub/sub (position.updates, bot.status) → broadcast ke semua WS client
- /api/positions: baca Redis state.position.* + enrich dengan state.price.{mint}
- /api/bot/command: XADD stream.commands (tidak tunggu ack)
- /api/trades: paginated query PostgreSQL trades table
- /api/metrics/performance: aggregate SQL (win rate, total PnL, avg PnL)
- /api/metrics/strategy: baca strategy_stats table
- Jalankan: uvicorn main:app --port 8001
```

---

## Prompt 9.2 — Next.js frontend

```
Gunakan @web3-solana-dashboard secara lengkap, termasuk references/frontend.md.

Buat proyek Next.js (App Router) di direktori dashboard/ dengan struktur:
  lib/ws-provider.tsx, lib/store.ts
  app/(dashboard)/layout.tsx
  app/(dashboard)/dashboard/page.tsx
  app/(dashboard)/trades/page.tsx
  app/(dashboard)/control/page.tsx
  next.config.ts, .env.local

Stack: Next.js + Tailwind CSS + shadcn/ui + @tanstack/react-query + zustand

Poin kunci:
- WsProvider: satu koneksi WebSocket per session, auto-reconnect 3s, shared via context
- Zustand store: status + positions dict (upsert/remove real-time dari WS)
- React Query untuk REST polling (bot status: 10s, trades: on-demand, metrics: 60s)
- Design tokens dari skill: profit=green-500, loss=red-500, circuit breaker=red-600
- next.config.ts: rewrite /api/* → FastAPI :8001, /ws → WS :8001
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] dashboard-api/main.py — lifespan, CORS, router mount, WS route
- [ ] dashboard-api/ws.py — pubsub relay ke semua browser clients
- [ ] dashboard-api/routers/ — positions, bot, trades, metrics, wallets
- [ ] dashboard-api/.env — REDIS_URL, DATABASE_URL, CORS_ORIGINS
- [ ] dashboard/lib/ws-provider.tsx — auto-reconnect, zustand dispatch
- [ ] dashboard/lib/store.ts — status, positions, upsertPosition, removePosition
- [ ] dashboard/app/(dashboard)/dashboard/page.tsx — BotStatusCard + OpenPositionsPanel
- [ ] dashboard/app/(dashboard)/trades/page.tsx — performance metrics + history table
- [ ] dashboard/app/(dashboard)/control/page.tsx — START/STOP/PAUSE/RESUME/EMERGENCY_STOP
- [ ] Test: bot running → open position muncul real-time di dashboard tanpa refresh
