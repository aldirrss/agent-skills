# Integration — Wiring OrchestratorAgent + SignalAggregator into the Engine

This document covers how to add `SignalAggregator` and `OrchestratorAgent` to `main.py`
and the minimal changes required in adjacent components.

---

## Full Pipeline (after integration)

```
Strategies → XADD stream.signals
                    │
                    ▼
          SignalAggregator          ← GATE 1 (composite score ranking, top-15 batch)
                    │
                    ▼  XADD stream.agent.eligible  {batch_id, mints=[...]}
                    │
                    ▼
          OrchestratorAgent         ← GATE 2 (LLM scoring, final_score >= 80)
                    │
                    ▼  XADD stream.agent.approved  {mint, final_score, reasoning, ...}
                    │
                    ▼
            RiskManager             ← reads stream.agent.approved (was: stream.signals)
                    │
                    ▼  XADD stream.swaps
                    │
                    ▼
              Execution
```

The two new components sit between Strategy and RiskManager as always-on stages —
no optional flag, no bypass mode.

---

## Settings Class Changes

```python
# solana_bot/config.py

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # ... existing fields ...

    # --- Agent layer: multi-provider key pools ---
    # Groq keys — used by market, safety, risk agents (free tier)
    groq_api_keys: str = Field(default="", env="GROQ_API_KEYS")

    # Gemini keys — used by social agent (free tier)
    gemini_api_keys: str = Field(default="", env="GEMINI_API_KEYS")

    # Optional alternative providers
    openrouter_api_keys: str = Field(default="", env="OPENROUTER_API_KEYS")
    anthropic_api_keys:  str = Field(default="", env="ANTHROPIC_API_KEYS")
    openai_api_keys:     str = Field(default="", env="OPENAI_API_KEYS")

    # Optional model overrides per agent (defaults in KeyPoolManager)
    agent_market_model: str = Field(default="", env="AGENT_MARKET_MODEL")
    agent_safety_model: str = Field(default="", env="AGENT_SAFETY_MODEL")
    agent_risk_model:   str = Field(default="", env="AGENT_RISK_MODEL")
    agent_social_model: str = Field(default="", env="AGENT_SOCIAL_MODEL")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
```

---

## main.py Changes

Three additions:

1. Import `SignalAggregator` and `OrchestratorAgent`
2. Register their consumer groups in `ensure_consumer_groups`
3. Spawn both tasks unconditionally

```python
# solana_bot/main.py  (relevant sections only)

import asyncio
from loguru import logger

from solana_bot.config import Settings
from solana_bot.components.signal_aggregator import SignalAggregator
from solana_bot.components.orchestrator_agent import OrchestratorAgent
# ... other imports ...


async def ensure_consumer_groups(redis, settings: Settings) -> None:
    streams = [
        # --- existing ---
        ("stream.signals",          "aggregator-group"),    # was: risk-group — now SignalAggregator reads this
        ("stream.swaps",            "execution-group"),
        ("stream.fills",            "tracker-group"),
        ("stream.commands",         "command-group"),
        # --- new ---
        ("stream.agent.eligible",   "orchestrator-group"),  # OrchestratorAgent reads this
        ("stream.agent.approved",   "risk-group"),          # RiskManager reads this
    ]
    for stream_name, group in streams:
        try:
            await redis.xgroup_create(stream_name, group, id="$", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise


async def main() -> None:
    settings = Settings()
    # ... setup: loguru, keypair, redis, postgres, rpc ...

    await ensure_consumer_groups(redis, settings)

    # KeyPoolManager validates all keys at startup — raises ValueError if < 3 keys per agent
    # This happens inside OrchestratorAgent.__init__ → no separate validation needed here.

    tasks: list[asyncio.Task] = []

    # --- Scanner tasks (unchanged) ---
    # tasks += [asyncio.create_task(dexscreener_poller(...), name="scanner.dexscreener"), ...]

    # --- Strategy tasks (unchanged — still publish to stream.signals) ---
    tasks += [
        asyncio.create_task(kol_copy_trade(redis, settings),    name="strategy.kol_copy"),
        asyncio.create_task(new_launch_snipe(redis, settings),  name="strategy.new_launch"),
        # ... other strategy tasks ...
    ]

    # --- SignalAggregator (GATE 1) ---
    aggregator = SignalAggregator(redis, settings)
    tasks.append(asyncio.create_task(aggregator.run(), name="signal_aggregator"))
    logger.info("SignalAggregator started")

    # --- OrchestratorAgent (GATE 2) — raises ValueError if API keys are missing ---
    orchestrator = OrchestratorAgent(redis, settings)
    tasks.append(asyncio.create_task(orchestrator.run(), name="orchestrator_agent"))
    logger.info("OrchestratorAgent started")

    # --- RiskManager now reads stream.agent.approved ---
    # tasks += [asyncio.create_task(risk_manager.run(), name="risk_manager"), ...]

    # --- Execution, PositionTracker, etc. (unchanged) ---

    await asyncio.gather(*tasks)
```

---

## RiskManager Stream Change

RiskManager must switch its input stream from `stream.signals` to `stream.agent.approved`.
The consumer group name stays `risk-group` — only the stream name changes.

```python
# solana_bot/components/risk_manager.py  (change two constants)

STREAM_IN = "stream.agent.approved"   # was: "stream.signals"
GROUP      = "risk-group"
CONSUMER   = "risk-manager-1"
```

The payload fields on `stream.agent.approved` include `mint`, `final_score`, agent scores,
and `reasoning` (JSON dict). The `side` field is always BUY — `stream.agent.approved`
only carries approved buy candidates.

For SELL signals, strategies publish directly to `stream.signals` and SignalAggregator
passes SELLs through immediately (no scoring, no batch):

```
strategy.publish_sell_signal → XADD stream.signals {action=SELL, ...}
    → SignalAggregator passthrough
    → XADD stream.agent.eligible {mints=[], sell_passthrough: {mint, ...}}   [OR]
    → XADD stream.agent.approved directly
```

> **Implementation note:** The simplest approach is to have SignalAggregator write SELL
> signals directly to `stream.agent.approved` without going through OrchestratorAgent.
> This avoids adding SELL handling to the scoring pipeline entirely.

---

## Consumer Group Migration

If upgrading an existing running bot:

```bash
# 1. Create new groups before starting new code
redis-cli XGROUP CREATE stream.signals        aggregator-group  $ MKSTREAM
redis-cli XGROUP CREATE stream.agent.eligible orchestrator-group $ MKSTREAM
redis-cli XGROUP CREATE stream.agent.approved risk-group         $ MKSTREAM

# 2. Delete old risk-group on stream.signals (no longer needed)
redis-cli XGROUP DESTROY stream.signals risk-group
```

---

## Shutdown Order

```
Scanners → Strategy → SignalAggregator → OrchestratorAgent → RiskManager → Execution
```

```python
async def shutdown(tasks: list[asyncio.Task]) -> None:
    shutdown_order = [
        "scanner.",
        "strategy.",
        "signal_aggregator",
        "orchestrator_agent",
        "risk_manager",
        "execution",
    ]
    for prefix in shutdown_order:
        targets = [t for t in tasks if t.get_name().startswith(prefix)]
        for t in targets:
            t.cancel()
        await asyncio.gather(*targets, return_exceptions=True)
```

SignalAggregator and OrchestratorAgent use Redis consumer groups — cancelling them
mid-batch is safe because unacked messages are redelivered on next startup.

---

## .env (wajib)

```bash
# Groq — for market, safety, risk agents (3–5 keys required)
GROQ_API_KEYS=gsk_xxxx1,gsk_xxxx2,gsk_xxxx3

# Gemini — for social agent (3–5 keys required)
GEMINI_API_KEYS=AIzaSy_xxxx1,AIzaSy_xxxx2,AIzaSy_xxxx3

# Optional: override model per agent
# AGENT_MARKET_MODEL=groq/llama-3.1-8b-instant
# AGENT_SAFETY_MODEL=groq/llama-3.1-8b-instant
# AGENT_RISK_MODEL=groq/llama-3.1-8b-instant
# AGENT_SOCIAL_MODEL=gemini/gemini-2.0-flash
```

Engine fails at startup with a clear error if `GROQ_API_KEYS` or `GEMINI_API_KEYS`
has fewer than 3 keys — see `references/key-pool.md` for the full error format.

---

## Observability

`SignalAggregator` and `OrchestratorAgent` emit structured Loguru logs:

```
INFO  signal_aggregator   | dispatching batch=abc123 — 12 tokens (gate1_pass=12/18)
INFO  orchestrator_agent  | approved 7xKp3q... — score=84.5
INFO  orchestrator_agent  | skip 3aZr9x... — score=61.0 market=72 safety=45 risk=68 social=55
WARN  orchestrator_agent  | safety batch timed out (20s)
INFO  orchestrator_agent  | batch abc123 done — 3/12 approved
```

Key metrics to track in Grafana:
- `gate1_pass_rate` = tokens dispatched / total signals received by SignalAggregator
- `gate2_pass_rate` = tokens approved / tokens dispatched by OrchestratorAgent
- `agent_timeout_rate` = timeouts per agent per batch (watch for Groq/Gemini rate limits)
- `llm_cache_hit_rate` = cached scores / total scores (`llm.score.{mint}` TTL 300s)
