# SignalAggregator — Full Implementation

```python
# solana_bot/components/signal_aggregator.py

from __future__ import annotations

import asyncio
import json
import time
import uuid
from typing import Optional

from loguru import logger

from solana_bot.config import Settings


class SignalAggregator:
    """
    GATE 1: aggregates per-token strategy signals and forwards the top-N
    candidates to the Orchestrator Agent via stream.agent.eligible.

    Reads:   stream.signals          (consumer group: aggregator-group)
    Writes:  signal.match.{mint}     (HASH  — match tracking)
             agent.queue             (ZSET  — ranked candidates)
             stream.agent.eligible   (STREAM — dispatch trigger)
    """

    STREAM_IN  = "stream.signals"
    STREAM_OUT = "stream.agent.eligible"
    GROUP      = "aggregator-group"
    CONSUMER   = "signal-aggregator-1"

    MATCH_KEY_PREFIX = "signal.match."
    QUEUE_KEY        = "agent.queue"
    MATCH_MASTER_TTL = 900  # longest strategy window

    # Gate thresholds — override via Settings
    MIN_STRATEGY_MATCH: int = 2
    MAX_AGENT_QUEUE:    int = 15

    # Per-strategy staleness windows (seconds)
    STRATEGY_WINDOWS: dict[str, int] = {
        "new_launch_snipe":        60,
        "kol_copy_trade":         120,
        "momentum_spike":         120,
        "graduation_trade":       300,
        "social_alpha":           300,
        "smart_money_confluence": 900,
    }

    # Composite score: weight bonus per strategy
    STRATEGY_WEIGHTS: dict[str, int] = {
        "smart_money_confluence": 20,
        "kol_copy_trade":         15,
        "graduation_trade":       15,
        "new_launch_snipe":       12,
        "momentum_spike":         10,
        "social_alpha":            8,
    }

    # Circuit breaker keys (written by RiskManager, read-only here)
    CB_STATE_KEY      = "state.circuit_breaker"
    CB_DAILY_LOSS_KEY = "state.daily_loss_pct"
    CB_POSITIONS_KEY  = "state.open_positions_count"

    def __init__(self, redis, settings: Settings) -> None:
        self.redis    = redis
        self.settings = settings
        self._log     = logger.bind(component="signal_aggregator")

        self.MIN_STRATEGY_MATCH = getattr(settings, "gate1_min_strategy_match", self.MIN_STRATEGY_MATCH)
        self.MAX_AGENT_QUEUE    = getattr(settings, "gate1_max_agent_queue",    self.MAX_AGENT_QUEUE)

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        await self._ensure_consumer_group()
        self._log.info(
            "SignalAggregator started — reading {}, max_queue={}",
            self.STREAM_IN, self.MAX_AGENT_QUEUE,
        )

        while True:
            try:
                entries = await self.redis.xreadgroup(
                    groupname=self.GROUP,
                    consumername=self.CONSUMER,
                    streams={self.STREAM_IN: ">"},
                    count=50,
                    block=5000,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log.warning("xreadgroup error: {}", exc)
                await asyncio.sleep(1)
                continue

            if not entries:
                await self._heartbeat()
                continue

            for _stream, messages in entries:
                for msg_id, payload in messages:
                    try:
                        await self._process_signal(payload)
                        await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)
                    except Exception as exc:
                        self._log.warning("signal processing error ({}): {}", msg_id, exc)

            await self._try_dispatch()

    # ------------------------------------------------------------------
    # Signal processing
    # ------------------------------------------------------------------

    async def _process_signal(self, payload: dict) -> None:
        mint          = payload.get(b"mint", b"").decode()
        strategy_name = payload.get(b"strategy_name", b"").decode()

        if not mint or not strategy_name:
            return

        await self._record_match(mint, strategy_name)

    async def _record_match(self, mint: str, strategy_name: str) -> None:
        key = self.MATCH_KEY_PREFIX + mint
        now = int(time.time())

        pipe = self.redis.pipeline()
        pipe.hset(key, strategy_name, now)
        pipe.expire(key, self.MATCH_MASTER_TTL)
        await pipe.execute()

    # ------------------------------------------------------------------
    # Dispatch — called after each read batch
    # ------------------------------------------------------------------

    async def _try_dispatch(self) -> None:
        if await self._circuit_breaker_open():
            self._log.info("circuit breaker open — skipping dispatch")
            return

        # Score all tokens that currently have matches stored
        await self._rebuild_queue()

        queue_size = await self.redis.zcard(self.QUEUE_KEY)
        if queue_size == 0:
            return

        take = min(queue_size, self.MAX_AGENT_QUEUE)
        # ZREVRANGE: highest score first
        top_mints = await self.redis.zrevrange(self.QUEUE_KEY, 0, take - 1)
        mints = [m.decode() if isinstance(m, bytes) else m for m in top_mints]

        batch_id = str(uuid.uuid4())
        await self.redis.xadd(
            self.STREAM_OUT,
            {"batch_id": batch_id, "mints": json.dumps(mints)},
        )
        self._log.info("dispatched {} tokens to orchestrator (batch {})", len(mints), batch_id)

        # Clear queue so stale candidates do not carry over
        await self.redis.delete(self.QUEUE_KEY)

    async def _rebuild_queue(self) -> None:
        """
        Scan all signal.match.* keys, compute composite score for each token
        that passes Rule 1, and rebuild agent.queue sorted set from scratch.
        """
        pattern = self.MATCH_KEY_PREFIX + "*"

        # Always start fresh — prevents stale entries from cycles where
        # dispatch was skipped (e.g. circuit breaker was open).
        await self.redis.delete(self.QUEUE_KEY)
        pipe = self.redis.pipeline()

        async for key in self.redis.scan_iter(pattern):
            mint = key.decode().removeprefix(self.MATCH_KEY_PREFIX)
            valid = await self._get_valid_matches(mint)

            if len(valid) < self.MIN_STRATEGY_MATCH:
                continue

            score = self._compute_score(mint, valid)
            pipe.zadd(self.QUEUE_KEY, {mint: score})

        await pipe.execute()

    # ------------------------------------------------------------------
    # Match validity
    # ------------------------------------------------------------------

    async def _get_valid_matches(self, mint: str) -> list[str]:
        """Return strategy names whose signal is still within their window."""
        key  = self.MATCH_KEY_PREFIX + mint
        now  = int(time.time())
        raw  = await self.redis.hgetall(key)

        valid = []
        for strategy_bytes, ts_bytes in raw.items():
            strategy = strategy_bytes.decode() if isinstance(strategy_bytes, bytes) else strategy_bytes
            ts       = int(ts_bytes.decode()   if isinstance(ts_bytes, bytes)       else ts_bytes)
            window   = self.STRATEGY_WINDOWS.get(strategy, 300)

            if (now - ts) <= window:
                valid.append(strategy)

        return valid

    # ------------------------------------------------------------------
    # Composite score
    # ------------------------------------------------------------------

    def _compute_score(self, mint: str, matched_strategies: list[str]) -> float:
        match_score = len(matched_strategies) * 30

        weight_bonus = max(
            (self.STRATEGY_WEIGHTS.get(s, 0) for s in matched_strategies),
            default=0,
        )

        # Recency bonus: not per-mint here — approximated from match count freshness.
        # Full recency requires storing first_seen timestamp separately (optional extension).
        recency_bonus = min(len(matched_strategies) * 2, 10)

        return float(match_score + weight_bonus + recency_bonus)

    # ------------------------------------------------------------------
    # Circuit breaker
    # ------------------------------------------------------------------

    async def _circuit_breaker_open(self) -> bool:
        try:
            pipe = self.redis.pipeline()
            pipe.get(self.CB_STATE_KEY)
            pipe.get(self.CB_DAILY_LOSS_KEY)
            pipe.get(self.CB_POSITIONS_KEY)
            cb_state, daily_loss_raw, positions_raw = await pipe.execute()

            if cb_state and cb_state.decode() == "open":
                return True

            daily_loss_limit = getattr(self.settings, "daily_loss_limit_pct", 5.0)
            max_positions    = getattr(self.settings, "max_open_positions",    10)

            if daily_loss_raw:
                if float(daily_loss_raw.decode()) >= daily_loss_limit:
                    return True

            if positions_raw:
                if int(positions_raw.decode()) >= max_positions:
                    return True

        except Exception as exc:
            # Key missing or Redis error → treat as closed (fail-safe: assume safe)
            self._log.debug("circuit breaker read error (treating closed): {}", exc)

        return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _ensure_consumer_group(self) -> None:
        try:
            await self.redis.xgroup_create(self.STREAM_IN, self.GROUP, id="$", mkstream=True)
        except Exception:
            pass  # group already exists

    async def _heartbeat(self) -> None:
        self._log.debug("SignalAggregator idle — no new signals")
```

---

## Wiring into Bot Engine

```python
# solana_bot/engine.py  (add alongside existing components)

from solana_bot.components.signal_aggregator import SignalAggregator

aggregator = SignalAggregator(redis=redis_pool, settings=settings)
tasks = [
    asyncio.create_task(scanner.run(),    name="scanner"),
    asyncio.create_task(strategy.run(),   name="strategy"),
    asyncio.create_task(aggregator.run(), name="signal_aggregator"),  # ← add here
    asyncio.create_task(orchestrator.run(), name="orchestrator"),
    # ... rest of components
]
```

---

## Settings Fields

Add to `Settings` (pydantic-settings):

```python
gate1_min_strategy_match: int   = 2     # Rule 1: minimum strategy match count
gate1_max_agent_queue:    int   = 15    # Rule 2: max tokens dispatched per batch
daily_loss_limit_pct:     float = 5.0   # Rule 3: circuit breaker threshold
max_open_positions:       int   = 10    # Rule 3: position count ceiling
```

---

## Strategy Signal Payload Contract

Every strategy must include `strategy_name` when publishing to `stream.signals`:

```python
await redis.xadd("stream.signals", {
    "mint":          token.mint,
    "strategy_name": "kol_copy_trade",   # ← required by SignalAggregator
    "confidence":    str(confidence),
    "action":        "BUY",
    # ... other fields
})
```

---

## Redis Key Reference

| Key | Type | TTL | Written by | Read by |
|---|---|---|---|---|
| `signal.match.{mint}` | HASH | 900 s | SignalAggregator | SignalAggregator |
| `agent.queue` | ZSET | cleared after dispatch | SignalAggregator | SignalAggregator |
| `stream.signals` | STREAM | — | Strategy | SignalAggregator |
| `stream.agent.eligible` | STREAM | — | SignalAggregator | Orchestrator Agent |
| `state.circuit_breaker` | STRING | — | RiskManager | SignalAggregator (read-only) |
| `state.daily_loss_pct` | STRING | — | RiskManager | SignalAggregator (read-only) |
| `state.open_positions_count` | STRING | — | RiskManager | SignalAggregator (read-only) |
