# Key Pool Manager

Per-provider API key rotation with cooldown tracking and daily limit enforcement.
State is stored in Redis so it persists across restarts and is shared if multiple
processes run (though `AgentConfirmer` is single-process by design).

---

## Implementation

```python
# bot_engine/components/agent/key_pool.py
from __future__ import annotations
import time
import asyncio
from dataclasses import dataclass
from loguru import logger
from redis.asyncio import Redis

from .providers import APIKey


@dataclass
class KeySlot:
    idx: int
    api_key: APIKey


class KeyPoolManager:
    """
    Round-robin key rotation for a single provider.
    Skips keys that are in cooldown or have exceeded daily_limit.
    State (cooldown, counters) lives in Redis — ephemeral, resets on restart.
    """

    def __init__(self, redis: Redis, provider: str, keys: list[APIKey]):
        if not keys:
            raise ValueError(f"KeyPoolManager: no keys provided for provider '{provider}'")
        self.redis = redis
        self.provider = provider
        self.keys = keys
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    # Redis key helpers
    # ------------------------------------------------------------------
    def _prefix(self, idx: int) -> str:
        return f"llm.pool.{self.provider}.{idx}"

    async def _get_rotation_idx(self) -> int:
        val = await self.redis.get(f"llm.pool.{self.provider}.rotation_idx")
        return int(val) if val else 0

    async def _set_rotation_idx(self, idx: int) -> None:
        await self.redis.set(f"llm.pool.{self.provider}.rotation_idx", idx)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------
    async def acquire(self) -> KeySlot | None:
        """
        Return the next available key slot. Returns None if all keys are
        exhausted (all in cooldown or all hit daily_limit).
        """
        async with self._lock:
            start = await self._get_rotation_idx()
            n = len(self.keys)

            for offset in range(n):
                idx = (start + offset) % n
                key = self.keys[idx]
                prefix = self._prefix(idx)

                # Check cooldown
                cooldown_until = await self.redis.get(f"{prefix}.cooldown_until")
                if cooldown_until and float(cooldown_until) > time.time():
                    logger.debug(f"[key_pool] {self.provider}[{idx}] cooling down, skip")
                    continue

                # Check daily limit
                if key.daily_limit is not None:
                    requests_today = int(await self.redis.get(f"{prefix}.requests_today") or 0)
                    if requests_today >= key.daily_limit:
                        logger.debug(f"[key_pool] {self.provider}[{idx}] daily limit hit, skip")
                        continue

                # Advance rotation pointer to next key
                await self._set_rotation_idx((idx + 1) % n)
                return KeySlot(idx=idx, api_key=key)

            logger.warning(f"[key_pool] {self.provider} all {n} key(s) exhausted")
            return None

    async def on_success(self, slot: KeySlot, tokens_used: int = 0) -> None:
        """Call after a successful LLM response."""
        prefix = self._prefix(slot.idx)
        pipe = self.redis.pipeline()
        pipe.incr(f"{prefix}.requests_today")
        pipe.expire(f"{prefix}.requests_today", 86400)
        if tokens_used > 0:
            pipe.incrby(f"{prefix}.tokens_today", tokens_used)
            pipe.expire(f"{prefix}.tokens_today", 86400)
        await pipe.execute()

    async def on_rate_limit(self, slot: KeySlot, retry_after: int = 60) -> None:
        """Call when the provider returns HTTP 429."""
        prefix = self._prefix(slot.idx)
        cooldown_until = time.time() + retry_after
        # TTL slightly longer than cooldown so the key exists when we check
        await self.redis.set(
            f"{prefix}.cooldown_until",
            cooldown_until,
            ex=retry_after + 30,
        )
        logger.warning(
            f"[key_pool] {self.provider}[{slot.idx}] rate limited, "
            f"cooldown {retry_after}s"
        )

    async def on_error(self, slot: KeySlot, cooldown_seconds: int = 30) -> None:
        """Call on generic HTTP error (5xx, timeout). Short cooldown."""
        await self.on_rate_limit(slot, retry_after=cooldown_seconds)

    async def stats(self) -> list[dict]:
        """Return current usage stats for all keys (for monitoring/debug)."""
        result = []
        now = time.time()
        for idx, key in enumerate(self.keys):
            prefix = self._prefix(idx)
            cooldown_until = await self.redis.get(f"{prefix}.cooldown_until")
            requests_today = int(await self.redis.get(f"{prefix}.requests_today") or 0)
            tokens_today = int(await self.redis.get(f"{prefix}.tokens_today") or 0)
            result.append({
                "provider": self.provider,
                "idx": idx,
                "key_suffix": f"...{key.key[-4:]}",
                "requests_today": requests_today,
                "tokens_today": tokens_today,
                "cooling_down": bool(cooldown_until and float(cooldown_until) > now),
                "cooldown_remaining": (
                    max(0, float(cooldown_until) - now) if cooldown_until else 0
                ),
            })
        return result
```

---

## Redis State Schema

```
llm.pool.{provider}.rotation_idx           int — current round-robin pointer
llm.pool.{provider}.{idx}.requests_today   int counter (TTL 86400s — auto daily reset)
llm.pool.{provider}.{idx}.tokens_today     int counter (TTL 86400s)
llm.pool.{provider}.{idx}.cooldown_until   float unix ts (TTL = retry_after + 30s)
```

**Daily reset:** Both `requests_today` and `tokens_today` use `EXPIRE 86400` on every
`INCR`. Redis handles the reset automatically — no cron required.

**Cooldown:** Set via `SET ... EX` when a 429 or error is received. Key disappears
automatically when cooldown expires, so the next `acquire()` sees no cooldown.

---

## ProviderRouter

Wraps multiple `KeyPoolManager` instances and implements the fallback chain.

```python
# bot_engine/components/agent/key_pool.py  (continued)
from .providers import AgentConfig, build_client, PROVIDER_REGISTRY, LLMResponse


class ProviderRouter:
    """
    Tries the primary provider's key pool first.
    On exhaustion, falls back through agent_config.agent_fallback_chain.
    """

    def __init__(self, redis: Redis, agent_config: AgentConfig):
        self._config = agent_config
        self._pools: dict[str, KeyPoolManager] = {}

        all_providers = [agent_config.agent_provider] + agent_config.agent_fallback_chain
        for provider in all_providers:
            keys = agent_config.build_api_keys(provider)
            if keys:
                self._pools[provider] = KeyPoolManager(redis, provider, keys)
            else:
                logger.warning(f"[provider_router] no keys configured for '{provider}', skipping")

    async def call(
        self,
        messages: list[dict],
        tools: list[dict],
        tool_choice: str = "required",
    ) -> LLMResponse | None:
        """
        Try providers in order. Returns the first successful LLMResponse.
        Returns None only if all providers are exhausted AND passthrough_on_fail=False.
        """
        chain = [self._config.agent_provider] + self._config.agent_fallback_chain

        for provider in chain:
            pool = self._pools.get(provider)
            if pool is None:
                continue

            slot = await pool.acquire()
            if slot is None:
                logger.warning(f"[provider_router] {provider} all keys exhausted, trying next")
                continue

            client = build_client(provider, slot.api_key.key, self._config)
            try:
                response = await asyncio.wait_for(
                    client.chat(messages, tools, tool_choice),
                    timeout=self._config.agent_timeout_seconds,
                )
                await pool.on_success(slot, response.tokens_used)
                logger.debug(
                    f"[provider_router] {provider}[{slot.idx}] ok, "
                    f"tokens={response.tokens_used}"
                )
                return response

            except httpx.HTTPStatusError as e:
                if e.response.status_code == 429:
                    retry_after = int(e.response.headers.get("retry-after", 60))
                    await pool.on_rate_limit(slot, retry_after)
                    logger.warning(f"[provider_router] {provider}[{slot.idx}] 429, retry_after={retry_after}s")
                    # Don't break — try next key in same provider next iteration
                    # by calling acquire() again, but we already advanced rotation_idx
                    # so next call will pick next key
                    continue
                else:
                    await pool.on_error(slot)
                    logger.error(f"[provider_router] {provider}[{slot.idx}] HTTP {e.response.status_code}")
                    continue

            except asyncio.TimeoutError:
                await pool.on_error(slot, cooldown_seconds=15)
                logger.warning(f"[provider_router] {provider}[{slot.idx}] timeout")
                continue

            except Exception as e:
                await pool.on_error(slot)
                logger.error(f"[provider_router] {provider}[{slot.idx}] error: {e}")
                continue

        logger.error("[provider_router] all providers exhausted")
        return None
```

---

## Usage Pattern

```python
# In AgentConfirmer.__init__:
self._router = ProviderRouter(redis=redis, agent_config=agent_config)

# In AgentConfirmer._confirm():
response = await self._router.call(
    messages=build_messages(pre_signal),
    tools=CONFIRMER_TOOLS,
    tool_choice="required",
)
if response is None:
    # All providers failed — apply passthrough rule
    return passthrough_decision(pre_signal)
```
