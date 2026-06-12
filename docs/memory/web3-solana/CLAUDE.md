# [PROJECT_NAME] — Claude Code Rules

Read this file before writing any code for this project.

---

## Non-Negotiable Safety Rules

1. **Private keys never leave `Execution`** — Keypair only in `__init__` of Execution,
   never passed to other components, never logged, never serialized
2. **DRY_RUN=true default** — every new code path must work without real transactions
3. **Slippage must be non-zero** — no swap without an explicit `slippage_bps`
4. **Verify on-chain before retry** — never resend a transaction without on-chain confirmation
5. **All monetary amounts = Decimal** — no floats, except inbound data from external APIs

---

## Pipeline (mandatory order — do not change)

```
stream.signals → SignalAggregator (GATE 1) → stream.agent.eligible
             → OrchestratorAgent (GATE 2) → stream.agent.approved
             → RiskManager (BUY path)     → stream.swaps
             → Execution                  → stream.fills
```

SELL path: `stream.signals` → RiskManager directly (bypasses GATE 1 & 2).

---

## Consumer Groups (do not change)

| Stream | Group | Component |
|---|---|---|
| stream.signals | aggregator-group | SignalAggregator |
| stream.signals | risk-sell-group | RiskManager (SELL only) |
| stream.agent.eligible | orchestrator-group | OrchestratorAgent |
| stream.agent.approved | risk-group | RiskManager (BUY) |
| stream.swaps | exec-group | Execution |
| stream.fills | tracker-group | PositionTracker |
| stream.fills | db-group | DBWriter |
| stream.commands | cmd-group | CommandListener |

---

## TP/SL Code Constants (not configurable)

```python
TAKE_PROFIT_PCT = Decimal("1.0")   # 2× entry price

SL_TIERS = [
    (500_000, Decimal("0.15")),
    ( 50_000, Decimal("0.20")),
    ( 10_000, Decimal("0.30")),
    (      0, Decimal("0.40")),
]
```

**`config.risk` must NOT have `stop_loss_pct` or `take_profit_pct`.**

---

## Agent Layer Rules

- `KeyPoolManager` is instantiated first in `main.py` — if < 3 keys per provider,
  bot will not start (`ValueError` in `__init__`)
- `OrchestratorAgent` is mandatory — no `AGENT_ENABLED` flag
- Gate threshold: `final_score >= 80` to pass to `stream.agent.approved`
- Fail-open: agent timeout/error → sub-agent score = 50, bot continues
- Sub-agent response format: `SCORE: 75\nREASON: ...` (not JSON)

---

## Redis Naming Conventions

- State: `state.{entity}.{identifier}` → `state.position.{mint}`, `state.bot.status`
- Config: `config.{domain}` → `config.risk`, `config.strategy`
- Stats: `stats.{metric}` → `stats.daily_pnl`, `stats.wins.{strategy}`
- Signal tracking: `signal.match.{mint}` (Hash, TTL 900s)
- LLM cache: `llm.score.{mint}` (TTL 300s)

---

## PositionTracker Rule

PositionTracker **must not** calculate SL/TP. The values `stop_loss_price` and
`take_profit_price` are read directly from `fill.get("stop_loss_price")` — already
calculated by RiskManager at approval time and forwarded via `stream.swaps` → `stream.fills`.

---

## Logging

- All components use `logger.bind(component="name")` — never bare `logger`
- Never log: `WALLET_KEYPAIR_B64`, `GROQ_API_KEYS`, `GEMINI_API_KEYS`
- Trade outcome always logged: `symbol`, `pnl_usdc`, `pnl_pct`, `reason`

---

## Relevant Skills

Use `@[PROJECT_NAME]-architecture` for Redis topology and stream schema.
Use `@[PROJECT_NAME]-risk` for TP/SL constants and position sizing.
Use `@[PROJECT_NAME]-agent` for OrchestratorAgent and KeyPoolManager details.
Use `@[PROJECT_NAME]-signal-aggregator` for GATE 1 logic.
Use `@[PROJECT_NAME]` for all on-chain safety rules.
