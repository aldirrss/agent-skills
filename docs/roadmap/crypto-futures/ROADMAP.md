# [PROJECT_NAME] — Roadmap

## Vision

A fully configurable crypto futures trading platform managed entirely from a web dashboard,
no code or CLI access required. Traders focus on strategy — the platform handles execution.

---

## Phase 1 — MVP

**Goal:** Bot runs end-to-end with at least one exchange account and one active strategy.
Dashboard is accessible from a browser. Positions are always protected.

### Core Bot Engine
- [ ] DataCollector: WebSocket OHLCV + CVD per symbol
- [ ] StrategyWorker: 6 strategies (trend, breakout, momentum, sr_bounce, funding, liquidation)
- [ ] RiskManager: 5 gate checks + position sizing
- [ ] OrderExecutor: market entry + SL/TP at exchange
- [ ] PositionTracker: Redis state + PostgreSQL sync
- [ ] PositionManager: trailing stop, break-even, partial TP, time exit
- [ ] LiquidationCollector: Binance forceOrder WebSocket
- [ ] LLMSignalAgent: confluence signal from LLM provider

### API Server
- [ ] Auth: login/logout with HttpOnly cookie
- [ ] Bot control: add/remove symbol, pause, resume, emergency stop
- [ ] Data endpoints: trades, performance metrics, equity curve
- [ ] WebSocket relay: real-time broadcast to dashboard

### Dashboard
- [ ] Login page
- [ ] Overview: bot status + active positions
- [ ] Position cards: real-time PnL, SL/TP, pm_stage
- [ ] Quick actions: emergency stop, pause/resume
- [ ] Add symbol form: strategy, leverage, risk config

### Monitoring
- [ ] Health heartbeat check
- [ ] CRITICAL alert: position without SL coverage
- [ ] Telegram notifications

### Infrastructure
- [ ] Docker Compose (redis, postgres, bot_engine, api_server, monitoring)
- [ ] .env.example with all required variables
- [ ] Alembic initial schema migration
- [ ] Smoke test script

---

## Phase 2 — Full Dashboard

**Goal:** Users can manage all bot aspects from the dashboard without server access.

- [ ] Trade history table with filters and pagination
- [ ] Performance metrics: win rate, profit factor, max drawdown
- [ ] Equity curve chart (lightweight-charts)
- [ ] Candlestick chart per symbol with SL/TP lines
- [ ] Settings page: manage accounts + workers + alert config
- [ ] Update strategy config without restart (hot-reload)
- [ ] In-dashboard notifications (toast) for all bot events
- [ ] Mobile-responsive layout

---

## Phase 3 — Multi-Exchange & Strategy Tuning

**Goal:** Support more than one exchange, users can tune strategy parameters.

- [ ] Bybit support (LiquidationCollector adapter for Bybit stream)
- [ ] OKX support
- [ ] Per-symbol confluence threshold config from dashboard
- [ ] Backtesting endpoint: run strategies on historical data
- [ ] Strategy performance comparison per symbol
- [ ] Customizable alert rules from dashboard
- [ ] Export trade history to CSV

---

## Phase 4 — Multi-User & Production Hardening

**Goal:** Support multiple trader accounts, ready to run 24/7 on production VPS without manual intervention.

- [ ] Multi-user auth: per-user accounts, roles, and isolated bot instances
- [ ] nginx reverse proxy with SSL (Let's Encrypt)
- [ ] systemd unit files for all services
- [ ] Redis AOF persistence + password
- [ ] Automated PostgreSQL backup (pg_dump to object storage)
- [ ] Log rotation (loguru + logrotate)
- [ ] External uptime monitoring
- [ ] Graceful restart without losing positions
- [ ] Auto-recovery after VPS reboot

---

## Out of Scope (for now)

- Copy trading / social trading
- Spot trading (futures/perpetual only)
- Mobile app (dashboard is already responsive)
- Automated strategy discovery / optimization
- On-chain / DeFi integration

---

## Known Technical Debt

| Item | Impact | Priority |
|---|---|---|
| LiquidationCollector Binance-only | Bybit/OKX cannot get liquidation data | Phase 3 |
| Single admin user (bcrypt hash in .env) | Cannot support multi-user | Phase 4 |
| Uvicorn workers=1 | Cannot horizontally scale API | Acceptable until multi-user |
| No exponential backoff in DataCollector | Steady retry when exchange is down | Intentional — keep retrying |
| sr-bounce strategy needs review | sr_bounce not yet production-ready | Phase 2 |
