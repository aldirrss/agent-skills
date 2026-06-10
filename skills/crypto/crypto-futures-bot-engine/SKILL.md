---
name: crypto-futures-bot-engine
description: Python bot engine implementation for crypto futures trading — asyncio process skeleton, component wiring, config/logging setup, and production patterns. Use this whenever the user is building, debugging, or extending the core bot engine process — entry point, DataCollector, StrategyWorker, RiskManager, OrderExecutor, PositionTracker, DBWriter, CommandListener, health heartbeat, config loading, or Loguru logging. Trigger even when the user mentions one specific component (e.g. "how to reconnect WebSocket on disconnect", "how to hot-reload strategy config", "how to handle OrderExecutor crash", "bot keeps placing duplicate orders"). This skill requires crypto-futures-bot-architecture (process topology, Redis schema) and crypto-futures (safety rules, order execution). All code here assumes those two skills are loaded.
requires:
  - crypto-futures-bot-architecture
  - crypto-futures
  - crypto-futures-bot-db-schema
---

# Crypto Futures Bot Engine

Single asyncio process containing all bot components as coroutines/tasks. This skill provides the concrete implementation layer — the "how it actually looks in code" on top of the architectural blueprint defined in `crypto-futures-bot-architecture`.

## Component Dependency Graph

```
Settings + Loguru (loaded first, injected everywhere)
         │
         ▼
    Redis pool ──────────────────────────────────┐
         │                                       │
    ensure_consumer_groups()                     │
         │                                       │
    ┌────▼──────────────────────────────────┐   │
    │  CommandListener (reads stream.commands)  │   │
    └────┬──────────────────────────────────┘   │
         │ spawns / kills                        │
    ┌────▼────────────────┐                     │
    │  per-symbol pair:   │                     │
    │  DataCollector      │──pub/sub──────────▶ │
    │  StrategyWorker     │──stream.signals───▶ │
    └─────────────────────┘                     │
                                                │
    RiskManager ◀──stream.signals───────────────┤
         │ stream.orders                         │
    OrderExecutor ◀────────────────────────────┤
         │ stream.fills                          │
    ┌────┴──────────────────┐                   │
    │  PositionTracker      │──Redis state──────▶│
    │  DBWriter             │──PostgreSQL        │
    └───────────────────────┘                   │
                                                │
    HealthHeartbeat ────────────────────────────┘
    LLMSignalAgent  ────────────────────────────┘
```

## Key Implementation Rules

**Do not add to this list without good reason — these exist because violations have caused real losses.**

1. **One asyncio Lock per symbol in OrderExecutor** — prevents concurrent orders for the same symbol regardless of how many signals arrive.
2. **Config is read from Redis on every candle** — StrategyWorker never caches config locally. Hot-reload is free.
3. **Every component logs with `logger.bind(component=..., symbol=...)`** — makes log filtering instant.
4. **Tasks are named** — `asyncio.create_task(..., name="collector.BTCUSDT")` — visible in `asyncio.all_tasks()` for debugging.
5. **No bare `except Exception: pass`** — every exception is logged at minimum. Order-path exceptions trigger emergency handling.
6. **Shutdown order matters** — stop DataCollectors first (no new candles), then StrategyWorkers, then RiskManager, then OrderExecutor. Never kill OrderExecutor while it holds a lock.

## Startup Sequence

```
1. Load Settings (Pydantic, fail fast on missing env vars)
2. Setup Loguru (file + stderr handlers)
3. Connect Redis pool (test with PING)
4. Connect PostgreSQL pool (test with SELECT 1)
5. ensure_consumer_groups() — idempotent
6. Drain pending stream messages (crash recovery)
7. Restore active workers from Redis (state.bot.workers)
8. Start shared components: RiskManager, OrderExecutor,
   PositionTracker, DBWriter, CommandListener,
   LLMSignalAgent, HealthHeartbeat,
   LiquidationCollector, PositionManager
9. SET state.bot.status = "running"
10. Enter asyncio.gather() — all tasks run forever
```

## Shutdown Sequence

```
1. Receive SIGTERM / SIGINT
2. SET state.bot.status = "paused"   ← blocks new signals
3. Stop all StrategyWorkers (stop_event.set())
4. Stop all DataCollectors
5. Drain remaining stream messages (give RiskManager/Executor time to finish)
6. Stop RiskManager, OrderExecutor, PositionTracker, DBWriter
7. Flush Loguru buffer
8. Close Redis pool
9. Close PostgreSQL pool
10. Exit 0
```

Positions remain open on shutdown — protected by exchange-native SL/TP orders. Emergency close is a separate explicit command.

## Reference Files

| Building… | Read |
|---|---|
| Entry point, signal handling, task orchestration | `references/main-process.md` |
| DataCollector WebSocket, reconnect, candle publish | `references/data-collector.md` |
| StrategyWorker signal loop, hot-reload | `references/strategy-worker.md` |
| RiskManager + OrderExecutor implementation | `references/risk-order-executor.md` |
| PositionTracker reconciliation + DBWriter | `references/position-tracker.md` |
| Pydantic Settings, Loguru setup, health heartbeat | `references/config-logging.md` |
| CVD trade stream, liquidation events, StrategyWorker wiring | `references/data-stream-extensions.md` |
