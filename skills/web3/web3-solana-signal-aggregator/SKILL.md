---
name: web3-solana-signal-aggregator
description: >
  SignalAggregator (GATE 1) component for Solana DEX trading bot — aggregates per-token strategy
  signals, enforces minimum strategy match threshold, ranks candidate tokens by composite score,
  selects top 15 for the Orchestrator Agent, and short-circuits on circuit breaker state.
  Use this whenever the user is building or debugging the signal aggregation layer, including:
  multi-strategy confluence tracking, token eligibility rules, composite score formula, Redis
  sorted-set queue management, per-strategy match windows, or circuit breaker integration.
  Sits between Strategy output and Orchestrator Agent in the pipeline.
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-strategy
  - web3-solana-risk
---

# web3-solana-signal-aggregator

SignalAggregator is **GATE 1** in the pipeline. It sits between Strategy output and the Orchestrator
Agent. Its job is single-responsibility: decide which tokens are worth spending LLM budget on.

## Position in the Pipeline

```
Strategy (x6)
  └── XADD stream.signals  { mint, strategy_name, confidence, ... }

SignalAggregator  ← this skill
  ├── XREADGROUP stream.signals  (consumer group: aggregator-group)
  ├── HSET signal.match.{mint}  strategy_name → timestamp
  ├── Rule 1: SCARD valid matches >= MIN_STRATEGY_MATCH (2)
  ├── Rule 2: ZADD agent.queue  composite_score  mint  → ZREVRANGE top 15
  ├── Rule 3: check state.bot.status + position count before dispatch
  └── XADD stream.agent.eligible  { batch of top-N mints }

Orchestrator Agent
  └── XREADGROUP stream.agent.eligible
```

## Three Rules (All Must Pass)

### Rule 1 — Minimum Strategy Match
Token must be flagged by **≥ 2 different strategies** within each strategy's time window.
Each strategy has its own staleness window — a `new_launch_snipe` signal expires in 60 s,
a `smart_money_confluence` signal is valid for 15 min.

```python
STRATEGY_WINDOWS = {
    "new_launch_snipe":       60,
    "kol_copy_trade":        120,
    "momentum_spike":        120,
    "graduation_trade":      300,
    "social_alpha":          300,
    "smart_money_confluence": 900,
}
```

Redis key: `signal.match.{mint}` — Hash of `strategy_name → unix_timestamp`.
Master TTL on the hash = max window (900 s). Valid match count is computed at read time
by filtering out entries older than their strategy's window.

### Rule 2 — Top-15 Ranked Queue (not a hard reject)
Tokens are scored and placed in a Redis Sorted Set. At dispatch time, take `min(queue_size, 15)`.
If only 6 tokens are in the queue, all 6 go to Orchestrator. The queue is cleared after each
dispatch batch so stale candidates do not persist.

**Composite score formula:**
```
score = (valid_match_count × 30)
      + strategy_weight_bonus          # best single strategy in the match set
      + recency_bonus                  # 0–10, decays 1 pt/min from first match
```

Strategy weight bonuses:
| Strategy | Bonus |
|---|---|
| `smart_money_confluence` | +20 |
| `kol_copy_trade` | +15 |
| `graduation_trade` | +15 |
| `new_launch_snipe` | +12 |
| `momentum_spike` | +10 |
| `social_alpha` | +8 |

### Rule 3 — Circuit Breaker Check
Before dispatching to Orchestrator, run two checks. If either fails, skip the entire batch
silently (do not XADD to `stream.agent.eligible`). Reason is logged.

**Check 1 — Bot status:**
```python
state.bot.status != "running"  →  skip dispatch
```
Covers all pause reasons — manual pause, daily loss cap, daily profit cap.
All set `state.bot.status = "paused"` (RiskManager / CommandListener).

**Check 2 — Positions full:**
```python
len(state.position.*) >= config.risk.max_concurrent_positions  →  skip dispatch
```
No point running 4 LLM sub-agents per token when RiskManager will reject every BUY anyway.
Reads `max_concurrent_positions` from `config.risk` (default: 5).

## Redis Schema

```
signal.match.{mint}    HASH    strategy_name → unix_timestamp (TTL 900s)
agent.queue            ZSET    mint → composite_score  (cleared after dispatch)
stream.signals         STREAM  input  (consumer group: aggregator-group)
stream.agent.eligible  STREAM  output { mints: [...], batch_id: uuid }

state.bot.status       STRING  read-only — circuit breaker check (paused/stopped → skip)
state.position.*       STRING  read-only — position count check (penuh → skip dispatch)
config.risk            STRING  read-only — max_concurrent_positions
```

## Fail-Safe Behaviours

| Condition | Behaviour |
|---|---|
| Redis error reading `signal.match` | Skip token, log warning, continue loop |
| Circuit breaker state key missing | Treat as closed (assume safe) |
| Zero tokens pass all rules | Do not publish to `stream.agent.eligible` |
| `stream.signals` idle > 30 s | Emit heartbeat to Monitor, keep loop alive |

## Full Implementation

See `references/signal-aggregator.md`.
