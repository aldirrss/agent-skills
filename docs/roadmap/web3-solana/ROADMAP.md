# Solana DEX Trading Bot — Roadmap

## Vision

Bot trading Solana DEX yang sepenuhnya otomatis: memantau 10 sumber data,
mengevaluasi sinyal melalui dua gate wajib (composite scoring + LLM multi-agent),
mengeksekusi swap via Jupiter V6, dan menampilkan semua aktivitas di dashboard real-time.

---

## Phase 1 — MVP Bot Engine

**Goal:** Bot berjalan end-to-end di DRY_RUN. Signal masuk, melewati kedua gate,
RiskManager approve/reject, Execution log tanpa kirim transaksi nyata.

### Infrastructure
- [ ] Docker Compose: redis + postgres + solana_bot
- [ ] `.env.example` lengkap — Solana, Redis, Postgres, Scanner APIs, Agent keys
- [ ] Dockerfile: python:3.12-slim, non-root user
- [ ] `pyproject.toml` dengan semua dependencies

### Database
- [ ] Migration SQL: trades, kol_wallets, signal_rejections, strategy_stats, daily_reports
- [ ] `db/pool.py` + `db/migrate.py` + `db/queries.py`
- [ ] Seed KOL wallets placeholder

### Engine Core
- [ ] `config.py` — Pydantic Settings, fail-fast, DRY_RUN default True
- [ ] `logger_setup.py` — Loguru, redact keypair, JSON file rotation
- [ ] `components/wallet.py` — load_keypair, keypair tidak keluar dari Execution
- [ ] `main.py` — startup 15 langkah + shutdown sequence dengan urutan benar
- [ ] `components/redis_helpers.py` — ensure_consumer_groups (7 group), drain_pending

### Scanner (10 sources)
- [ ] models.py — NewTokenSignal, TrendingSignal, WalletBuySignal
- [ ] dedup.py — is_duplicate (Redis TTL), publish_signal
- [ ] DEXScreener — new pairs + trending
- [ ] GMGN — trending
- [ ] Pump.fun — new launches
- [ ] Birdeye — trending
- [ ] Rugcheck — on-demand safety validator
- [ ] Helius webhook — KOL wallet swap detection
- [ ] KOL Wallet RPC polling
- [ ] Cielo — smart money feed
- [ ] Twitter/X — mentions (disabled jika no token)
- [ ] Telegram — alpha channels (disabled jika no creds)
- [ ] ScannerRunner — 10 named tasks

### Strategy (6 strategi + position monitor)
- [ ] SignalBuffer — in-memory, asyncio.Lock
- [ ] confluence.py — evaluate_confluence, publish_buy_signal → stream.signals
- [ ] KolCopyTrade, NewLaunchSnipe, GraduationTrade
- [ ] MomentumSpike, SmartMoneyConfluence, SocialAlpha
- [ ] position_monitor.py — SL/TP/max-hold-time → XADD stream.signals SELL
- [ ] StrategyRunner — 7 named tasks + periodic buffer prune

### GATE 1 — SignalAggregator
- [ ] signal_aggregator.py — aggregator-group pada stream.signals
- [ ] Record signal.match.{mint} (Hash, TTL 900s)
- [ ] Gate: min 2 match + per-strategy window
- [ ] Rank top-15 composite score
- [ ] Circuit breaker check sebelum dispatch
- [ ] XADD stream.agent.eligible

### GATE 2 — OrchestratorAgent + KeyPoolManager
- [ ] key_pool.py — round-robin, fail-fast min 3 keys per provider
- [ ] agents/types.py — AgentScore, TokenContext
- [ ] agents/base.py, market.py, safety.py, risk.py, social.py
- [ ] orchestrator_agent.py — 4 parallel via litellm, gate ≥ 80
- [ ] XADD stream.agent.approved

### RiskManager + Execution
- [ ] risk_manager.py — BUY dari stream.agent.approved, SELL dari stream.signals
- [ ] SL_TIERS + TAKE_PROFIT_PCT = 1.0 sebagai code constants
- [ ] 7-step safety gate + position sizing (final_score/100 × multiplier)
- [ ] position_tracker.py — state.position.{mint}, PUBLISH position.updates
- [ ] db_writer.py — insert fills, rejection log, nightly rebuild
- [ ] execution/jupiter.py — quote, swap tx, sign, send, confirm
- [ ] execution/execution.py — Keypair isolation, per-mint locks, DRY_RUN support
- [ ] command_listener.py — START/STOP/PAUSE/RESUME/EMERGENCY_STOP

**MVP Acceptance Criteria:**
- DRY_RUN=true: bot start → terima signal → log "would execute swap" tanpa transaksi
- Circuit breaker aktif saat daily_loss melebihi limit
- EMERGENCY_STOP publish SELL untuk semua open positions

---

## Phase 2 — Monitor + Dashboard

**Goal:** Observability lengkap — Telegram alerts, heartbeat, daily report,
dan web dashboard real-time.

### Monitor
- [ ] TelegramAlerter — queue-backed, rate limit 3s, Discord support
- [ ] Alert templates: buy_opened, sell_closed, circuit_breaker, emergency_stop,
      scanner_dead, position_age_warning, daily_summary
- [ ] heartbeat_loop — SET state.bot.heartbeat setiap 30s (EX=60)
- [ ] scanner_health_loop — alert jika task hilang (cek setiap 2 menit)
- [ ] position_age_loop — alert jika posisi ≥ 75% max_hold_time
- [ ] stats.py — record_signal, record_trade_outcome, build_daily_report
- [ ] midnight_loop — daily report + reset stats + rebuild_strategy_stats

### Dashboard — FastAPI Bridge
- [ ] dashboard-api/main.py — lifespan, CORS, router mount
- [ ] dashboard-api/ws.py — Redis pub/sub relay ke browser WebSocket clients
- [ ] /api/positions — Redis state.position.* + enrich state.price.{mint}
- [ ] /api/bot/status + /api/bot/command
- [ ] /api/trades — paginated PostgreSQL
- [ ] /api/metrics/performance + /api/metrics/strategy
- [ ] /api/wallets/kol + /api/rejections

### Dashboard — Next.js Frontend
- [ ] WsProvider — satu koneksi WS, auto-reconnect 3s
- [ ] Zustand store — status, positions dict
- [ ] dashboard/page.tsx — BotStatusCard + OpenPositionsPanel
- [ ] trades/page.tsx — performance metrics + paginated history
- [ ] strategies/page.tsx — per-strategy breakdown
- [ ] wallets/page.tsx — KOL wallet leaderboard
- [ ] control/page.tsx — START/STOP/PAUSE/RESUME/EMERGENCY_STOP buttons

**Phase 2 Acceptance Criteria:**
- Open position muncul real-time di dashboard < 1s setelah BUY fill confirmed
- Telegram alert terkirim setiap trade close (win dan loss)
- Daily report dikirim ke Telegram setiap midnight UTC

---

## Phase 3 — Mainnet Readiness

**Goal:** Bot siap live trading dengan semua safety checks terpenuhi.

### Safety
- [ ] DRY_RUN=false: semua checks eksplisit, warning di startup log
- [ ] Keypair audit — Execution adalah satu-satunya class yang hold Keypair
- [ ] Slippage guard — semua swap punya slippage_bps non-zero
- [ ] On-chain confirmation sebelum retry — tidak kirim ulang tx tanpa cek on-chain
- [ ] Reconcile positions on startup — state.position.* vs on-chain balances

### Resilience
- [ ] RPC fallback — primary + fallback client, auto-switch on failure
- [ ] Redis reconnect — exponential backoff pada connection drop
- [ ] Scanner graceful restart — task mati auto-respawn dengan alert
- [ ] Stream replay on crash — drain pending (id="0") di startup

### Operational
- [ ] KOL wallet list — isi dengan wallet nyata yang sudah divalidasi
- [ ] config.risk tuning — max_daily_loss, max_concurrent_positions
- [ ] GROQ_API_KEYS + GEMINI_API_KEYS — min 3 keys aktif per provider
- [ ] Monitoring dashboard live — FastAPI bridge + Next.js running

**Phase 3 Acceptance Criteria:**
- Bot berjalan 24 jam di mainnet dengan DRY_RUN=false tanpa crash
- Semua trades tercatat di PostgreSQL dengan pnl_usdc correct
- EMERGENCY_STOP menutup semua posisi dalam < 60s

---

## Phase 4 — Optimization

**Goal:** Tingkatkan win rate dan kurangi latency eksekusi.

### Strategy Improvements
- [ ] Tambah signal source: DEX Screener volume profile, Helius NFT correlation
- [ ] Tune SIGNAL_WEIGHTS per strategi berdasarkan historical performance
- [ ] Tambah strategi: Cross-Chain Alpha (bridge volume spike detection)

### Agent Layer Improvements
- [ ] Cache LLM scores per mint (llm.score.{mint}, TTL 300s) — kurangi API calls
- [ ] Track agent accuracy per sub-agent — tuning weight AGENT_WEIGHTS
- [ ] Tambah provider fallback di KeyPoolManager: Groq → OpenRouter jika rate limited
- [ ] Evaluasi threshold GATE 2: backtest score ≥ 75 vs ≥ 80 vs ≥ 85

### Execution Improvements
- [ ] Dynamic priority fee — autoMultiplier berdasarkan network congestion
- [ ] Partial take-profit — sell 50% saat +50%, hold sisanya hingga TP penuh
- [ ] Trailing stop — geser SL setelah posisi +20%

### Analytics
- [ ] Equity curve di dashboard — lightweight-charts
- [ ] Per-mint performance breakdown
- [ ] Win rate per strategy per time-of-day
- [ ] Signal rejection reason analytics

---

## Skills Mapping

| Fase | Skill yang digunakan |
|---|---|
| Phase 1 infra | `@web3-solana`, `@web3-solana-architecture` |
| Phase 1 database | `@web3-solana-db-schema` |
| Phase 1 engine | `@web3-solana-engine` |
| Phase 1 scanner | `@web3-solana-scanner` |
| Phase 1 strategy | `@web3-solana-strategy` |
| Phase 1 GATE 1 | `@web3-solana-signal-aggregator` |
| Phase 1 GATE 2 | `@web3-solana-agent` |
| Phase 1 risk+exec | `@web3-solana-risk`, `@web3-solana-execution` |
| Phase 2 monitor | `@web3-solana-monitor` |
| Phase 2 dashboard | `@web3-solana-dashboard` |
