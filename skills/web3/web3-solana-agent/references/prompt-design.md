# Prompt Design

Design principles and patterns for the 4 sub-agent prompts. Full prompt implementations
are in `references/sub-agents.md`. This document explains the *why* behind design choices.

---

## Response Format: Plain Text, Not JSON

All 4 agents use the same plain-text response format:

```
SCORE: <integer 0-100>
REASON: <one sentence>
```

**Why plain text instead of JSON:**
- Target models (Llama 3.1 8B, Gemini Flash) reliably emit `SCORE: 75` — they struggle with
  correct JSON escaping when prompted fast at `temperature=0.1`
- Simpler parsing = fewer failure modes
- `_parse_response()` in `BaseAgent` handles this format with 5 lines of code

**Why `temperature=0.1`:**
Scoring must be consistent across repeated calls for the same token. Low temperature keeps
the model deterministic. Higher temperature introduces noise that can flip gate decisions.

---

## Parsing (`BaseAgent._parse_response`)

```
SCORE: 75        → score = 75.0   (clamped to [0, 100])
REASON: Strong…  → reasoning = "Strong…"
```

Fallback on any parse failure:
- `score = 50.0` (neutral — fail-open, does not pull down or inflate final score)
- `reasoning = "no_reason_parsed"`

The caller (`score_batch`) never raises on parse failure — it logs and continues.

---

## Per-Agent Prompt Design Rationale

### Market Agent
**Goal:** Price momentum + entry quality  
**Key data:** price, market_cap, liquidity, volume, price_change_1h, age_minutes, holder_count  
**Design principle:** Include numeric bands in the prompt so the model maps numbers → score
ranges without needing context about what "$50k liquidity" means in absolute terms.

```
- 90–100: Exceptional momentum, deep liquidity, strong volume, early entry
- 70–89:  Good setup, reasonable liquidity, healthy trend
- 50–69:  Neutral, mixed signals
- 30–49:  Weak setup — low volume, thin liquidity, or late entry
- 0–29:   Poor — no momentum, suspicious volume, or extremely thin
```

### Safety Agent
**Goal:** Rug/scam detection  
**Key data:** rugcheck_score, is_honeypot, liquidity_locked, top_holder_pct, holder_count  
**Design principle:** Hard constraints embedded in the prompt — not soft guidance:

```
CRITICAL: If honeypot=YES, score must be 0.
If rugcheck_score < 30, score must be <= 20.
```

These rules duplicate the thresholds in the Safety Agent `_build_prompt`. Embedding them
directly means even a weak model will respect the constraint without needing tool calls.

**TIMEOUT = 3s** — shortest of all agents. Safety data is fully structured (no ambiguity),
so the model needs minimal reasoning time. A safety timeout returns `score=50`, which
with safety weight of 30% pulls the final score down to ≤ 80 if other agents score ~90
— effectively blocking most approvals. This is the conservative default behavior.

### Risk Agent
**Goal:** R/R favorability given current portfolio state  
**Key data:** open_positions_count, daily_loss_pct, liquidity_usdc, market_cap, price_change_1h, age_minutes  
**Design principle:** Include portfolio state so the model can penalize over-exposure.
A token with good market data should still score lower if the bot already has 4 open positions.

### Social Agent
**Goal:** Narrative + community quality  
**Key data:** kol_buy_count, telegram_mentions, twitter_sentiment, narrative  
**Design principle:** Sentiment is pre-labeled (`positive` / `neutral` / `negative`) to
avoid the model needing to interpret a raw 0.0–1.0 float. The raw float is included in
parentheses for nuance but the label carries the semantic weight.

**TIMEOUT = 8s** — longest of all agents. Social analysis requires more reasoning
(narrative quality is harder to derive mechanically than a rugcheck score).

---

## Token Budget

| Agent | Provider | Model | Prompt tokens (est.) | Response tokens |
|---|---|---|---|---|
| Market | Groq | llama-3.1-8b-instant | ~120 | ~20 |
| Safety | Groq | llama-3.1-8b-instant | ~100 | ~20 |
| Risk | Groq | llama-3.1-8b-instant | ~110 | ~20 |
| Social | Gemini | gemini-2.0-flash | ~100 | ~20 |

`max_tokens=150` is set in `BaseAgent._score_one` — more than enough for `SCORE: 75\nREASON: ...`.

**Groq free tier:** 14,400 requests/day. With 3 keys and 15 tokens/batch:
`5 calls/key/batch × 3 keys = 15 calls/batch`. At 100 batches/day = 1,500 calls/day —
well within the free tier. Scale linearly with more keys (up to 5).

**Gemini Flash free tier:** 1M tokens/day. At ~120 tokens/call × 15 calls/batch × 100 batches/day
= 180K tokens/day — 18% of the free tier.

---

## Extending a Sub-Agent Prompt

To add a new data field to a prompt:

1. Add the field to `TokenContext` in `references/types.md`
2. Populate it in `OrchestratorAgent._fetch_contexts()` in `references/orchestrator.md`
3. Use it in the relevant agent's `_build_prompt()` in `references/sub-agents.md`

To change the scoring rubric (e.g., tighten safety threshold):

- Edit the numeric bands in `_build_prompt()` — no other code change needed
- Gate 2 threshold (`APPROVAL_THRESHOLD = 80.0`) is separate from the prompt rubric

---

## What NOT to Do

**Do not ask for JSON.** Models like Llama 3.1 8B will occasionally wrap it in markdown
fences or add trailing commas. `SCORE: 75` never has that ambiguity.

**Do not use multi-turn conversation.** One user message per token call. Adding a system
message is unnecessary — the role instruction is embedded in the user prompt ("You are a
crypto market analyst...") and small models handle it just as well.

**Do not set `temperature=0`.** Some providers treat `temperature=0` differently or reject
it. Use `0.1` — effectively deterministic for short scoring tasks.

**Do not increase `max_tokens` beyond 150.** The model has nothing to add after one
`SCORE` line and one `REASON` line. Extra tokens = extra latency + cost.
