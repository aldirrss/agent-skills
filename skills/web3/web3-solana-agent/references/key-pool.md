# KeyPoolManager — Multi-Provider Fallback Chain

Uses **litellm** as the unified interface. Each sub-agent has a **primary provider**
plus an **ordered fallback chain** (Provider A → B → C). If the primary provider is
exhausted or fails, the next provider in the chain is tried automatically.

**Engine will not start** if any agent's primary provider has < 3 keys.
Fallback providers are optional — they are skipped if no keys are configured.

---

## Provider Chain per Agent

```
market: Groq (primary) → OpenRouter → Gemini
safety: Groq (primary) → OpenRouter → Gemini
risk:   Groq (primary) → OpenRouter → Gemini
social: Gemini (primary) → Groq → OpenRouter
```

Within each provider, keys rotate deterministically:

```
token_index % len(keys)  →  key assignment
```

Example: 3 Groq keys, 15 tokens → Token 1→Key1, Token 2→Key2, Token 3→Key3, Token 4→Key1, ...

---

## Implementation

```python
# solana_bot/components/key_pool.py

from __future__ import annotations

import os
from dataclasses import dataclass

from solana_bot.config import Settings


# ── Constants ──────────────────────────────────────────────────────────────────

MIN_KEYS_PER_PROVIDER = 3
MAX_KEYS_PER_PROVIDER = 5

# First entry = primary, rest = fallbacks in order
DEFAULT_AGENT_PROVIDER_CHAIN: dict[str, list[str]] = {
    "market": ["groq", "openrouter", "gemini"],
    "safety": ["groq", "openrouter", "gemini"],
    "risk":   ["groq", "openrouter", "gemini"],
    "social": ["gemini", "groq", "openrouter"],
}

# Default litellm model string per agent per provider
DEFAULT_AGENT_MODELS: dict[str, dict[str, str]] = {
    "market": {
        "groq":       "groq/llama-3.1-8b-instant",
        "openrouter": "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        "gemini":     "gemini/gemini-2.0-flash",
    },
    "safety": {
        "groq":       "groq/llama-3.1-8b-instant",
        "openrouter": "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        "gemini":     "gemini/gemini-2.0-flash",
    },
    "risk": {
        "groq":       "groq/llama-3.1-8b-instant",
        "openrouter": "openrouter/meta-llama/llama-3.1-8b-instruct:free",
        "gemini":     "gemini/gemini-2.0-flash",
    },
    "social": {
        "gemini":     "gemini/gemini-2.0-flash",
        "groq":       "groq/llama-3.1-8b-instant",
        "openrouter": "openrouter/meta-llama/llama-3.1-8b-instruct:free",
    },
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
    provider: str   # e.g. "groq"
    model:    str   # litellm model string, e.g. "groq/llama-3.1-8b-instant"
    api_key:  str   # provider-specific API key


# ── Manager ────────────────────────────────────────────────────────────────────

class KeyPoolManager:
    """
    Manages multi-provider fallback chains per sub-agent.

    Each agent has a primary provider + ordered optional fallback providers.
    Engine will not start if the PRIMARY provider has < MIN_KEYS_PER_PROVIDER keys.
    Fallback providers are silently skipped when no keys are configured.

    Required (primary providers, min 3 keys each):
        GROQ_API_KEYS=gsk_1,gsk_2,gsk_3         # primary for market, safety, risk
        GEMINI_API_KEYS=AIza_1,AIza_2,AIza_3    # primary for social

    Optional (fallback providers):
        OPENROUTER_API_KEYS=sk_or_1,sk_or_2,sk_or_3
        ANTHROPIC_API_KEYS=sk-ant-1,sk-ant-2,sk-ant-3
    """

    def __init__(self, settings: Settings) -> None:
        # Step 1 — resolve raw key list per provider
        self._provider_keys: dict[str, list[str]] = {}
        for provider, env_var in PROVIDER_KEY_ENV.items():
            raw = (
                os.environ.get(env_var, "")
                or getattr(settings, f"{provider}_api_keys", "")
                or getattr(settings, f"{provider}_api_key", "")
            )
            keys = [k.strip() for k in raw.split(",") if k.strip()]
            if keys:
                self._provider_keys[provider] = keys[:MAX_KEYS_PER_PROVIDER]

        # Step 2 — resolve model overrides per agent per provider
        self._agent_models: dict[str, dict[str, str]] = {}
        for agent_name, provider_defaults in DEFAULT_AGENT_MODELS.items():
            self._agent_models[agent_name] = {}
            for provider, default_model in provider_defaults.items():
                override = os.environ.get(
                    f"AGENT_{agent_name.upper()}_{provider.upper()}_MODEL"
                )
                self._agent_models[agent_name][provider] = override or default_model

        # Step 3 — validate primary provider for each agent (fail fast)
        errors: list[str] = []
        for agent_name, chain in DEFAULT_AGENT_PROVIDER_CHAIN.items():
            primary = chain[0]
            keys    = self._provider_keys.get(primary, [])
            count   = len(keys)
            env_var = PROVIDER_KEY_ENV.get(primary, primary.upper() + "_API_KEYS")

            if count < MIN_KEYS_PER_PROVIDER:
                errors.append(
                    f"  [{agent_name}] primary provider='{primary}' → "
                    f"got {count} key(s), need {MIN_KEYS_PER_PROVIDER}–{MAX_KEYS_PER_PROVIDER}. "
                    f"Set {env_var} with {MIN_KEYS_PER_PROVIDER}–{MAX_KEYS_PER_PROVIDER} "
                    f"comma-separated keys."
                )

        if errors:
            raise ValueError(
                "KeyPoolManager: engine cannot start — insufficient API keys:\n"
                + "\n".join(errors)
            )

    def provider_chain_for_agent(self, agent_name: str) -> list[list[ProviderKey]]:
        """
        Return key pools in fallback order for the agent.

        Each element is the full key list for one provider in the chain.
        Primary provider is index 0. Providers with no configured keys are omitted.

        Usage in BaseAgent:
            for provider_keys in key_pool.provider_chain_for_agent(self.name):
                key = provider_keys[token_index % len(provider_keys)]
                try:
                    return await call_llm(key)
                except ProviderError:
                    continue  # try next provider in chain
            raise RuntimeError("all providers exhausted")
        """
        chain  = DEFAULT_AGENT_PROVIDER_CHAIN.get(agent_name, ["groq"])
        result: list[list[ProviderKey]] = []
        for provider in chain:
            keys = self._provider_keys.get(provider, [])
            if not keys:
                continue  # fallback not configured — skip
            model = self._agent_models[agent_name][provider]
            result.append([
                ProviderKey(provider=provider, model=model, api_key=k)
                for k in keys
            ])
        return result

    def primary_key_for_agent(self, agent_name: str, token_index: int) -> ProviderKey:
        """
        Return a single key from the primary provider for this agent and token.
        Deterministic: same token_index always picks the same key.
        Always succeeds — primary provider validated at __init__.
        """
        primary = DEFAULT_AGENT_PROVIDER_CHAIN[agent_name][0]
        keys    = self._provider_keys[primary]
        model   = self._agent_models[agent_name][primary]
        return ProviderKey(provider=primary, model=model, api_key=keys[token_index % len(keys)])
```

---

## Fallback Behavior in BaseAgent

```python
async def score_with_fallback(
    self,
    key_pool: KeyPoolManager,
    token_index: int,
    prompt: str,
    timeout_s: float,
) -> int:
    """
    Try primary provider first, fall back to next providers on error.
    Returns score 0–100. Returns 50 (neutral) if all providers fail.
    """
    for provider_keys in key_pool.provider_chain_for_agent(self.name):
        key = provider_keys[token_index % len(provider_keys)]
        try:
            response = await asyncio.wait_for(
                litellm.acompletion(
                    model=key.model,
                    messages=[{"role": "user", "content": prompt}],
                    api_key=key.api_key,
                    max_tokens=100,
                ),
                timeout=timeout_s,
            )
            return parse_score(response.choices[0].message.content)
        except asyncio.TimeoutError:
            self.log.warning(f"[{self.name}] provider={key.provider} timeout — trying fallback")
        except Exception as e:
            self.log.warning(f"[{self.name}] provider={key.provider} error={e!r} — trying fallback")
    self.log.error(f"[{self.name}] all providers exhausted — returning neutral score 50")
    return 50  # fail-open
```

---

## Supported Providers

| Provider | Free tier | Example model string |
|---|---|---|
| **Groq** | ✅ 14,400 req/day | `groq/llama-3.1-8b-instant` |
| **Gemini** | ✅ 1M tokens/day | `gemini/gemini-2.0-flash` |
| **OpenRouter** | ✅ (`:free` models) | `openrouter/meta-llama/llama-3.1-8b-instruct:free` |
| **Anthropic** | ❌ Paid | `anthropic/claude-haiku-4-5-20251001` |
| **OpenAI** | ❌ Paid | `openai/gpt-4o-mini` |

---

## .env (wajib primary, optional fallback)

```bash
# WAJIB: primary providers (min 3 keys)
GROQ_API_KEYS=gsk_xxxx1,gsk_xxxx2,gsk_xxxx3       # market / safety / risk primary
GEMINI_API_KEYS=AIzaSy_1,AIzaSy_2,AIzaSy_3        # social primary

# OPSIONAL: fallback providers (dipakai jika primary gagal)
OPENROUTER_API_KEYS=sk-or-1,sk-or-2,sk-or-3

# OPSIONAL: override model per agent per provider
# AGENT_MARKET_GROQ_MODEL=groq/llama-3.1-8b-instant
# AGENT_SOCIAL_GEMINI_MODEL=gemini/gemini-2.0-flash
```

Jika primary provider < 3 keys, engine langsung error saat startup:

```
KeyPoolManager: engine cannot start — insufficient API keys:
  [market] primary provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
  [safety] primary provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
  [risk]   primary provider='groq' → got 1 key(s), need 3–5. Set GROQ_API_KEYS with 3–5 comma-separated keys.
```

---

## Settings Fields (pydantic-settings)

```python
# API keys per provider (3–5 comma-separated for primary providers)
groq_api_keys:       str = ""   # primary: market, safety, risk
gemini_api_keys:     str = ""   # primary: social
openrouter_api_keys: str = ""   # fallback (optional)
anthropic_api_keys:  str = ""   # fallback (optional)
openai_api_keys:     str = ""   # fallback (optional)
```
