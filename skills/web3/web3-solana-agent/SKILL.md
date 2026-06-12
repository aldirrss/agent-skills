---
name: web3-solana-agent
description: >
  Multi-agent LLM orchestration layer for Solana DEX trading bot — OrchestratorAgent dispatches
  tokens to four parallel sub-agents (Market, Safety, Risk, Social), aggregates scores, and gates
  on score >= 80 before publishing to stream.agent.approved (read by RiskManager). Use this whenever the user is building or
  debugging the agent layer, including: OrchestratorAgent wiring, sub-agent prompt design,
  provider key pool rotation, score aggregation, fail-open behavior, or Gate 2 logic.
  Trigger on: "orchestrator agent", "market agent", "safety agent", "risk agent", "social agent",
  "LLM scoring", "agent layer", "key pool", "provider rotation", or "score aggregate".
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-signal-aggregator
---

# web3-solana-agent

The agent layer sits between SignalAggregator (GATE 1) and RiskManager (via stream.agent.approved). It uses Claude to
qualitatively score each candidate token across four dimensions before any position is opened.

**Key principle: fail open.** If any sub-agent times out or errors, its score defaults to 50
(neutral). If all sub-agents fail, the batch is skipped and logged — trading never crashes
because the LLM layer is unavailable.

## Architecture Position

```
stream.agent.eligible       ← from SignalAggregator (batch of top-N mints)
    │
    ▼
OrchestratorAgent
    ├── fetch TokenContext for each mint (Redis)
    └── asyncio.gather (parallel dispatch)
         ├── MarketAgent   → scores all mints via Key pool
         ├── SafetyAgent   → scores all mints via Key pool
         ├── RiskAgent     → scores all mints via Key pool
         └── SocialAgent   → scores all mints via Key pool
    │
    ▼  aggregate scores (weighted average)
    │  fail-open: timed-out agent → score = 50
    │
GATE 2: score >= 80?
    ├── Yes → XADD stream.agent.approved  { mint, scores, reasoning }
    └── No  → log Skip: Reason AI
```

## Four Sub-Agents

Each sub-agent returns a score 0–100 and a one-line reasoning string.

| Agent | Evaluates | Timeout | Weight |
|---|---|---|---|
| **Market Agent** | Price momentum, volume trend, liquidity depth, entry quality | 5 s | 25% |
| **Safety Agent** | Rugpull risk, honeypot, contract, holder concentration | 3 s | 30% |
| **Risk Agent** | Risk/reward ratio, portfolio correlation, timing quality | 5 s | 25% |
| **Social Agent** | Narrative strength, Telegram/KOL quality, sentiment momentum | 8 s | 20% |

Safety Agent carries the highest weight — a low safety score should decisively pull down the final score.

## Score Aggregation

```python
AGENT_WEIGHTS = {"market": 0.25, "safety": 0.30, "risk": 0.25, "social": 0.20}

final_score = sum(scores[agent] * weight for agent, weight in AGENT_WEIGHTS.items())
# Fail-open: timed-out or errored agent → scores[agent] = 50
```

Gate 2 threshold: `final_score >= 80` → forward to `stream.agent.approved`.

## Key Pool

All sub-agents use **litellm** — satu interface untuk semua provider. Setiap agent
punya **satu provider** dan **3–5 API keys** yang rotate deterministik per token:

```
token_index % len(keys)  →  key assignment
Token 1→Key1, Token 2→Key2, Token 3→Key3, Token 4→Key1, ...
```

**Engine tidak bisa jalan** jika key count < 3 per provider — divalidasi saat startup.

Default per-agent (free tier):

| Agent | Provider | Default Model |
|---|---|---|
| Market | Groq | `groq/llama-3.1-8b-instant` |
| Safety | Groq | `groq/llama-3.1-8b-instant` |
| Risk | Groq | `groq/llama-3.1-8b-instant` |
| Social | Gemini | `gemini/gemini-2.0-flash` |

Minimum wajib di `.env`:
```
GROQ_API_KEYS=gsk_1,gsk_2,gsk_3        # 3–5 keys, untuk market/safety/risk
GEMINI_API_KEYS=AIza_1,AIza_2,AIza_3   # 3–5 keys, untuk social
```

## Redis Keys Consumed

| Key | Source | Used by |
|---|---|---|
| `state.price.{mint}` | Scanner | Market Agent |
| `state.token.{mint}` | Scanner | Market Agent, Safety Agent, Risk Agent |
| `state.safety.{mint}` | Scanner | Safety Agent |
| `state.social.{mint}` | Scanner | Social Agent |
| `state.open_positions_count` | PositionTracker | Risk Agent |
| `state.daily_loss_pct` | RiskManager | Risk Agent |
| `llm.score.{mint}` | OrchestratorAgent | Cache — TTL 300 s |

## Reference Files

| Building… | Read |
|---|---|
| Shared types (AgentScore, TokenContext) | `references/types.md` |
| OrchestratorAgent implementation | `references/orchestrator.md` |
| 4 sub-agent implementations + prompts | `references/sub-agents.md` |
| KeyPoolManager + provider rotation | `references/key-pool.md` |
| Prompt design principles | `references/prompt-design.md` |
| Wiring into bot engine | `references/integration.md` |
