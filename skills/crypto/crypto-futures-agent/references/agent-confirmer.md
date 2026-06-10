# Agent Confirmer

`AgentConfirmer` is the asyncio component that sits between `StrategyWorker` and
`RiskManager`. It consumes `stream.pre_signals`, calls the LLM via `ProviderRouter`,
then either forwards approved signals to `stream.signals` or discards them.

---

## stream.pre_signals Schema

StrategyWorker publishes here when `pre_signal_threshold <= score < signal_threshold`.

```python
# Published by StrategyWorker via redis.xadd("stream.pre_signals", fields)
{
    "symbol":    "BTCUSDT",
    "direction": "long",          # "long" | "short"
    "strategy":  "trend",
    "score":     "0.45",          # Decimal string
    "entry":     "67234.50",      # Decimal string — suggested entry
    "sl":        "66800.00",      # Decimal string
    "tp":        "68100.00",      # Decimal string
    "atr":       "420.00",        # Decimal string
    "tf":        "15m",
    "ts":        "1718000000.0",  # unix float
    "candle_ts": "1718000000000", # candle close timestamp ms
    "context":   "{...}",         # JSON — pre-packaged indicators for agent
}
```

The `context` field is a JSON string containing:
```json
{
    "ema9":  67234.50,
    "ema21": 66980.10,
    "ema50": 66100.00,
    "rsi":   58.2,
    "cvd_delta": 1250000,
    "volume_ratio": 1.8,
    "funding_rate": "0.0001",
    "funding_percentile": 45,
    "liq_long_5m": "850000",
    "liq_short_5m": "120000"
}
```

---

## StrategyWorker Modification

Add dual-threshold publishing in `strategy_worker.py`:

```python
# In StrategyWorker._evaluate_and_publish()
async def _evaluate_and_publish(self, symbol: str, df: pd.DataFrame, ...) -> None:
    result = await self._route_strategy(symbol, df, ...)
    if result is None:
        return

    score = result["score"]
    config = await self._load_config(symbol)

    signal_threshold = float(config.get("signal_threshold", 0.6))
    pre_signal_threshold = float(config.get("pre_signal_threshold", 0.4))

    if score >= signal_threshold:
        # High confidence — publish directly to stream.signals (bypass agent)
        await self.redis.xadd("stream.signals", result)

    elif score >= pre_signal_threshold:
        # Medium confidence — send to agent for confirmation
        context = self._build_context(symbol, df, result)
        pre_signal = {**result, "context": json.dumps(context)}
        await self.redis.xadd("stream.pre_signals", pre_signal)

    # score < pre_signal_threshold → discard silently
```

---

## AgentConfirmer Component

```python
# bot_engine/components/agent_confirmer.py
from __future__ import annotations
import asyncio
import json
import time
from decimal import Decimal
from loguru import logger
from redis.asyncio import Redis

from .agent.key_pool import ProviderRouter
from .agent.tools import CONFIRMER_TOOLS, ToolExecutor
from .agent.prompts import build_system_prompt, build_pre_signal_message
from ..config import AgentConfig


class AgentConfirmer:
    """
    Consumes stream.pre_signals, calls LLM for approve/reject,
    publishes approved signals to stream.signals.
    """

    STREAM_IN  = "stream.pre_signals"
    STREAM_OUT = "stream.signals"
    GROUP      = "agent_confirmer"

    def __init__(self, redis: Redis, agent_config: AgentConfig):
        self.redis = redis
        self._config = agent_config
        self._router = ProviderRouter(redis=redis, agent_config=agent_config)
        self._locks: dict[str, asyncio.Lock] = {}  # one Lock per symbol
        self._tool_executor = ToolExecutor(redis=redis)

    def _symbol_lock(self, symbol: str) -> asyncio.Lock:
        if symbol not in self._locks:
            self._locks[symbol] = asyncio.Lock()
        return self._locks[symbol]

    async def run(self, stop_event: asyncio.Event) -> None:
        if not self._config.agent_enabled:
            logger.info("[agent_confirmer] disabled, exiting")
            return

        # Create consumer group — ignore if already exists
        try:
            await self.redis.xgroup_create(
                self.STREAM_IN, self.GROUP, id="$", mkstream=True
            )
        except Exception:
            pass

        logger.info("[agent_confirmer] started")

        while not stop_event.is_set():
            try:
                entries = await self.redis.xreadgroup(
                    groupname=self.GROUP,
                    consumername="confirmer_1",
                    streams={self.STREAM_IN: ">"},
                    count=5,
                    block=2000,
                )
            except Exception as e:
                logger.error(f"[agent_confirmer] xreadgroup error: {e}")
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

        logger.info("[agent_confirmer] stopped")

    async def _handle(self, msg_id: bytes, fields: dict) -> None:
        symbol = fields.get(b"symbol", b"").decode()
        if not symbol:
            await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)
            return

        # Discard if position already open on this symbol
        position = await self.redis.get(f"state.position.{symbol}")
        if position:
            logger.debug(f"[agent_confirmer] {symbol} position open, discard pre-signal")
            await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)
            return

        async with self._symbol_lock(symbol):
            await self._confirm_and_forward(symbol, fields)

        await self.redis.xack(self.STREAM_IN, self.GROUP, msg_id)

    async def _confirm_and_forward(self, symbol: str, fields: dict) -> None:
        pre_signal = {
            k.decode() if isinstance(k, bytes) else k:
            v.decode() if isinstance(v, bytes) else v
            for k, v in fields.items()
        }
        direction = pre_signal.get("direction", "")
        strategy = pre_signal.get("strategy", "")

        logger.info(f"[agent_confirmer] {symbol} {direction} ({strategy}) — calling LLM")

        messages = [
            {"role": "system", "content": build_system_prompt()},
            {"role": "user",   "content": build_pre_signal_message(pre_signal)},
        ]

        try:
            response = await asyncio.wait_for(
                self._router.call(messages, CONFIRMER_TOOLS, tool_choice="required"),
                timeout=self._config.agent_timeout_seconds,
            )
        except asyncio.TimeoutError:
            logger.warning(f"[agent_confirmer] {symbol} LLM timeout")
            response = None

        if response is None:
            if self._config.agent_passthrough_on_fail:
                logger.warning(f"[agent_confirmer] {symbol} passthrough (all providers failed)")
                await self._publish(pre_signal)
            else:
                logger.warning(f"[agent_confirmer] {symbol} dropped (all providers failed, passthrough=false)")
            return

        # Process tool calls
        decision = self._tool_executor.process(response.tool_calls)
        if decision is None:
            # No valid tool call — passthrough
            logger.warning(f"[agent_confirmer] {symbol} no tool call in response, passthrough")
            await self._publish(pre_signal)
            return

        if decision["action"] == "approve":
            signal = {**pre_signal}
            # Apply agent-refined SL/TP if provided
            if decision.get("refined_sl"):
                signal["sl"] = decision["refined_sl"]
            if decision.get("refined_tp"):
                signal["tp"] = decision["refined_tp"]
            signal["agent_confidence"] = str(decision.get("confidence", 0.0))
            signal["agent_reason"]     = decision.get("reason", "")
            signal.pop("context", None)  # remove large context field before forwarding
            logger.info(
                f"[agent_confirmer] {symbol} APPROVED "
                f"confidence={decision.get('confidence')} | {decision.get('reason', '')[:80]}"
            )
            await self._publish(signal)

        else:  # reject
            logger.info(
                f"[agent_confirmer] {symbol} REJECTED | {decision.get('reason', '')[:120]}"
            )

    async def _publish(self, signal: dict) -> None:
        await self.redis.xadd(self.STREAM_OUT, signal)
```

---

## main.py Integration

```python
# bot_engine/main.py additions

from config import AgentConfig
from components.agent_confirmer import AgentConfirmer

async def main() -> None:
    # ... existing setup ...

    agent_config = AgentConfig()
    agent_confirmer = AgentConfirmer(redis=redis, agent_config=agent_config)

    tasks = [
        # ... existing tasks ...
        asyncio.create_task(agent_confirmer.run(stop_event), name="agent_confirmer"),
    ]

    # ... existing gather / shutdown ...
```

---

## config.worker.{symbol} New Fields

```json
{
    "signal_threshold":     0.6,
    "pre_signal_threshold": 0.4
}
```

`signal_threshold` — same as before (direct publish to `stream.signals`).
`pre_signal_threshold` — new; signals in `[pre_signal_threshold, signal_threshold)` go to agent.
If `agent_enabled=false`, the `pre_signal_threshold` band is simply dropped.
