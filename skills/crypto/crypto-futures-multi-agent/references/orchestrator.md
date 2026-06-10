# Orchestrator — DRAFT

> ⚠️ **DRAFT** — This file contains architecture design and partial implementation sketches.
> Complete implementation TBD after `crypto-futures-agent` is validated in production.

---

## AgentOrchestrator Skeleton

Drop-in replacement for `AgentConfirmer`. Same constructor signature, same `run()` interface.

```python
# bot_engine/components/agent_orchestrator.py
from __future__ import annotations
import asyncio
import json
from dataclasses import dataclass, field
from loguru import logger
from redis.asyncio import Redis

from .agent.key_pool import ProviderRouter
from .agent.tools import CONFIRMER_TOOLS, ToolExecutor, _safe_decimal
from .agent.prompts import build_system_prompt
from ..config import AgentConfig


@dataclass
class AgentContext:
    pre_signal:     dict
    analyst_report: dict | None = None
    confluence:     dict | None = None
    final_decision: dict | None = None


class AgentOrchestrator:
    """
    Sequential specialist pipeline: Analyst → Confluence → Execution.
    Same external interface as AgentConfirmer.
    """

    STREAM_IN  = "stream.pre_signals"
    STREAM_OUT = "stream.signals"
    GROUP      = "agent_orchestrator"

    def __init__(self, redis: Redis, agent_config: AgentConfig):
        self.redis = redis
        self._config = agent_config
        self._router = ProviderRouter(redis=redis, agent_config=agent_config)
        self._tool_executor = ToolExecutor(redis=redis)
        self._locks: dict[str, asyncio.Lock] = {}

    def _symbol_lock(self, symbol: str) -> asyncio.Lock:
        if symbol not in self._locks:
            self._locks[symbol] = asyncio.Lock()
        return self._locks[symbol]

    async def run(self, stop_event: asyncio.Event) -> None:
        # TODO: identical to AgentConfirmer.run() — extract to base class
        if not self._config.agent_enabled:
            return
        try:
            await self.redis.xgroup_create(
                self.STREAM_IN, self.GROUP, id="$", mkstream=True
            )
        except Exception:
            pass

        logger.info("[orchestrator] started")
        while not stop_event.is_set():
            try:
                entries = await self.redis.xreadgroup(
                    groupname=self.GROUP,
                    consumername="orchestrator_1",
                    streams={self.STREAM_IN: ">"},
                    count=3,
                    block=2000,
                )
            except Exception as e:
                logger.error(f"[orchestrator] xreadgroup error: {e}")
                await asyncio.sleep(1)
                continue

            if not entries:
                continue

            for _, messages in entries:
                tasks = [
                    asyncio.create_task(self._handle(msg_id, fields))
                    for msg_id, fields in messages
                ]
                await asyncio.gather(*tasks, return_exceptions=True)

        logger.info("[orchestrator] stopped")

    async def _handle(self, msg_id: bytes, fields: dict) -> None:
        symbol = fields.get(b"symbol", b"").decode()
        position = await self.redis.get(f"state.position.{symbol}")
        if position:
            await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)
            return

        async with self._symbol_lock(symbol):
            ctx = AgentContext(pre_signal={
                k.decode() if isinstance(k, bytes) else k:
                v.decode() if isinstance(v, bytes) else v
                for k, v in fields.items()
            })
            await self._run_pipeline(ctx)

        await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)

    async def _run_pipeline(self, ctx: AgentContext) -> None:
        symbol = ctx.pre_signal.get("symbol", "")

        # Step ① — Market Analyst
        ctx.analyst_report = await self._run_analyst(ctx)
        if ctx.analyst_report is None:
            await self._passthrough_or_drop(ctx, "analyst failed")
            return

        # Step ② — Confluence
        ctx.confluence = await self._run_confluence(ctx)
        if ctx.confluence is None:
            await self._passthrough_or_drop(ctx, "confluence failed")
            return

        # Step ③ — Execution Decision
        ctx.final_decision = await self._run_execution(ctx)
        if ctx.final_decision is None:
            await self._passthrough_or_drop(ctx, "execution agent failed")
            return

        if ctx.final_decision["action"] == "approve":
            signal = {**ctx.pre_signal}
            signal["sl"] = _safe_decimal(ctx.final_decision.get("refined_sl")) or signal["sl"]
            signal["tp"] = _safe_decimal(ctx.final_decision.get("refined_tp")) or signal["tp"]
            signal["agent_confidence"] = str(ctx.final_decision.get("confidence", 0.0))
            signal["agent_reason"]     = ctx.final_decision.get("reason", "")
            signal.pop("context", None)
            logger.info(f"[orchestrator] {symbol} APPROVED {signal['agent_reason'][:80]}")
            await self.redis.xadd(self.STREAM_OUT, signal)
        else:
            logger.info(f"[orchestrator] {symbol} REJECTED {ctx.final_decision.get('reason', '')[:80]}")

    async def _passthrough_or_drop(self, ctx: AgentContext, reason: str) -> None:
        symbol = ctx.pre_signal.get("symbol", "")
        if self._config.agent_passthrough_on_fail:
            logger.warning(f"[orchestrator] {symbol} passthrough ({reason})")
            signal = {k: v for k, v in ctx.pre_signal.items() if k != "context"}
            await self.redis.xadd(self.STREAM_OUT, signal)
        else:
            logger.warning(f"[orchestrator] {symbol} dropped ({reason})")
```

---

## MarketAnalystAgent (Draft)

Uses structured JSON output — no tool calling required.
Append `"Return valid JSON only, no other text."` to system prompt.

```python
    async def _run_analyst(self, ctx: AgentContext) -> dict | None:
        """
        TODO: implement fully.
        Expected output schema:
        {
            "trend": "bullish" | "bearish" | "ranging",
            "ema_stack": "aligned_bull" | "aligned_bear" | "mixed",
            "rsi_zone": "oversold" | "neutral" | "overbought",
            "cvd_bias": "buying" | "selling" | "neutral",
            "liq_bias": "long_cascade" | "short_cascade" | "neutral",
            "funding_bias": "long_crowded" | "short_crowded" | "neutral",
            "summary": "string"
        }
        """
        # TODO
        raise NotImplementedError

    _ANALYST_SYSTEM = """\
You are a market analyst for crypto futures. Analyze the provided market data
and return a structured assessment. Be objective and factual.
Return JSON only — no markdown, no explanation, no code block.
"""

    def _build_analyst_message(self, ctx: AgentContext) -> str:
        pre = ctx.pre_signal
        market_ctx: dict = {}
        try:
            market_ctx = json.loads(pre.get("context", "{}"))
        except Exception:
            pass
        # TODO: format into concise analyst prompt
        return f"Symbol: {pre.get('symbol')}\nContext: {json.dumps(market_ctx, indent=2)}"
```

---

## ConfluenceAgent (Draft)

Pure reasoning — no tools, no Redis calls. Only needs analyst_report + pre_signal.

```python
    async def _run_confluence(self, ctx: AgentContext) -> dict | None:
        """
        TODO: implement fully.
        Expected output schema:
        {
            "score": 0.0-1.0,
            "supporting": ["reason1", "reason2"],
            "conflicting": ["reason1"],
            "verdict": "strong" | "moderate" | "weak" | "against"
        }
        """
        # TODO
        raise NotImplementedError

    _CONFLUENCE_SYSTEM = """\
You are a trading confluence evaluator. Given a proposed trade direction and
a market analyst report, score how many factors align with the direction.
Return JSON only — no markdown, no explanation.
"""
```

---

## ExecutionAgent (Draft)

Reuses `CONFIRMER_TOOLS` from `crypto-futures-agent`. Receives full context.

```python
    async def _run_execution(self, ctx: AgentContext) -> dict | None:
        """
        TODO: implement fully.
        Reuses CONFIRMER_TOOLS (approve_signal / reject_signal).
        """
        # TODO
        raise NotImplementedError

    _EXECUTION_SYSTEM = """\
You are an execution decision agent. A market analyst and confluence evaluator
have already assessed this setup. Make the final approve/reject decision.
Call approve_signal or reject_signal — no other response is acceptable.
"""

    def _build_execution_message(self, ctx: AgentContext) -> str:
        pre = ctx.pre_signal
        return (
            f"Signal: {pre.get('symbol')} {pre.get('direction')} via {pre.get('strategy')}\n"
            f"Entry: {pre.get('entry')} | SL: {pre.get('sl')} | TP: {pre.get('tp')}\n\n"
            f"Analyst report:\n{json.dumps(ctx.analyst_report, indent=2)}\n\n"
            f"Confluence:\n{json.dumps(ctx.confluence, indent=2)}\n\n"
            "Approve or reject. Be decisive."
        )
```

---

## Implementation Notes (for when you build this)

1. **Parse JSON from analyst/confluence agents safely** — `json.loads()` inside try/except.
   If parsing fails, treat as agent failure and apply passthrough rule.

2. **Token optimization** — ConfluenceAgent receives only the analyst_report summary,
   not the full raw indicator data. Reduces tokens by ~40%.

3. **Parallel option** — ConfluenceAgent and ExecutionAgent could theoretically run
   in parallel if ExecutionAgent doesn't need confluence output. Current design is
   sequential because ExecutionAgent benefits from the confluence verdict.

4. **Per-agent timeout** — each agent gets `agent_timeout_seconds / 3` to ensure
   total pipeline finishes within the configured timeout.

5. **Short-circuit** — if `confluence.verdict == "against"`, skip ExecutionAgent
   and reject immediately. Saves one LLM call.
