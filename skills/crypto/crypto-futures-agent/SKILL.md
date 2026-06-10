---
name: crypto-futures-agent
description: AI agent confirmation layer for crypto futures trading bot. AgentConfirmer sits between StrategyWorker and RiskManager — rule-based strategies produce pre-signals, the agent approves or rejects with explicit reasoning. Multi-provider LLM support (Groq, Gemini, OpenRouter, DeepSeek, Qwen, OpenAI, Anthropic) with per-provider API key pooling for TPM/RPD scaling. Use when adding AI-powered signal confirmation to a crypto-futures-bot-engine project.
requires:
  - crypto-futures
  - crypto-futures-bot-architecture
  - crypto-futures-bot-engine
---

# crypto-futures-agent

AI-powered confirmation layer that augments (does not replace) rule-based strategies.
Rule-based strategies run first as a cheap first-pass filter. Candidate signals that
pass a lower pre-signal threshold are forwarded to the `AgentConfirmer`, which uses
an LLM to approve or reject with explicit reasoning before the signal enters `RiskManager`.

## Architecture

```
StrategyWorker
    │ score >= pre_signal_threshold (e.g. 0.4)  ← lower bar than normal
    ↓
stream.pre_signals               ← new Redis Stream
    │
AgentConfirmer (asyncio task)
    │  ProviderRouter → KeyPoolManager → LLM call
    │  approve  → optionally refine SL/TP
    │  reject   → log reason, discard
    │  fail/timeout → passthrough (fail-safe, signal is not lost)
    ↓
stream.signals                   ← existing pipeline continues unchanged
    │
RiskManager → OrderExecutor → ...
```

**Key invariant:** `RiskManager` and everything downstream are untouched.
The agent only decides whether to forward a signal — it never sizes positions or
places orders directly.

## Components

| Reference | Purpose |
|---|---|
| `references/llm-providers.md` | `APIKey`, `ProviderConfig`, LLM clients (OpenAI-compatible + Anthropic) |
| `references/key-pool-manager.md` | Per-provider key rotation, cooldown tracking, daily limit enforcement |
| `references/agent-confirmer.md` | `ProviderRouter`, `AgentConfirmer` component, `main.py` integration |
| `references/agent-tools.md` | Tool definitions + `ToolExecutor` (market context, approve, reject) |
| `references/agent-prompts.md` | System prompt + pre-signal message builder |

## Supported Providers

| Provider | Base URL pattern | Free tier | Best free model |
|---|---|---|---|
| `groq` | `api.groq.com/openai/v1` | ✅ generous | `llama-3.3-70b-versatile` |
| `gemini` | `generativelanguage.googleapis.com/.../openai` | ✅ Flash free | `gemini-2.0-flash` |
| `openrouter` | `openrouter.ai/api/v1` | ✅ free models | `meta-llama/llama-3.3-70b-instruct:free` |
| `deepseek` | `api.deepseek.com/v1` | ✅ very cheap | `deepseek-chat` |
| `qwen` | `dashscope.aliyuncs.com/.../openai` | ✅ limited | `qwen2.5-72b-instruct` |
| `openai` | `api.openai.com/v1` | ❌ paid | `gpt-4o-mini` |
| `anthropic` | Anthropic SDK | ❌ paid | `claude-haiku-4-5` |

All providers except `anthropic` use the OpenAI-compatible HTTP interface.
`anthropic` uses the Anthropic Python SDK with automatic tool format conversion.

## Redis Keys (new)

```
stream.pre_signals                           Redis Stream — candidate signals from StrategyWorker
llm.pool.{provider}.{idx}.requests_today    counter (TTL 86400s — auto daily reset)
llm.pool.{provider}.{idx}.tokens_today      counter (TTL 86400s)
llm.pool.{provider}.{idx}.cooldown_until    float unix ts (set on 429, TTL = retry_after)
llm.pool.{provider}.rotation_idx            int — current round-robin pointer
```

## Environment Variables

```bash
# Provider selection
AGENT_PROVIDER=groq                          # primary provider
AGENT_FALLBACK_CHAIN=openrouter,deepseek     # comma-separated fallback order

# Behavior
AGENT_PRE_SIGNAL_THRESHOLD=0.4              # StrategyWorker: publish pre-signal if score >= this
AGENT_PASSTHROUGH_ON_FAIL=true              # if all providers fail, forward signal anyway
AGENT_TIMEOUT_SECONDS=20

# API key pools — append _1 _2 _3 for multiple keys
GROQ_API_KEY_1=gsk_xxx
GROQ_API_KEY_2=gsk_yyy
GROQ_API_KEY_3=gsk_zzz
OPENROUTER_API_KEY_1=sk-or-xxx
DEEPSEEK_API_KEY_1=sk-xxx
GEMINI_API_KEY_1=AIzaSy-xxx
QWEN_API_KEY_1=sk-xxx
OPENAI_API_KEY_1=sk-xxx
ANTHROPIC_API_KEY_1=sk-ant-xxx
```

## Mandatory Rules

1. **Agent never places orders** — output is always approve/reject into `stream.signals`.
2. **Passthrough on failure** — `AGENT_PASSTHROUGH_ON_FAIL=true` is the safe default. Never block trading because LLM is down.
3. **API keys via env var only** — same rule as exchange keys, never store in Redis or DB.
4. **Decimal for refined SL/TP** — if agent returns refined prices, they must be Decimal strings, never float.
5. **Key pool state in Redis only** — `llm.pool.*` keys are ephemeral. If Redis restarts, pool resets gracefully (counters start at 0).
6. **Do not call LLM if position already open on symbol** — `AgentConfirmer` checks `state.position.{symbol}` before calling LLM; if position exists, discard pre-signal immediately.
7. **One concurrent LLM call per symbol** — use `asyncio.Lock` per symbol in `AgentConfirmer`, same pattern as `OrderExecutor`.
