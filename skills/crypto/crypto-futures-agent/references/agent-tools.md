# Agent Tools

Tool definitions for the `AgentConfirmer` LLM agent.
The agent has two decision tools (`approve_signal`, `reject_signal`) and one
optional data-fetch tool (`get_market_context`) for when the pre-packaged context
is insufficient.

Tool definitions use OpenAI function-calling format (compatible with all providers).
`AnthropicClient` converts them automatically — see `llm-providers.md`.

---

## Tool Definitions

```python
# bot_engine/components/agent/tools.py

CONFIRMER_TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "approve_signal",
            "description": (
                "Approve the candidate signal for execution. "
                "Call this when the market context supports the trade setup. "
                "Optionally provide refined SL/TP as Decimal strings."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "confidence": {
                        "type": "number",
                        "description": "Your confidence in this trade, 0.0 to 1.0",
                    },
                    "reason": {
                        "type": "string",
                        "description": (
                            "Concise reason for approval. "
                            "Max 120 characters. Include confluences that support the trade."
                        ),
                    },
                    "refined_sl": {
                        "type": "string",
                        "description": (
                            "Optional: refined stop-loss price as decimal string (e.g. '67100.50'). "
                            "Only provide if you have a strong structural reason to adjust. "
                            "Must be a tighter or equivalent stop, never wider."
                        ),
                    },
                    "refined_tp": {
                        "type": "string",
                        "description": (
                            "Optional: refined take-profit price as decimal string. "
                            "Only provide if a structural target (e.g. OB, FVG, resistance) "
                            "gives a better exit than the rule-based TP."
                        ),
                    },
                },
                "required": ["confidence", "reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "reject_signal",
            "description": (
                "Reject the candidate signal. Do not trade. "
                "Call this when the setup lacks confluence, structure conflicts, "
                "or risk/reward is unfavorable."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": (
                            "Concise reason for rejection. Max 120 characters. "
                            "Be specific: what is wrong with this setup?"
                        ),
                    },
                },
                "required": ["reason"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_market_context",
            "description": (
                "Fetch additional market context from Redis if the pre-packaged context "
                "is not enough to make a decision. Use sparingly — adds latency."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {
                        "type": "string",
                        "description": "Trading symbol e.g. BTCUSDT",
                    },
                    "data_type": {
                        "type": "string",
                        "enum": ["position", "price", "funding", "liquidation"],
                        "description": "What additional data to fetch",
                    },
                },
                "required": ["symbol", "data_type"],
            },
        },
    },
]
```

---

## ToolExecutor

Handles tool calls returned by the LLM. For `get_market_context`, fetches from Redis
and returns a follow-up message. For decision tools, returns the final decision dict.

```python
# bot_engine/components/agent/tools.py  (continued)
from __future__ import annotations
import json
from dataclasses import dataclass
from loguru import logger
from redis.asyncio import Redis

from .providers import ToolCall


@dataclass
class Decision:
    action: str        # "approve" | "reject"
    confidence: float  # only for approve
    reason: str
    refined_sl: str | None = None
    refined_tp: str | None = None


class ToolExecutor:
    def __init__(self, redis: Redis):
        self.redis = redis

    def process(self, tool_calls: list[ToolCall]) -> dict | None:
        """
        Process tool calls from LLM response.
        Returns decision dict for approve/reject, or None if no valid decision found.
        Note: get_market_context is handled in a separate agentic loop
        in AgentConfirmer._confirm_with_tools() below.
        """
        for tc in tool_calls:
            if tc.name == "approve_signal":
                return {
                    "action": "approve",
                    "confidence": float(tc.arguments.get("confidence", 0.7)),
                    "reason": tc.arguments.get("reason", ""),
                    "refined_sl": tc.arguments.get("refined_sl") or None,
                    "refined_tp": tc.arguments.get("refined_tp") or None,
                }
            if tc.name == "reject_signal":
                return {
                    "action": "reject",
                    "reason": tc.arguments.get("reason", ""),
                }
        return None

    async def fetch_context(self, symbol: str, data_type: str) -> str:
        """Execute get_market_context tool call. Returns JSON string."""
        try:
            if data_type == "position":
                val = await self.redis.get(f"state.position.{symbol}")
                return val.decode() if val else "null"

            if data_type == "price":
                val = await self.redis.get(f"state.price.{symbol}")
                return json.dumps({"price": val.decode() if val else "unknown"})

            if data_type == "funding":
                val = await self.redis.get(f"funding.cache.{symbol}")
                return val.decode() if val else "null"

            if data_type == "liquidation":
                val = await self.redis.get(f"liq.summary.{symbol}.5m")
                return val.decode() if val else "null"

        except Exception as e:
            logger.error(f"[tool_executor] fetch_context error: {e}")
            return "null"

        return "null"
```

---

## Agentic Tool Loop in AgentConfirmer

When `get_market_context` is called, the agent needs a follow-up message.
Extend `_confirm_and_forward` with a bounded tool loop (max 2 rounds):

```python
# In AgentConfirmer (replace simple call with tool loop)
async def _run_tool_loop(
    self,
    messages: list[dict],
    pre_signal: dict,
) -> dict | None:
    """
    Bounded tool loop: max 3 LLM calls per pre-signal.
    Handles get_market_context mid-conversation.
    Returns decision dict or None.
    """
    max_rounds = 3
    tool_executor = self._tool_executor

    for _ in range(max_rounds):
        response = await self._router.call(
            messages, CONFIRMER_TOOLS, tool_choice="required"
        )
        if response is None:
            return None

        # Check for final decision
        decision = tool_executor.process(response.tool_calls)
        if decision is not None:
            return decision

        # Handle get_market_context calls
        follow_up_content = []
        for tc in response.tool_calls:
            if tc.name == "get_market_context":
                symbol = tc.arguments.get("symbol", pre_signal.get("symbol", ""))
                data_type = tc.arguments.get("data_type", "price")
                ctx_data = await tool_executor.fetch_context(symbol, data_type)
                follow_up_content.append({
                    "type": "tool_result",
                    "tool_use_id": tc.call_id,
                    "content": ctx_data,
                })

        if not follow_up_content:
            # No recognized tool call — stop
            return None

        # Append assistant message + tool results and continue loop
        messages.append({"role": "assistant", "content": str(response.text or "")})
        messages.append({"role": "user", "content": json.dumps(follow_up_content)})

    logger.warning("[agent_confirmer] tool loop exceeded max_rounds")
    return None
```

---

## Tool Call Validation Rules

1. `approve_signal.confidence` must be in `[0.0, 1.0]` — clamp if out of range.
2. `approve_signal.refined_sl` / `refined_tp` — if present, must be parseable as `Decimal`. If parsing fails, discard the refinement but keep approval.
3. `reject_signal.reason` — must be non-empty. If empty, still reject (reason = "unspecified").
4. Unknown tool names — log and skip. Do not crash.

```python
# Validation helper
from decimal import Decimal, InvalidOperation

def _safe_decimal(value: str | None) -> str | None:
    if not value:
        return None
    try:
        Decimal(value)
        return value
    except InvalidOperation:
        logger.warning(f"[agent_tools] invalid decimal from LLM: {value!r}, ignoring")
        return None
```
