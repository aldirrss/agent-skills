# AgentConfirmer

Full implementation of the `AgentConfirmer` component. Reads `stream.signals.raw`,
calls Claude for BUY signals, adjusts confidence, re-publishes to `stream.signals`.

---

## Component File

```python
# solana_bot/components/agent/confirmer.py

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from typing import Optional

import anthropic
from loguru import logger

from solana_bot.config import Settings


class AgentConfirmer:
    """
    Optional LLM enrichment layer between Strategy and RiskManager.

    Reads stream.signals.raw (consumer group: agent-group).
    For BUY signals: calls Claude, adjusts confidence, publishes to stream.signals.
    For SELL signals: passes through immediately.
    On any failure: passes original signal through unchanged.
    """

    STREAM_IN  = "stream.signals.raw"
    STREAM_OUT = "stream.signals"
    GROUP      = "agent-group"
    CONSUMER   = "agent-confirmer-1"

    # Strategy-specific timeouts in seconds (total budget)
    TIMEOUTS: dict[str, float] = {
        "new_launch_snipe":       2.0,
        "kol_copy_trade":         5.0,
        "graduation_trade":       8.0,
        "momentum_spike":         5.0,
        "smart_money_confluence": 8.0,
        "social_alpha":           8.0,
    }
    DEFAULT_TIMEOUT = 8.0

    def __init__(self, redis, settings: Settings) -> None:
        self.redis    = redis
        self.settings = settings
        self.client   = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
        self._log     = logger.bind(component="agent_confirmer")

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main consumer loop. Runs until cancelled."""
        self._log.info("AgentConfirmer started — reading {}", self.STREAM_IN)
        while True:
            try:
                entries = await self.redis.xreadgroup(
                    groupname=self.GROUP,
                    consumername=self.CONSUMER,
                    streams={self.STREAM_IN: ">"},
                    count=10,
                    block=1000,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log.warning("xreadgroup error: {}", exc)
                await asyncio.sleep(1)
                continue

            if not entries:
                continue

            for stream_name, messages in entries:
                for msg_id, fields in messages:
                    await self._handle_message(msg_id, fields)

    # ------------------------------------------------------------------
    # Per-message handling
    # ------------------------------------------------------------------

    async def _handle_message(self, msg_id: bytes, fields: dict) -> None:
        """Process one signal message. Always ACKs regardless of outcome."""
        signal = {k.decode(): v.decode() for k, v in fields.items()}
        mint     = signal.get("mint", "")
        side     = signal.get("side", "BUY").upper()
        strategy = signal.get("strategy", "")

        try:
            if side == "SELL":
                # SELL path — pass through immediately, no LLM call
                await self._publish(signal)
                self._log.debug("SELL passthrough mint={}", mint[:8])
            else:
                # BUY path — score with LLM
                enriched = await self._enrich_buy_signal(signal)
                await self._publish(enriched)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._log.warning("Error processing signal mint={}: {} — passing through", mint[:8], exc)
            await self._publish(signal)
        finally:
            await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)

    async def _enrich_buy_signal(self, signal: dict) -> dict:
        """
        Score the BUY signal with Claude.
        Returns signal with adjusted confidence (and llm_scored=true).
        On any error → returns original signal unchanged.
        """
        mint     = signal.get("mint", "")
        strategy = signal.get("strategy", "")
        timeout  = self.TIMEOUTS.get(strategy, self.DEFAULT_TIMEOUT)

        try:
            llm_score = await asyncio.wait_for(
                self._score_signal(signal),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            self._log.warning("LLM timeout after {}s for mint={}", timeout, mint[:8])
            return signal
        except Exception as exc:
            self._log.warning("LLM error for mint={}: {}", mint[:8], exc)
            return signal

        if llm_score is None:
            return signal

        # Blend: on-chain signals 70%, LLM 30%
        original_confidence = float(signal.get("confidence", "0.5"))
        final_confidence    = original_confidence * 0.7 + llm_score * 0.3

        enriched = dict(signal)
        enriched["confidence"] = f"{final_confidence:.4f}"
        enriched["llm_scored"] = "true"
        enriched["llm_score"]  = f"{llm_score:.4f}"

        self._log.info(
            "LLM scored mint={} strategy={} orig={:.3f} llm={:.3f} final={:.3f}",
            mint[:8], strategy, original_confidence, llm_score, final_confidence,
        )
        return enriched

    # ------------------------------------------------------------------
    # LLM scoring with caching
    # ------------------------------------------------------------------

    async def _score_signal(self, signal: dict) -> Optional[float]:
        """
        Score a BUY signal 0.0–1.0 using Claude.
        Checks llm.score.{mint} cache first (TTL 300s).
        Returns None on parse failure (caller treats as passthrough).
        """
        mint = signal.get("mint", "")

        # 1. Check per-mint cache
        cached = await self.redis.get(f"llm.score.{mint}")
        if cached:
            self._log.debug("Cache hit llm.score.{}", mint[:8])
            return float(cached)

        # 2. Check prompt-level cache (deduplicate identical prompts)
        prompt_hash = self._prompt_hash(signal)
        cached_resp = await self.redis.get(f"llm.cache.{prompt_hash}")
        if cached_resp:
            self._log.debug("Prompt cache hit hash={}", prompt_hash[:8])
            return self._parse_score(cached_resp)

        # 3. Call Claude
        from solana_bot.components.agent.prompts import build_system_prompt, build_user_prompt

        response = await self.client.messages.create(
            model=self.settings.agent_model,
            max_tokens=self.settings.agent_max_tokens,
            system=[
                {
                    "type": "text",
                    "text": build_system_prompt(),
                    "cache_control": {"type": "ephemeral"},  # cache stable system prompt
                }
            ],
            messages=[
                {"role": "user", "content": build_user_prompt(signal)}
            ],
        )

        raw_text = response.content[0].text if response.content else ""

        # 4. Store in prompt cache (TTL 600s)
        if raw_text:
            await self.redis.set(f"llm.cache.{prompt_hash}", raw_text, ex=600)

        score = self._parse_score(raw_text)

        # 5. Store per-mint cache (TTL 300s) if parse succeeded
        if score is not None:
            await self.redis.set(f"llm.score.{mint}", str(score), ex=300)

        return score

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _prompt_hash(self, signal: dict) -> str:
        """
        Stable hash for prompt deduplication.
        Buckets price_change_1h and liquidity to avoid cache misses on noise.
        """
        def bucket(val: str, step: float) -> str:
            try:
                return str(round(float(val) / step) * step)
            except (ValueError, TypeError):
                return val

        key = "|".join([
            signal.get("mint", ""),
            signal.get("strategy", ""),
            signal.get("sources", ""),
            bucket(signal.get("price_change_1h", "0"), 5.0),   # 5% buckets
            bucket(signal.get("liquidity_usdc", "0"), 10000),  # $10k buckets
        ])
        return hashlib.sha256(key.encode()).hexdigest()

    @staticmethod
    def _parse_score(raw: str) -> Optional[float]:
        """
        Parse {"score": 0.0-1.0, "reason": "..."} from LLM response.
        Returns None on any parse failure (triggers passthrough).
        """
        if not raw:
            return None
        try:
            # Handle LLM wrapping JSON in markdown code blocks
            text = raw.strip()
            if text.startswith("```"):
                lines = text.splitlines()
                text = "\n".join(
                    l for l in lines if not l.startswith("```")
                )
            data  = json.loads(text)
            score = float(data["score"])
            return max(0.0, min(1.0, score))   # clamp to [0, 1]
        except (json.JSONDecodeError, KeyError, ValueError, TypeError):
            return None

    async def _publish(self, signal: dict) -> None:
        """Publish signal to stream.signals."""
        await self.redis.xadd(self.STREAM_OUT, signal)
```

---

## Consumer Group Setup

Add to `ensure_consumer_groups()` in `main.py`. Only run when `AGENT_ENABLED=true`.

```python
async def ensure_consumer_groups(redis, settings: Settings) -> None:
    streams = [
        ("stream.signals",      "risk-group"),
        ("stream.swaps",        "execution-group"),
        ("stream.fills",        "tracker-group"),
        ("stream.commands",     "command-group"),
    ]
    if settings.agent_enabled:
        streams.append(("stream.signals.raw", "agent-group"))

    for stream, group in streams:
        try:
            await redis.xgroup_create(stream, group, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise
```

---

## Pending Message Recovery

On startup, drain any pending (unacknowledged) messages from previous runs.
Add this for `stream.signals.raw` alongside the existing stream recovery.

```python
async def drain_pending(redis, settings: Settings) -> None:
    """Re-process messages that were claimed but never ACKed."""
    if not settings.agent_enabled:
        return
    pending = await redis.xpending_range(
        "stream.signals.raw", "agent-group",
        min="-", max="+", count=100,
    )
    for entry in pending:
        msg_id = entry["message_id"]
        messages = await redis.xrange("stream.signals.raw", min=msg_id, max=msg_id)
        if messages:
            _, fields = messages[0]
            signal = {k.decode(): v.decode() for k, v in fields.items()}
            # Re-publish directly to stream.signals (skip LLM — startup recovery)
            await redis.xadd("stream.signals", signal)
        await redis.xack("stream.signals.raw", "agent-group", msg_id)
```
