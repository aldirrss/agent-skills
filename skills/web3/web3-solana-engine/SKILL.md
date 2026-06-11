---
name: web3-solana-engine
description: Python bot engine implementation for Solana DEX trading — asyncio process skeleton, component wiring, config/logging setup, and production patterns. Use this whenever the user is building, debugging, or extending the core bot engine process — entry point, Scanner tasks, Strategy tasks, RiskManager, Execution, PositionTracker, DBWriter, CommandListener, health heartbeat, config loading, keypair loading, or Loguru logging. Trigger even when the user mentions one specific component (e.g. "how to wire Scanner to Strategy", "how to restart a crashed Strategy task", "how to load wallet keypair safely", "bot keeps re-entering a position", "how to handle Helius webhook alongside other tasks"). All code here assumes web3-solana-architecture (topology, Redis schema) and web3-solana (safety rules, swap execution) are loaded.
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-strategy
---

# Web3 Solana Bot Engine

Single asyncio process containing all bot components as coroutines/tasks. This skill provides the concrete implementation — the "how it actually looks in code" on top of the architectural blueprint in `web3-solana-architecture`.

## Component Dependency Graph

```
Settings + Loguru (loaded first, injected everywhere)
         │
         ▼
    Keypair (loaded once, passed only to Execution)
         │
    Redis pool ──────────────────────────────────┐
         │                                       │
    ensure_consumer_groups()                     │
         │                                       │
    SignalBuffer (shared across Strategy tasks)  │
         │                                       │
    ┌────▼──────────────────────────────────┐   │
    │  Scanner tasks (concurrent):          │   │
    │  - dexscreener_poller                 │──pub/sub──▶ Redis
    │  - gmgn_poller                        │
    │  - pumpfun_poller                     │
    │  - birdeye_poller                     │
    │  - kol_wallet_poller / helius_webhook │
    │  - cielo_discovery                    │
    │  - twitter_poller                     │
    │  - telegram_listener                  │
    └───────────────────────────────────────┘
         │ scanner.* pub/sub
    ┌────▼──────────────────────────────────┐
    │  Strategy tasks (concurrent):         │
    │  - kol_copy_trade                     │──stream.signals──▶ Redis
    │  - new_launch_snipe                   │
    │  - graduation_trade                   │
    │  - momentum_spike                     │
    │  - smart_money_confluence             │
    │  - social_alpha                       │
    │  - position_monitor                   │
    └───────────────────────────────────────┘
         │ stream.signals
    RiskManager ──stream.swaps──▶ Execution ──stream.fills──▶ PositionTracker
                                                              DBWriter
    CommandListener ──stream.commands──▶ (controls above)
    Monitor (heartbeat + alerts)
```

## Key Implementation Rules

1. **Keypair loaded once, passed only to Execution** — no other component receives the `Keypair` object. All others receive `pubkey_str` only.
2. **SignalBuffer is a shared in-memory object** — instantiated once in `main.py`, passed to all Strategy tasks. Not stored in Redis.
3. **All Strategy tasks subscribe to the same pub/sub channels** — each filters what it needs. This avoids duplicate Redis subscriptions.
4. **Every component logs with `logger.bind(component=...) `** — structured logs, filterable instantly.
5. **Tasks are named** — `asyncio.create_task(..., name="scanner.gmgn")` — visible in `asyncio.all_tasks()`.
6. **No bare `except Exception: pass`** — every exception is logged. Execution-path exceptions trigger emergency handling.
7. **Shutdown order matters** — stop Scanners first (no new signals), then Strategy, then RiskManager, then Execution last (may hold a lock).
8. **Config hot-reload** — Strategy and Risk components read from Redis keys on every evaluation cycle, not cached in memory.

## Startup Sequence

```
1.  Load Settings (Pydantic, fail fast on missing required env vars)
2.  Setup Loguru
3.  Load Keypair (from WALLET_PRIVATE_KEY env var)
4.  Connect Redis pool (PING test)
5.  Connect PostgreSQL pool (SELECT 1 test)
6.  Connect Solana RPC primary + fallback (getHealth test)
7.  Create aiohttp.ClientSession (shared across all HTTP components)
8.  ensure_consumer_groups() — idempotent XGROUP CREATE
9.  Drain pending stream messages (crash recovery)
10. Reconcile open positions (check state.position.* vs on-chain balance)
11. Set state.bot.status = "stopped"
12. Spawn CommandListener + Monitor (always running)
13. Wait for START command
14. On START: spawn all Scanner + Strategy + RiskManager + Execution + PositionTracker + DBWriter
15. Set state.bot.status = "running"
```

## Shutdown Sequence

```
1. SIGTERM / SIGINT received → stop_event.set()
2. SET state.bot.status = "paused"
3. Cancel Scanner tasks
4. Cancel Strategy tasks (after draining in-flight evaluations, max 5s)
5. Wait for RiskManager to finish current signal (max 10s)
6. Wait for Execution to finish current swap (max 60s)
7. Cancel RiskManager, PositionTracker, DBWriter
8. Flush Loguru buffer
9. Close aiohttp.ClientSession
10. Close Redis pool
11. Close PostgreSQL pool
12. Exit 0
```

Positions remain **open** on shutdown — protected by stop_loss stored in position state. Emergency close is via `EMERGENCY_STOP` command.

## Directory Layout

```
solana_bot/
├── main.py                      ← entry point
├── config.py                    ← Pydantic Settings
├── logger_setup.py              ← Loguru setup
├── components/
│   ├── scanner/
│   │   ├── dexscreener.py
│   │   ├── gmgn.py
│   │   ├── pumpfun.py
│   │   ├── birdeye.py
│   │   ├── helius.py
│   │   ├── kol_wallet.py
│   │   ├── cielo.py
│   │   ├── twitter.py
│   │   └── telegram.py
│   ├── strategy/
│   │   ├── buffer.py            ← SignalBuffer
│   │   ├── confluence.py        ← evaluate_confluence, publish_buy_signal
│   │   ├── kol_copy.py
│   │   ├── new_launch.py
│   │   ├── graduation.py
│   │   ├── momentum.py
│   │   ├── smart_money.py
│   │   ├── social_alpha.py
│   │   └── position_monitor.py
│   ├── risk_manager.py
│   ├── execution.py
│   ├── position_tracker.py
│   ├── db_writer.py
│   ├── command_listener.py
│   └── monitor.py
├── db/
│   └── models.py
└── .env
```

## Reference Files

| Building… | Read |
|---|---|
| Entry point, signal handling, task orchestration | `references/main-process.md` |
| Pydantic Settings, Loguru setup, RPC client init | `references/config-logging.md` |
| Scanner task runner, poller wiring, Helius webhook | `references/scanner-runner.md` |
| Strategy task runner, SignalBuffer wiring | `references/strategy-runner.md` |
| RiskManager + Execution implementation | `references/risk-execution.md` |
| PositionTracker, DBWriter, crash recovery | `references/position-tracker.md` |
| CommandListener, health heartbeat | `references/command-monitor.md` |
