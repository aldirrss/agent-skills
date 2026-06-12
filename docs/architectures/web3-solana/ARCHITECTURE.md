# Solana DEX Trading Bot — Architecture

## Overview

Autonomous on-chain trading bot for Solana DEX. Monitors 10 data sources,
evaluates signals through two mandatory LLM gates, executes Jupiter V6 swaps,
and exposes a real-time web dashboard.

**Design principles:**
- Self-hosted — private key dan API keys tidak pernah keluar dari server
- Two-gate mandatory — setiap BUY signal harus lolos GATE 1 (composite scoring)
  dan GATE 2 (4 LLM sub-agents) sebelum sampai ke RiskManager
- Fail-safe — SL/TP adalah code constants, tidak bisa di-override via config
- Fail-open — LLM timeout/error tidak memblokir trading (score default 50)
- DRY_RUN default true — mainnet adalah opt-in eksplisit

---

## System Topology

```
┌─────────────────────────────────────────────────────────────────┐
│                        User Browser                              │
│                    Next.js Dashboard                             │
│      (WebSocket real-time + React Query REST polling)            │
└──────────────────────┬───────────────────────────────────────────┘
                       │ HTTP / WSS
┌──────────────────────▼───────────────────────────────────────────┐
│               FastAPI Bridge Server (port 8001)                   │
│   /api/positions │ /api/bot/* │ /api/trades │ /api/metrics        │
│   /ws  ←  Redis pub/sub relay (position.updates, bot.status)      │
└──────┬────────────────────────────────────────────────────────────┘
       │ reads Redis state.* + PostgreSQL
       │ writes stream.commands
┌──────▼────────────────────────────────────────────────────────────┐
│                           Redis                                    │
│  Streams:   signals │ agent.eligible │ agent.approved             │
│             swaps   │ fills          │ commands                   │
│  Pub/Sub:   position.updates │ bot.status                         │
│  State:     position.{mint} │ price.{mint} │ bot.status           │
│             circuit_breaker │ daily_loss_pct │ open_positions_count│
│  Tracking:  signal.match.{mint} (Hash,TTL900) │ agent.queue (ZSet)│
│  Config:    config.risk │ config.strategy                         │
└──────┬───────────────────────────────────────────┬────────────────┘
       │ XREAD/XADD/PubSub                          │ reads/writes
┌──────▼────────────────────────────────────────────▼────────────────┐
│                    Bot Engine (single asyncio process)              │
│                                                                     │
│  Scanner (10 tasks)                                                 │
│    DEXScreener · GMGN · Pump.fun · Birdeye · Helius webhook         │
│    KOL Wallet RPC · Cielo · Rugcheck · Twitter · Telegram           │
│    ↓ pub/sub: scanner.token.new / trending / scanner.wallet.buy     │
│                                                                     │
│  Strategy (7 tasks)                                                 │
│    KolCopyTrade · NewLaunchSnipe · GraduationTrade                  │
│    MomentumSpike · SmartMoneyConfluence · SocialAlpha               │
│    PositionMonitor (SL/TP/max-hold-time trigger)                    │
│    ↓ XADD stream.signals                                            │
│                                                                     │
│  SignalAggregator — GATE 1                                          │
│    composite scoring · top-15 batch · circuit breaker check         │
│    ↓ XADD stream.agent.eligible                                     │
│                                                                     │
│  OrchestratorAgent — GATE 2                                         │
│    4 LLM sub-agents parallel (market/safety/risk/social)            │
│    litellm · Groq (market/safety/risk) · Gemini (social)            │
│    score ≥ 80 → pass, else drop                                     │
│    ↓ XADD stream.agent.approved                                     │
│                                                                     │
│  RiskManager                                                        │
│    BUY ← stream.agent.approved (risk-group)                         │
│    SELL ← stream.signals (risk-sell-group, passthrough)             │
│    7-step safety gate · SL/TP code constants · slippage tiers       │
│    ↓ XADD stream.swaps                                              │
│                                                                     │
│  Execution  ← stream.swaps (exec-group)                             │
│    Jupiter V6 quote → sign (solders) → send → confirm               │
│    per-mint asyncio.Lock · DRY_RUN passthrough                      │
│    ↓ XADD stream.fills                                              │
│                                                                     │
│  PositionTracker ← stream.fills (fill-group)                        │
│    state.position.{mint} · PUBLISH position.updates                 │
│                                                                     │
│  DBWriter ← stream.fills (fill-group)                               │
│    INSERT trades · UPDATE pnl · rebuild strategy_stats nightly      │
│                                                                     │
│  CommandListener ← stream.commands (cmd-group)                      │
│    START · STOP · PAUSE · RESUME · EMERGENCY_STOP                   │
│                                                                     │
│  Monitor                                                            │
│    TelegramAlerter · heartbeat · scanner health · daily report      │
└─────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                         PostgreSQL                                   │
│  trades · kol_wallets · signal_rejections · strategy_stats          │
│  daily_reports                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Signal Pipeline (detail)

```
Scanner pub/sub
    ↓
Strategy evaluate_confluence()
    ↓ XADD stream.signals  { action=BUY, strategy, confidence, liquidity_usdc, sources }
    ↓ XADD stream.signals  { action=SELL, reason }  ← dari PositionMonitor

SignalAggregator (GATE 1, aggregator-group)
    · Record signal.match.{mint} (Hash, TTL 900s)
    · Gate: min 2 strategy match + per-strategy time window
    · Rank top-15: match_count×30 + strategy_weight + recency
    · Check circuit breaker
    ↓ XADD stream.agent.eligible  { batch_id, mints: "[mint1, mint2, ...]" }

OrchestratorAgent (GATE 2, orchestrator-group)
    · Expand batch → per-mint TokenContext
    · asyncio.gather → MarketAgent | SafetyAgent | RiskAgent | SocialAgent
    · AGENT_WEIGHTS = {market:0.25, safety:0.30, risk:0.25, social:0.20}
    · final_score = weighted average
    · Gate: final_score ≥ 80
    ↓ XADD stream.agent.approved  { mint, final_score, market_score, safety_score,
                                    risk_score, social_score, reasoning }

RiskManager BUY path (risk-group on stream.agent.approved)
    · 7-step safety gate (position exists? concurrent limit? circuit breaker? ...)
    · position_size = final_score/100 × multiplier × wallet_usdc
    · stop_loss_price  = calculate_stop_loss_price(entry, liquidity)  ← SL_TIERS
    · take_profit_price = entry × (1 + TAKE_PROFIT_PCT)               ← 2× modal
    ↓ XADD stream.swaps  { side=BUY, amount_usdc, slippage_bps, stop_loss_price,
                           take_profit_price, strategy, batch_id }

RiskManager SELL path (risk-sell-group on stream.signals)
    · Bypass safety gate — exit tidak boleh diblokir
    · emergency slippage = 1000bps
    ↓ XADD stream.swaps  { side=SELL, amount_tokens, slippage_bps, reason }
```

---

## TP/SL Rules (Code Constants)

```python
TAKE_PROFIT_PCT = Decimal("1.0")   # price harus 2× entry untuk hit TP

SL_TIERS = [
    (500_000, Decimal("0.15")),   # liquidity ≥ $500k → SL 15%
    ( 50_000, Decimal("0.20")),   # liquidity ≥ $50k  → SL 20%
    ( 10_000, Decimal("0.30")),   # liquidity ≥ $10k  → SL 30%
    (      0, Decimal("0.40")),   # liquidity < $10k  → SL 40%
]
```

R/R per tier: worst case (40% SL / 100% TP) = 2.5:1 — break-even ~29% win rate.

---

## Redis Consumer Groups

| Stream | Group | Consumer | Komponen |
|---|---|---|---|
| stream.signals | aggregator-group | aggregator-1 | SignalAggregator |
| stream.signals | risk-sell-group | risk-manager-1 | RiskManager (SELL) |
| stream.agent.eligible | orchestrator-group | orchestrator-1 | OrchestratorAgent |
| stream.agent.approved | risk-group | risk-manager-1 | RiskManager (BUY) |
| stream.swaps | exec-group | execution-1 | Execution |
| stream.fills | fill-group | position-tracker-1 | PositionTracker |
| stream.fills | fill-group | db-writer-1 | DBWriter |
| stream.commands | cmd-group | cmd-listener-1 | CommandListener |

---

## Agent Layer (GATE 2 Detail)

| Sub-Agent | Provider | Model | Weight | Timeout | Focus |
|---|---|---|---|---|---|
| MarketAgent | Groq | llama-3.1-8b-instant | 25% | 5s | Narrative, volume, trend |
| SafetyAgent | Groq | llama-3.1-8b-instant | 30% | 5s | Rug risk, holder concentration |
| RiskAgent | Groq | llama-3.1-8b-instant | 25% | 5s | Liquidity depth, position size fit |
| SocialAgent | Gemini | gemini-1.5-flash | 20% | 8s | Organic social vs manufactured hype |

Response format: `SCORE: 75\nREASON: ...` (bukan JSON — small models tidak reliable JSON)

---

## Tech Stack

### Bot Engine
```
python 3.12
solders + solana-py    # Solana on-chain
aiohttp                # HTTP client (Jupiter, Scanner APIs)
redis[hiredis]         # Redis async client
asyncpg                # PostgreSQL async
loguru                 # structured logging
pydantic-settings      # config + env validation
litellm                # unified LLM provider interface
```

### FastAPI Bridge Server
```
fastapi + uvicorn
redis[hiredis] asyncio
asyncpg
```

### Next.js Dashboard
```
next (App Router)
tailwindcss + shadcn/ui
@tanstack/react-query  # REST polling
zustand                # WebSocket live state
lightweight-charts     # equity curve
```

---

## Directory Layout

```
solana-bot/
├── main.py
├── config.py
├── logger_setup.py
├── components/
│   ├── wallet.py
│   ├── redis_helpers.py
│   ├── scanner/
│   │   ├── models.py, dedup.py, runner.py
│   │   └── [dexscreener|gmgn|pumpfun|birdeye|helius|
│   │        kol_wallet|cielo|twitter|telegram].py
│   ├── strategy/
│   │   ├── buffer.py, confluence.py, runner.py
│   │   ├── position_monitor.py
│   │   └── [kol_copy|new_launch|graduation|
│   │        momentum|smart_money|social_alpha].py
│   ├── signal_aggregator.py
│   ├── key_pool.py
│   ├── orchestrator_agent.py
│   ├── agents/
│   │   └── types.py, base.py, market.py, safety.py, risk.py, social.py
│   ├── risk_manager.py
│   ├── execution/
│   │   └── jupiter.py, execution.py
│   ├── position_tracker.py
│   ├── db_writer.py
│   ├── command_listener.py
│   └── monitor/
│       └── monitor.py, telegram_alerter.py, health.py, stats.py
├── db/
│   ├── pool.py, migrate.py, queries.py
│   └── migrations/migration_001_initial.sql
├── dashboard-api/          ← proses terpisah
│   ├── main.py, config.py, deps.py, ws.py
│   └── routers/
│       └── positions.py, bot.py, trades.py, metrics.py, wallets.py
└── dashboard/              ← Next.js
    ├── lib/ws-provider.tsx, store.ts
    └── app/(dashboard)/
        └── dashboard/ trades/ strategies/ wallets/ control/
```

---

## Skills Reference

| Skill | Covers |
|---|---|
| `@web3-solana` | Safety rules, Jupiter, keypair, RPC |
| `@web3-solana-architecture` | Redis topology, event flow, component wiring |
| `@web3-solana-db-schema` | PostgreSQL DDL, query patterns |
| `@web3-solana-engine` | Startup/shutdown, main process, config |
| `@web3-solana-scanner` | 10 scanner sources, signal normalization |
| `@web3-solana-strategy` | 6 strategies, confluence engine, position monitor |
| `@web3-solana-signal-aggregator` | GATE 1: composite scoring, top-15 dispatch |
| `@web3-solana-agent` | GATE 2: OrchestratorAgent, sub-agents, KeyPoolManager |
| `@web3-solana-risk` | Safety gate, SL/TP constants, slippage tiers |
| `@web3-solana-execution` | Jupiter V6 flow, signing, confirmation |
| `@web3-solana-monitor` | Telegram alerts, heartbeat, daily report |
| `@web3-solana-dashboard` | FastAPI bridge, Next.js frontend |
