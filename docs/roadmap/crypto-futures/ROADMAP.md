# [PROJECT_NAME] — Roadmap

## Visi

Platform trading futures crypto yang bisa dikonfigurasi sepenuhnya dari dashboard web,
tanpa perlu menyentuh kode atau CLI. Trader fokus pada strategi — platform yang handle eksekusi.

---

## Phase 1 — MVP (Self-hosted, Single User)

**Target:** Bot bisa berjalan end-to-end dengan satu akun exchange dan satu strategi aktif.
Dashboard bisa dipantau dari browser. Posisi selalu terlindungi.

### Core Bot Engine
- [ ] DataCollector: WebSocket OHLCV + CVD per symbol
- [ ] StrategyWorker: 6 strategi (trend, breakout, momentum, sr_bounce, funding, liquidation)
- [ ] RiskManager: 5 gate checks + position sizing
- [ ] OrderExecutor: market entry + SL/TP di exchange
- [ ] PositionTracker: state Redis + sync PostgreSQL
- [ ] PositionManager: trailing stop, break-even, partial TP, time exit
- [ ] LiquidationCollector: Binance forceOrder WebSocket
- [ ] LLMSignalAgent: confluence signal dari LLM provider

### API Server
- [ ] Auth: login/logout dengan HttpOnly cookie
- [ ] Bot control: add/remove symbol, pause, resume, emergency stop
- [ ] Data endpoints: trades, performance metrics, equity curve
- [ ] WebSocket relay: real-time broadcast ke dashboard

### Dashboard
- [ ] Login page
- [ ] Overview: status bot + active positions
- [ ] Position cards: real-time PnL, SL/TP, pm_stage
- [ ] Quick actions: emergency stop, pause/resume
- [ ] Add symbol form: strategy, leverage, risk config

### Monitoring
- [ ] Health heartbeat check
- [ ] CRITICAL alert: posisi tanpa SL coverage
- [ ] Telegram notifications

### Infrastructure
- [ ] Docker Compose (redis, postgres, bot_engine, api_server, monitoring)
- [ ] .env.example dengan semua variabel
- [ ] Alembic migration initial schema
- [ ] Smoke test script

---

## Phase 2 — Dashboard Lengkap

**Target:** User bisa mengelola semua aspek bot dari dashboard tanpa perlu akses server.

- [ ] Trade history table dengan filter dan pagination
- [ ] Performance metrics: win rate, profit factor, max drawdown
- [ ] Equity curve chart (lightweight-charts)
- [ ] Candlestick chart per symbol dengan SL/TP lines
- [ ] Settings page: manage accounts + workers + alert config
- [ ] Update strategy config tanpa restart (hot-reload)
- [ ] Notifikasi in-dashboard (toast) untuk semua bot events
- [ ] Mobile-responsive layout

---

## Phase 3 — Multi-Exchange & Strategy Tuning

**Target:** Support lebih dari satu exchange, dan user bisa tune parameter strategi.

- [ ] Bybit support (adapter LiquidationCollector untuk Bybit stream)
- [ ] OKX support
- [ ] Per-symbol confluence threshold config dari dashboard
- [ ] Backtesting endpoint: jalankan strategi pada historical data
- [ ] Strategy performance comparison per symbol
- [ ] Alert rules customizable dari dashboard
- [ ] Export trade history ke CSV

---

## Phase 4 — Production Hardening

**Target:** Siap dijalankan 24/7 di production VPS tanpa intervensi manual.

- [ ] nginx reverse proxy dengan SSL (Let's Encrypt)
- [ ] systemd unit files untuk semua service
- [ ] Redis AOF persistence + password
- [ ] PostgreSQL backup otomatis (pg_dump ke object storage)
- [ ] Log rotation (loguru + logrotate)
- [ ] Uptime monitoring (external ping)
- [ ] Graceful restart tanpa kehilangan posisi
- [ ] Auto-recovery setelah VPS reboot

---

## Out of Scope (untuk saat ini)

- Multi-user / multi-tenant (satu instance = satu user)
- Copy trading / social trading
- Spot trading (hanya futures/perpetual)
- Mobile app (dashboard sudah responsive)
- Automated strategy discovery / optimization
- On-chain / DeFi integration

---

## Known Technical Debt

| Item | Impact | Prioritas |
|---|---|---|
| LiquidationCollector Binance-only | Bybit/OKX tidak dapat data likuidasi | Phase 3 |
| Single admin user (bcrypt hash di .env) | Tidak bisa multi-user | Out of scope |
| Uvicorn workers=1 | Tidak bisa horizontal scale API | Acceptable untuk single-user |
| Exponential backoff tidak ada di DataCollector | Steady retry saat exchange down | Disengaja — keep trying |
| sr-bounce strategy butuh review | Strategy sr_bounce belum production-ready | Phase 2 |
