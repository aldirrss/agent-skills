---
name: web3-solana-agent
description: LLM agent layer for Solana DEX trading bot — Claude-powered signal scoring, token sentiment analysis, social context evaluation, and confluence enrichment. Use this whenever the user wants to add an AI/LLM layer to their Solana bot, including: scoring a token's narrative strength from social data, evaluating Telegram call quality, confidence adjustment via LLM reasoning, or building an AgentConfirmer component that sits between Strategy and RiskManager. Trigger when the user mentions "LLM signal", "Claude scoring", "AI layer", "agent confirmer", "smart filter", or wants the bot to reason about token quality beyond pure on-chain metrics.
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-strategy
---

# web3-solana-agent

Optional LLM signal enrichment layer. `AgentConfirmer` sits between Strategy output and RiskManager — it scores each BUY signal with Claude before the signal proceeds downstream. The LLM enriches confidence; it never blocks the pipeline.

**Key principle: fail open.** If Claude is unavailable (timeout, API error, quota), the original signal passes through unchanged with its original confidence. Trading never stops because the LLM layer is down.

## Architecture Position

```
stream.signals.raw
    │
    ▼  (only when AGENT_ENABLED=true)
AgentConfirmer
    │  consumer group: agent-group
    │  consumer: agent-confirmer-1
    │
    │  For BUY signals:
    │    1. Check llm.score.{mint} cache (TTL 300s)
    │    2. If cache hit → use cached score
    │    3. If cache miss → call Claude (max 8s, or strategy-specific timeout)
    │    4. Adjust confidence: final = original*0.7 + llm_score*0.3
    │    5. Re-publish with updated confidence + llm_scored=true
    │
    │  For SELL signals:
    │    Pass through immediately, no LLM call
    │
    ▼
stream.signals          ← RiskManager reads this (unchanged interface)
```

**Without AgentConfirmer** (default, `AGENT_ENABLED=false`):
```
Strategy → stream.signals → RiskManager
```

**With AgentConfirmer** (`AGENT_ENABLED=true`):
```
Strategy → stream.signals.raw → AgentConfirmer → stream.signals → RiskManager
```

RiskManager's Redis consumer group always reads `stream.signals`. Only the publisher changes.

## What the LLM Evaluates

Given a BUY signal, Claude scores 0.0–1.0 based on:

1. **Narrative strength** — is there a real story behind this token? Meme with viral hook, DeFi protocol with genuine use case, or pure pump with no substance?
2. **Social signal quality** — are the sources organic (wallet activity, on-chain buys) or likely bot/paid (Telegram call-only, no wallet backing)?
3. **Red flags** — rug indicators surfaced by on-chain data, suspicious liquidity patterns, KOL count vs volume disparity.

LLM score contributes 30% weight to final confidence. On-chain signals (70%) always dominate.

```python
final_confidence = original_confidence * 0.7 + llm_score * 0.3
```

## Redis Keys (New)

```
stream.signals.raw          Redis Stream — Strategy publishes here when agent enabled
llm.score.{mint}            string — cached LLM score (0.0–1.0) as float str, TTL 300s
llm.cache.{hash}            string — full LLM response cache keyed by prompt hash, TTL 600s
```

`llm.cache.{hash}` deduplicates identical prompts (same mint, same signal data snapshot) within 10 minutes. Hash is computed from: `mint + strategy + signal_sources + price_change_1h_bucket + liquidity_bucket`.

## Settings

```bash
AGENT_ENABLED=false                              # opt-in — false by default
ANTHROPIC_API_KEY=sk-ant-...
AGENT_MODEL=claude-haiku-4-5                     # fastest/cheapest for scoring
AGENT_MAX_TOKENS=100                             # response is tiny JSON
```

Strategy-specific timeouts (total budget including queue wait + API call):

```python
AGENT_TIMEOUTS = {
    "new_launch_snipe":      2,    # ultra time-sensitive — 2s hard cap
    "kol_copy_trade":        5,
    "graduation_trade":      8,
    "momentum_spike":        5,
    "smart_money_confluence": 8,
    "social_alpha":          8,
}
```

## Mandatory Rules

1. **Never block trading** — `AGENT_ENABLED=false` is the safe default. LLM failure always results in passthrough, never signal drop.
2. **SELL signals bypass LLM entirely** — exits are time-critical and rule-based. Never add latency to SELL path.
3. **Cache aggressively** — same mint, same signal data → same LLM answer within 5 min. Avoid paying for duplicate scoring.
4. **LLM score is enrichment only** — it adjusts confidence by at most ±30%. A signal with 0.9 confidence + LLM score 0.0 still has final confidence 0.63 (passes most thresholds). A signal with 0.3 confidence + LLM score 1.0 still has final confidence 0.51 (may be near threshold). On-chain signals always dominate.
5. **Prompt caching** — system prompt is large and stable. Cache it with `cache_control` on every call to cut input token cost ~90%.

## Reference Files

| Building… | Read |
|---|---|
| Full `AgentConfirmer` class, consumer loop, caching | `references/agent-confirmer.md` |
| Prompt design, scoring template, response parsing | `references/prompt-design.md` |
| Wiring into engine, stream routing, Settings changes | `references/integration.md` |
