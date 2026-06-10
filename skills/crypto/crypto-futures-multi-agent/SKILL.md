---
name: crypto-futures-multi-agent
description: "DRAFT — Multi-agent orchestration layer for crypto futures trading bot. Replaces AgentConfirmer (single agent) with a sequential specialist pipeline: MarketAnalystAgent → ConfluenceAgent → ExecutionAgent. Each agent has a focused role and small prompt, optimized for free/small LLMs. Use this skill only after crypto-futures-agent is working in production."
requires:
  - crypto-futures-agent
  - crypto-futures-bot-architecture
  - crypto-futures-bot-engine
---

# crypto-futures-multi-agent

> ⚠️ **DRAFT** — Architecture is designed and stable. Implementation is not yet complete.
> Use `crypto-futures-agent` (single agent) first. Migrate to multi-agent when you need
> higher confirmation quality and can afford slightly more latency (~1-3s extra per signal).

---

## When to Use This vs Single Agent

| | `crypto-futures-agent` | `crypto-futures-multi-agent` |
|---|---|---|
| Latency per signal | ~1-2s | ~3-6s |
| Cost per signal | ~750 tokens | ~2000-2500 tokens |
| Confirmation quality | Good | Better (specialized reasoning) |
| Model requirement | Any tool-capable model | Any tool-capable model |
| Complexity | Low | Medium |
| Production ready | ✅ Yes | 🚧 Draft |

---

## Architecture

```
stream.pre_signals
    │
AgentOrchestrator
    │
    ├─ ① MarketAnalystAgent
    │      Tools: get_candles, get_indicators, get_liquidation, get_funding
    │      Output: analyst_report {trend, structure, key_levels, bias}
    │
    ├─ ② ConfluenceAgent
    │      Input: pre_signal + analyst_report
    │      Tools: (none — pure reasoning on provided context)
    │      Output: confluence_score {score, supporting[], conflicting[]}
    │
    └─ ③ ExecutionAgent
           Input: pre_signal + analyst_report + confluence_score
           Tools: approve_signal, reject_signal (same as single-agent)
           Output: final decision → stream.signals or discard
```

**Key design:** Each agent gets a **small, focused prompt** with only the context it needs.
This keeps token usage low and works well with free/small models.

**Drop-in replacement:** `AgentOrchestrator` implements the same interface as `AgentConfirmer`.
Swap in `main.py` by replacing `AgentConfirmer` with `AgentOrchestrator`.

---

## Specialist Agents

### ① MarketAnalystAgent

**Role:** Pure market analysis. No trading decision. Just describe what the market is doing.

```
Input:  symbol, timeframe, raw indicator values
Output: {
  trend: "bullish" | "bearish" | "ranging",
  ema_stack: "aligned_bull" | "aligned_bear" | "mixed",
  rsi_zone: "oversold" | "neutral" | "overbought",
  cvd_bias: "buying" | "selling" | "neutral",
  key_levels: [{"type": "support"|"resistance", "price": "67000"}],
  liq_bias: "long_cascade" | "short_cascade" | "neutral",
  funding_bias: "long_crowded" | "short_crowded" | "neutral",
  summary: "One sentence market description"
}
```

Prompt focus: factual description only, no "should we trade" language.

---

### ② ConfluenceAgent

**Role:** Score how many confluences align with the proposed direction.
No raw data — only receives the pre_signal + analyst_report.

```
Input:  direction, strategy, analyst_report
Output: {
  score: 0.0-1.0,
  supporting: ["EMA stack bullish", "CVD buying bias"],
  conflicting: ["RSI overbought zone"],
  verdict: "strong" | "moderate" | "weak" | "against"
}
```

Prompt focus: check each confluence factor against the direction, score objectively.

---

### ③ ExecutionAgent

**Role:** Final decision with optional SL/TP refinement.
Receives the full picture: pre_signal + analyst_report + confluence_score.

Same tools as single-agent: `approve_signal`, `reject_signal`.

Decision rule:
- `confluence.verdict == "strong"` → approve (unless hard rejection trigger)
- `confluence.verdict == "moderate"` → approve with lower confidence
- `confluence.verdict == "weak"` or `"against"` → reject

---

## Shared Context Dict

```python
@dataclass
class AgentContext:
    pre_signal:      dict          # original pre_signal fields
    analyst_report:  dict | None = None   # set after step ①
    confluence:      dict | None = None   # set after step ②
    final_decision:  dict | None = None   # set after step ③
```

Passed through the pipeline. Each agent reads from and writes to it.

---

## Provider Strategy

Each agent can use a different provider/model. Recommended default:

| Agent | Recommended model | Reason |
|---|---|---|
| MarketAnalystAgent | Groq Llama 3.3 70B | Fast, good at structured JSON output |
| ConfluenceAgent | Groq Llama 3.3 70B | Pure reasoning, no tools needed |
| ExecutionAgent | DeepSeek Chat | Best reasoning per cost, reliable tool use |

All agents use the same `ProviderRouter` + `KeyPoolManager` from `crypto-futures-agent`.

---

## References

| File | Status |
|---|---|
| `references/orchestrator.md` | 🚧 Architecture + partial implementation |

---

## Implementation Checklist (for when you build this)

- [ ] `AgentOrchestrator` class implementing same interface as `AgentConfirmer`
- [ ] `MarketAnalystAgent` with structured JSON output (no tool use needed)
- [ ] `ConfluenceAgent` with structured JSON output
- [ ] `ExecutionAgent` reusing `CONFIRMER_TOOLS` from `crypto-futures-agent`
- [ ] `AgentContext` dataclass and pipeline runner
- [ ] Per-agent provider config (optional: same provider for all)
- [ ] Integration test: pre_signal → orchestrator → stream.signals
- [ ] Performance benchmark vs single-agent (latency + token cost)
