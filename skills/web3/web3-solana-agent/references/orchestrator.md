# OrchestratorAgent — Full Implementation

```python
# solana_bot/components/orchestrator_agent.py

from __future__ import annotations

import asyncio
import json
from typing import Optional

from loguru import logger

from solana_bot.config import Settings
from solana_bot.components.agents.types      import AgentScore, TokenContext
from solana_bot.components.agents.market     import MarketAgent
from solana_bot.components.agents.safety     import SafetyAgent
from solana_bot.components.agents.risk       import RiskAgent
from solana_bot.components.agents.social     import SocialAgent
from solana_bot.components.key_pool          import KeyPoolManager, ProviderKey


class TokenResult:
    def __init__(
        self,
        mint:         str,
        final_score:  float,
        agent_scores: dict[str, AgentScore],
    ) -> None:
        self.mint         = mint
        self.final_score  = final_score
        self.agent_scores = agent_scores
        self.approved     = final_score >= OrchestratorAgent.APPROVAL_THRESHOLD


class OrchestratorAgent:
    """
    Reads stream.agent.eligible (batches from SignalAggregator).
    Dispatches each batch to 4 sub-agents in parallel.
    Aggregates scores and gates on >= APPROVAL_THRESHOLD.

    Input:  stream.agent.eligible
    Output: stream.agent.approved  (tokens that pass Gate 2)
    Cache:  llm.score.{mint}       (TTL 300 s — avoid duplicate scoring)
    """

    STREAM_IN  = "stream.agent.eligible"
    STREAM_OUT = "stream.agent.approved"
    GROUP      = "orchestrator-group"
    CONSUMER   = "orchestrator-1"

    SCORE_CACHE_PREFIX = "llm.score."
    SCORE_CACHE_TTL    = 300

    APPROVAL_THRESHOLD = 80.0
    NEUTRAL_SCORE      = 50.0

    AGENT_WEIGHTS = {
        "market": 0.25,
        "safety": 0.30,
        "risk":   0.25,
        "social": 0.20,
    }

    # Per-agent outer timeout (seconds) — wraps the entire batch, not per token
    AGENT_BATCH_TIMEOUTS = {
        "market": 30.0,
        "safety": 20.0,
        "risk":   30.0,
        "social": 50.0,
    }

    def __init__(self, redis, settings: Settings) -> None:
        self.redis    = redis
        self.settings = settings
        self._log     = logger.bind(component="orchestrator_agent")

        self.key_pool = KeyPoolManager(settings)
        self.agents: dict[str, object] = {
            "market": MarketAgent(settings),
            "safety": SafetyAgent(settings),
            "risk":   RiskAgent(settings),
            "social": SocialAgent(settings),
        }

    # ------------------------------------------------------------------
    # Main loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        await self._ensure_consumer_group()
        self._log.info("OrchestratorAgent started — reading {}", self.STREAM_IN)

        while True:
            try:
                entries = await self.redis.xreadgroup(
                    groupname=self.GROUP,
                    consumername=self.CONSUMER,
                    streams={self.STREAM_IN: ">"},
                    count=1,
                    block=5000,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._log.warning("xreadgroup error: {}", exc)
                await asyncio.sleep(1)
                continue

            if not entries:
                continue

            for _stream, messages in entries:
                for msg_id, payload in messages:
                    try:
                        await self._process_batch(payload)
                        await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)
                    except Exception as exc:
                        self._log.error("batch processing error ({}): {}", msg_id, exc)

    # ------------------------------------------------------------------
    # Batch processing
    # ------------------------------------------------------------------

    async def _process_batch(self, payload: dict) -> None:
        batch_id  = payload.get(b"batch_id", b"").decode()
        mints_raw = payload.get(b"mints", b"[]").decode()
        mints: list[str] = json.loads(mints_raw)

        if not mints:
            return

        self._log.info("processing batch {} — {} tokens", batch_id, len(mints))

        uncached, cached_results = await self._split_cached(mints)
        results: list[TokenResult] = list(cached_results)

        if uncached:
            contexts = await self._fetch_contexts(uncached)
            scored   = await self._score_batch(uncached, contexts)
            results.extend(scored)
            await self._cache_results(scored)

        approved = [r for r in results if r.approved]
        skipped  = [r for r in results if not r.approved]

        for r in skipped:
            self._log.info(
                "skip {} — score={:.1f} market={:.0f} safety={:.0f} risk={:.0f} social={:.0f}",
                r.mint, r.final_score,
                r.agent_scores["market"].score, r.agent_scores["safety"].score,
                r.agent_scores["risk"].score,   r.agent_scores["social"].score,
            )

        for r in approved:
            await self.redis.xadd(self.STREAM_OUT, {
                "mint":         r.mint,
                "final_score":  str(r.final_score),
                "market_score": str(r.agent_scores["market"].score),
                "safety_score": str(r.agent_scores["safety"].score),
                "risk_score":   str(r.agent_scores["risk"].score),
                "social_score": str(r.agent_scores["social"].score),
                "reasoning":    json.dumps({
                    k: v.reasoning for k, v in r.agent_scores.items()
                }),
                "batch_id":     batch_id,
            })
            self._log.info("approved {} — score={:.1f}", r.mint, r.final_score)

        self._log.info(
            "batch {} done — {}/{} approved", batch_id, len(approved), len(mints),
        )

    # ------------------------------------------------------------------
    # Parallel scoring
    # ------------------------------------------------------------------

    async def _score_batch(
        self, mints: list[str], contexts: dict[str, TokenContext]
    ) -> list[TokenResult]:
        # Each agent gets its own provider key pool (model + api_key per token)
        market_scores, safety_scores, risk_scores, social_scores = await asyncio.gather(
            self._safe_run("market", mints, contexts, self.key_pool.keys_for_agent("market")),
            self._safe_run("safety", mints, contexts, self.key_pool.keys_for_agent("safety")),
            self._safe_run("risk",   mints, contexts, self.key_pool.keys_for_agent("risk")),
            self._safe_run("social", mints, contexts, self.key_pool.keys_for_agent("social")),
        )

        results = []
        for mint in mints:
            agent_scores = {
                "market": market_scores[mint],
                "safety": safety_scores[mint],
                "risk":   risk_scores[mint],
                "social": social_scores[mint],
            }
            final = sum(
                agent_scores[a].score * w
                for a, w in self.AGENT_WEIGHTS.items()
            )
            results.append(TokenResult(
                mint=mint,
                final_score=round(final, 2),
                agent_scores=agent_scores,
            ))

        return results

    async def _safe_run(
        self,
        agent_name:    str,
        mints:         list[str],
        contexts:      dict[str, TokenContext],
        provider_keys: list[ProviderKey],
    ) -> dict[str, AgentScore]:
        """
        Run one agent's score_batch with an outer batch-level timeout.
        On any failure or timeout, return neutral scores for ALL mints.
        Per-token timeouts are handled inside BaseAgent.score_batch().
        """
        agent   = self.agents[agent_name]
        timeout = self.AGENT_BATCH_TIMEOUTS[agent_name]
        try:
            return await asyncio.wait_for(
                agent.score_batch(mints, contexts, provider_keys),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            self._log.warning("{} batch timed out ({}s)", agent_name, timeout)
        except Exception as exc:
            self._log.warning("{} batch failed: {}", agent_name, exc)

        return {
            m: AgentScore(score=self.NEUTRAL_SCORE, reasoning="agent_unavailable", timed_out=True)
            for m in mints
        }

    # ------------------------------------------------------------------
    # Token context
    # ------------------------------------------------------------------

    async def _fetch_contexts(self, mints: list[str]) -> dict[str, TokenContext]:
        pipe = self.redis.pipeline()

        # Portfolio state — same for all tokens in this batch, fetched once
        pipe.get("state.open_positions_count")
        pipe.get("state.daily_loss_pct")

        # Per-token data
        for mint in mints:
            pipe.get(f"state.price.{mint}")
            pipe.get(f"state.token.{mint}")
            pipe.get(f"state.safety.{mint}")
            pipe.get(f"state.social.{mint}")

        raw = await pipe.execute()

        pos_count_raw  = raw[0]
        daily_loss_raw = raw[1]
        pos_count  = int(pos_count_raw.decode())    if pos_count_raw  else 0
        daily_loss = float(daily_loss_raw.decode()) if daily_loss_raw else 0.0

        contexts: dict[str, TokenContext] = {}
        for i, mint in enumerate(mints):
            base       = 2 + i * 4       # offset by 2 (portfolio keys)
            price_raw  = raw[base]
            token_raw  = raw[base + 1]
            safety_raw = raw[base + 2]
            social_raw = raw[base + 3]

            ctx = TokenContext(
                mint=mint,
                open_positions_count=pos_count,
                daily_loss_pct=daily_loss,
            )

            if price_raw:
                p = json.loads(price_raw)
                ctx.price_usd       = float(p.get("price_usd", 0))
                ctx.market_cap_usd  = float(p.get("market_cap_usd", 0))
                ctx.volume_24h_usd  = float(p.get("volume_24h_usd", 0))
                ctx.liquidity_usd   = float(p.get("liquidity_usd", 0))
                ctx.price_change_1h = float(p.get("price_change_1h", 0))

            if token_raw:
                t = json.loads(token_raw)
                ctx.holder_count = int(t.get("holder_count", 0))
                ctx.age_minutes  = int(t.get("age_minutes", 0))

            if safety_raw:
                s = json.loads(safety_raw)
                ctx.rugcheck_score   = float(s.get("score", 100))
                ctx.is_honeypot      = bool(s.get("is_honeypot", False))
                ctx.liquidity_locked = bool(s.get("liquidity_locked", False))
                ctx.top_holder_pct   = float(s.get("top_holder_pct", 0))

            if social_raw:
                so = json.loads(social_raw)
                ctx.kol_buy_count     = int(so.get("kol_buy_count", 0))
                ctx.telegram_mentions = int(so.get("telegram_mentions", 0))
                ctx.twitter_sentiment = float(so.get("twitter_sentiment", 0.5))
                ctx.narrative         = so.get("narrative", "")

            contexts[mint] = ctx

        return contexts

    # ------------------------------------------------------------------
    # Score cache
    # ------------------------------------------------------------------

    async def _split_cached(
        self, mints: list[str]
    ) -> tuple[list[str], list[TokenResult]]:
        pipe = self.redis.pipeline()
        for mint in mints:
            pipe.get(self.SCORE_CACHE_PREFIX + mint)
        raw = await pipe.execute()

        uncached: list[str]        = []
        cached:   list[TokenResult] = []

        for mint, val in zip(mints, raw):
            if not val:
                uncached.append(mint)
                continue
            try:
                cached.append(self._deserialize_result(json.loads(val)))
            except Exception:
                # Corrupted cache entry — treat as cache miss
                uncached.append(mint)

        return uncached, cached

    async def _cache_results(self, results: list[TokenResult]) -> None:
        pipe = self.redis.pipeline()
        for r in results:
            pipe.setex(
                self.SCORE_CACHE_PREFIX + r.mint,
                self.SCORE_CACHE_TTL,
                json.dumps(self._serialize_result(r)),
            )
        await pipe.execute()

    def _serialize_result(self, r: TokenResult) -> dict:
        return {
            "mint":         r.mint,
            "final_score":  r.final_score,
            "approved":     r.approved,
            "agent_scores": {
                k: {"score": v.score, "reasoning": v.reasoning, "timed_out": v.timed_out}
                for k, v in r.agent_scores.items()
            },
        }

    def _deserialize_result(self, d: dict) -> TokenResult:
        # Recompute approved from final_score against current threshold —
        # never trust the cached boolean in case APPROVAL_THRESHOLD changed.
        return TokenResult(
            mint=d["mint"],
            final_score=d["final_score"],
            agent_scores={k: AgentScore(**v) for k, v in d["agent_scores"].items()},
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    async def _ensure_consumer_group(self) -> None:
        try:
            await self.redis.xgroup_create(self.STREAM_IN, self.GROUP, id="$", mkstream=True)
        except Exception:
            pass
```
