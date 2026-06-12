# KeyPoolManager — Multi-Provider Key Pool

Uses **litellm** as the unified interface. Each sub-agent has **one provider** and
**3–5 API keys** that rotate deterministically across tokens.

**Engine will not start** if any agent's key count is outside 3–5.

---

## Key Rotation per Sub-Agent

Each sub-agent rotates independently through its own key pool:

```
token_index % len(keys)  →  key assignment
```

Example with 3 keys and 15 tokens (one sub-agent):

| Token | token_index | Key used |
|---|---|---|
| Token A | 0 | Key 1 |
| Token B | 1 | Key 2 |
| Token C | 2 | Key 3 |
| Token D | 3 | Key 1 ← wrap |
| Token E | 4 | Key 2 |
| ... | ... | ... |
| Token O | 14 | Key 3 |

All 4 sub-agents run the same rotation pattern concurrently but independently.
With 3 keys and 15 tokens: **5 tokens per key per agent**, 60 total LLM calls per batch.

---

## Implementation

```python
# solana_bot/components/key_pool.py

from __future__ import annotations

import os
from dataclasses import dataclass

from solana_bot.config import Settings


# ── Constants ──────────────────────────────────────────────────────────────────

MIN_KEYS_PER_AGENT = 3
MAX_KEYS_PER_AGENT = 5

DEFAULT_AGENT_MODELS: dict[str, str] = {
    "market": "groq/llama-3.1-8b-instant",
    "safety": "groq/llama-3.1-8b-instant",
    "risk":   "groq/llama-3.1-8b-instant",
    "social": "gemini/gemini-2.0-flash",
}

# Env var names for API keys per provider (comma-separated)
PROVIDER_KEY_ENV: dict[str, str] = {
    "groq":       "GROQ_API_KEYS",
    "gemini":     "GEMINI_API_KEYS",
    "openrouter": "OPENROUTER_API_KEYS",
    "anthropic":  "ANTHROPIC_API_KEYS",
    "openai":     "OPENAI_API_KEYS",
}


# ── Types ──────────────────────────────────────────────────────────────────────

@dataclass
class ProviderKey:
    model:   str    # litellm model string, e.g. "groq/llama-3.1-8b-instant"
    api_key: str    # provider-specific API key


# ── Manager ────────────────────────────────────────────────────────────────────

class KeyPoolManager:
    """
    Manages one provider + 3–5 API keys per sub-agent.

    Validates ALL agents at __init__ time.
    Engine will not start if any agent has < MIN_KEYS_PER_AGENT or > MAX_KEYS_PER_AGENT.
    If > MAX_KEYS_PER_AGENT are supplied, excess keys are silently truncated to MAX.

    Config priority: env var → settings field (plural) → settings field (singular).

    Required env vars (3–5 comma-separated keys each):
        GROQ_API_KEYS=gsk_1,gsk_2,gsk_3          # for market, safety, risk agents
        GEMINI_API_KEYS=AIza_1,AIza_2,AIza_3      # for social agent

    Optional model overrides:
        AGENT_MARKET_MODEL=groq/llama-3.1-8b-instant
        AGENT_SAFETY_MODEL=groq/llama-3.1-8b-instant
        AGENT_RISK_MODEL=groq/llama-3.1-8b-instant
        AGENT_SOCIAL_MODEL=gemini/gemini-2.0-flash
    """

    def __init__(self, settings: Settings) -> None:
        # Step 1 — resolve model per agent
        self._agent_models: dict[str, str] = {
            name: (
                os.environ.get(f"AGENT_{name.upper()}_MODEL")
                or getattr(settings, f"agent_{name}_model", None)
                or default
            )
            for name, default in DEFAULT_AGENT_MODELS.items()
        }

        # Step 2 — resolve raw key list per provider
        raw_provider_keys: dict[str, list[str]] = {}
        for provider, env_var in PROVIDER_KEY_ENV.items():
            raw = (
                os.environ.get(env_var, "")
                or getattr(settings, f"{provider}_api_keys", "")
                or getattr(settings, f"{provider}_api_key",  "")
            )
            keys = [k.strip() for k in raw.split(",") if k.strip()]
            if keys:
                raw_provider_keys[provider] = keys

        # Step 3 — validate all agents at startup (fail fast)
        errors: list[str] = []
        for agent_name in DEFAULT_AGENT_MODELS:
            model    = self._agent_models[agent_name]
            provider = model.split("/")[0]
            keys     = raw_provider_keys.get(provider, [])
            count    = len(keys)
            env_var  = PROVIDER_KEY_ENV.get(provider, provider.upper() + "_API_KEYS")

            if count < MIN_KEYS_PER_AGENT:
                errors.append(
                    f"  [{agent_name}] provider='{provider}' → "
                    f"got {count} key(s), need {MIN_KEYS_PER_AGENT}–{MAX_KEYS_PER_AGENT}. "
                    f"Set {env_var} with {MIN_KEYS_PER_AGENT}–{MAX_KEYS_PER_AGENT} "
                    f"comma-separated keys."
                )
            elif count > MAX_KEYS_PER_AGENT:
                # Silently truncate — too many keys is not dangerous
                raw_provider_keys[provider] = keys[:MAX_KEYS_PER_AGENT]

        if errors:
            raise ValueError(
                "KeyPoolManager: engine cannot start — insufficient API keys:\n"
                + "\n".join(errors)
            )

        # Step 4 — store validated key pools
        self._provider_keys: dict[str, list[str]] = raw_provider_keys

    def keys_for_agent(self, agent_name: str) -> list[ProviderKey]:
        """
        Return validated ProviderKey list for the agent (3–5 entries).
        Always succeeds — validation already ran at __init__.
        """
        model    = self._agent_models[agent_name]
        provider = model.split("/")[0]
        return [
            ProviderKey(model=model, api_key=k)
            for k in self._provider_keys[provider]
        ]

    def model_for_agent(self, agent_name: str) -> str:
        return self._agent_models[agent_name]
```

---

## Supported Providers

| Provider | Free tier | Example model string |
|---|---|---|
| **Groq** | ✅ 14,400 req/day | `groq/llama-3.1-8b-instant` |
| **Groq** | ✅ | `groq/gemma2-9b-it` |
| **Gemini** | ✅ 1M tokens/day | `gemini/gemini-2.0-flash` |
| **Gemini** | ✅ | `gemini/gemini-1.5-flash` |
| **OpenRouter** | ✅ (`:free` models) | `openrouter/meta-llama/llama-3.1-8b-instruct:free` |
| **Anthropic** | ❌ Paid | `anthropic/claude-haiku-4-5-20251001` |
| **OpenAI** | ❌ Paid | `openai/gpt-4o-mini` |

---

## .env (wajib diisi sebelum engine bisa jalan)

```bash
# WAJIB: 3–5 keys per provider
# market, safety, risk → pakai Groq
GROQ_API_KEYS=gsk_xxxx1,gsk_xxxx2,gsk_xxxx3

# social → pakai Gemini
GEMINI_API_KEYS=AIzaSy_xxxx1,AIzaSy_xxxx2,AIzaSy_xxxx3

# Optional: override model per agent
AGENT_MARKET_MODEL=groq/llama-3.1-8b-instant
AGENT_SAFETY_MODEL=groq/llama-3.1-8b-instant
AGENT_RISK_MODEL=groq/llama-3.1-8b-instant
AGENT_SOCIAL_MODEL=gemini/gemini-2.0-flash
```

Jika kurang dari 3 keys, engine langsung error saat startup:

```
KeyPoolManager: engine cannot start — insufficient API keys:
  [market] provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
  [safety] provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
  [risk]   provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
```

---

## Settings Fields (pydantic-settings)

```python
# Model per agent — env var overrides these
agent_market_model: str = "groq/llama-3.1-8b-instant"
agent_safety_model: str = "groq/llama-3.1-8b-instant"
agent_risk_model:   str = "groq/llama-3.1-8b-instant"
agent_social_model: str = "gemini/gemini-2.0-flash"

# API keys per provider (3–5 comma-separated, wajib)
groq_api_keys:       str = ""   # for market, safety, risk
gemini_api_keys:     str = ""   # for social
openrouter_api_keys: str = ""   # optional alternative
anthropic_api_keys:  str = ""   # optional alternative
```
