---
name: web3-solana-architecture
description: Blueprint for building a production-grade Solana DEX trading bot with multi-component asyncio architecture, Redis message bus, on-chain swap execution, and signal-driven strategy. Use this whenever the user is designing, building, or debugging any part of a Solana trading bot — process topology, Redis stream/pubsub schema, component lifecycle, event flow, wallet management, or signal integration. Trigger even when the user only mentions one component (e.g. "how should scanner communicate with strategy", "how to sign a Jupiter swap transaction", "where to store wallet state", "how to handle execution failure"). This skill defines the authoritative architecture — all other web3-solana-* skills operate within it.
requires:
  - web3-solana
---

# Web3 Solana Trading Bot Architecture

This skill defines the **canonical architecture** for a production Solana DEX trading bot. All components, naming conventions, and data flows described here are authoritative. When building any part of the system, reference this first to ensure components integrate correctly.

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  SIGNAL SOURCES                                                 │
│  DEXScreener · GMGN · KOL Wallets · On-chain Events            │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTP / WebSocket / RPC
┌──────────────────────────▼──────────────────────────────────────┐
│  BOT ENGINE (single asyncio process)                            │
│                                                                 │
│  CommandListener ─────────────────────────────────────────────  │
│  Scanner          (poll DEXScreener, GMGN, wallet tracker)      │
│  Strategy         (evaluate signals, build decision)            │
│  RiskManager      (gate: rugpull, liquidity, position limits)   │
│  Execution        (build tx, sign, send via Jupiter)            │
│  PositionTracker  (track open positions, PnL)                   │
│  DBWriter         (async write to PostgreSQL)                   │
│  Monitor          (log, alert Telegram/Discord, heartbeat)      │
└──────────────────────────┬──────────────────────────────────────┘
                           │ READ / WRITE
            ┌──────────────▼──────────────┐
            │  REDIS MESSAGE BUS          │
            │  Streams · Pub/Sub · Keys   │
            └──────────────┬──────────────┘
                           │
            ┌──────────────▼──────────────┐
            │  PostgreSQL                 │
            │  Trade history · PnL · Cfg  │
            └─────────────────────────────┘
                           │
            ┌──────────────▼──────────────┐
            │  SOLANA NETWORK             │
            │  Jupiter Swap · Raydium     │
            │  RPC (Helius / QuickNode)   │
            └─────────────────────────────┘
```

## Architectural Decisions (Fixed)

These decisions are non-negotiable. Do not generate code that contradicts them.

**1. Redis Hybrid Pattern**
- `Pub/Sub` → high-frequency, loss-tolerant data (token ticks, scanner results, UI updates)
- `Streams` → order-critical events (signals, swap requests, fills, commands)
- Reasoning: swap events must survive process crashes. Pub/Sub cannot replay. Streams can.

**2. Single asyncio process for bot engine**
- All components are asyncio tasks, not subprocesses or threads
- Bot is I/O-bound (RPC, HTTP APIs, Redis, DB) — asyncio is optimal
- Shared Redis connection pool, shared state managers
- Components spawned/killed at runtime via CommandListener

**3. Jupiter as primary swap router**
- All swaps go through Jupiter V6 Swap API — never call Raydium/Orca directly
- Jupiter returns the best route automatically across all DEXes
- Raw transaction from Jupiter → sign locally with `solders` → submit via `solana-py`
- Fallback: if Jupiter quote fails, skip the trade (never retry with raw DEX call)

**4. Wallet isolation**
- One trading keypair per bot instance (loaded from encrypted file or env var)
- Private key never stored in Redis or DB
- All signing happens in Execution component only — no other component touches keypair

**5. Single source of truth**
- Real-time state lives in Redis (positions, open swaps, bot status, latest prices)
- Persistent state lives in PostgreSQL (trade history, PnL, token watchlist, config)
- No component maintains its own local state beyond in-flight buffers

**6. Signal confluence before entry**
- Strategy requires minimum N signals aligned before publishing buy decision
- No single signal source (e.g. one KOL wallet buy) triggers a trade alone
- Confluence threshold is configurable per token category

## Stack

```
solders          # keypair, transaction building, signing (Rust-binding)
solana-py        # AsyncClient for Solana RPC (getBalance, sendTransaction, etc.)
aiohttp          # HTTP client for DEXScreener, GMGN, Jupiter V6 API
asyncio          # event loop (all components are coroutines)
loguru           # structured logging
pydantic         # config validation and data models
redis[hiredis]   # async Redis client (aioredis-compatible)
asyncpg          # async PostgreSQL driver
```

## Redis Naming Convention

```
# Streams (persistent, replayable)
stream.signals              # Strategy → RiskManager
stream.swaps                # RiskManager → Execution
stream.fills                # Execution → PositionTracker + DBWriter
stream.commands             # external → CommandListener

# Pub/Sub channels (fire-and-forget)
scanner.token.new           # Scanner → Strategy (new token detected)
scanner.token.trending      # Scanner → Strategy (trending token update)
scanner.wallet.buy          # Scanner → Strategy (KOL wallet buy event)
position.updates            # PositionTracker → Monitor

# Redis Keys (state cache)
state.position.{mint}       # current position for token mint, JSON
state.bot.status            # "running" | "paused" | "stopped"
state.bot.tokens            # SET of active token mints being tracked
state.price.{mint}          # latest token price in SOL/USDC, float string
state.kol.wallets           # SET of KOL wallet addresses to track
config.strategy             # strategy parameters, JSON
config.risk                 # risk parameters (max position, stop loss %), JSON
```

## Component Responsibilities

| Component | Reads from | Writes to | Must NOT |
|---|---|---|---|
| Scanner | DEXScreener, GMGN, Solana RPC | `scanner.*` pub/sub | Place orders |
| Strategy | `scanner.*` pub/sub | `stream.signals` | Access DB directly |
| RiskManager | `stream.signals` | `stream.swaps` | Modify positions directly |
| Execution | `stream.swaps` | `stream.fills`, Solana RPC | Skip fill verification |
| PositionTracker | `stream.fills` | `state.position.*`, `position.updates` | Place orders |
| DBWriter | `stream.fills`, `stream.signals` | PostgreSQL | Block any other component |
| CommandListener | `stream.commands` | Spawn/cancel tasks, `state.bot.status` | Process orders |
| Monitor | `position.updates`, `state.bot.status` | Telegram/Discord alerts, logs | Modify state |

## Global Invariants

These must hold at all times. If generating code that could violate them, add an explicit guard:

- A token mint can have at most **one open position** at a time (enforced by RiskManager)
- Execution processes **one swap at a time per mint** (asyncio.Lock per mint)
- No component calls Jupiter API or signs transactions except Execution
- Every swap attempted must be recorded in `stream.fills` regardless of outcome
- Bot cannot enter new positions when `state.bot.status` ≠ `"running"`
- Emergency stop sells ALL open positions before setting status to `"stopped"`
- Wallet keypair loaded once at startup, never re-read from disk during runtime

## Reference Files

| Building… | Read |
|---|---|
| Redis stream schema, consumer groups, pub/sub channels | `references/redis-topology.md` |
| Component spawn/stop/crash recovery, task lifecycle | `references/component-lifecycle.md` |
| Full event flow from scanner signal to swap fill | `references/event-flow.md` |
| Jupiter swap API, transaction signing, RPC submission | `references/swap-execution.md` |
| Command schema, emergency stop protocol | `references/control-interface.md` |
