# Integration

How to wire `AgentConfirmer` into the engine. The component is fully optional —
when `AGENT_ENABLED=false` (default) the pipeline is unchanged.

---

## Stream Routing Logic

The key insight: RiskManager always reads `stream.signals`. Only the *publisher* changes.

```
AGENT_ENABLED=false (default):
  Strategy tasks → xadd("stream.signals", ...) → RiskManager

AGENT_ENABLED=true:
  Strategy tasks → xadd("stream.signals.raw", ...) → AgentConfirmer
                                                          ↓
                                                   xadd("stream.signals", ...)
                                                          ↓
                                                    RiskManager
```

RiskManager's consumer group (`risk-group` on `stream.signals`) requires zero changes.

---

## Settings Class Addition

```python
# solana_bot/config.py

from pydantic_settings import BaseSettings
from pydantic import Field


class Settings(BaseSettings):
    # ... existing fields ...

    # Agent layer (optional)
    agent_enabled:    bool  = Field(default=False, env="AGENT_ENABLED")
    anthropic_api_key: str  = Field(default="",    env="ANTHROPIC_API_KEY")
    agent_model:       str  = Field(
        default="claude-haiku-4-5",
        env="AGENT_MODEL",
    )
    agent_max_tokens:  int  = Field(default=100,   env="AGENT_MAX_TOKENS")

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
```

---

## main.py Changes

Three additions to `main.py`:

1. Import `AgentConfirmer`
2. Conditionally create the `stream.signals.raw` consumer group
3. Conditionally spawn the `AgentConfirmer` task

```python
# solana_bot/main.py  (relevant sections only)

import asyncio
import signal as os_signal
from loguru import logger

from solana_bot.config import Settings
from solana_bot.components.agent.confirmer import AgentConfirmer
# ... other imports ...


async def ensure_consumer_groups(redis, settings: Settings) -> None:
    streams = [
        ("stream.signals",      "risk-group"),
        ("stream.swaps",        "execution-group"),
        ("stream.fills",        "tracker-group"),
        ("stream.commands",     "command-group"),
    ]
    # Add agent stream only when agent is enabled
    if settings.agent_enabled:
        streams.append(("stream.signals.raw", "agent-group"))

    for stream_name, group in streams:
        try:
            await redis.xgroup_create(stream_name, group, id="0", mkstream=True)
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise


async def main() -> None:
    settings = Settings()
    # ... setup: loguru, keypair, redis, postgres, rpc ...

    await ensure_consumer_groups(redis, settings)

    tasks: list[asyncio.Task] = []

    # --- Scanner tasks (unchanged) ---
    # tasks += [asyncio.create_task(dexscreener_poller(redis, settings), name="scanner.dexscreener"), ...]

    # --- Strategy tasks ---
    # Strategy publishes to stream.signals.raw when agent enabled,
    # or directly to stream.signals when disabled.
    signal_stream = "stream.signals.raw" if settings.agent_enabled else "stream.signals"

    tasks += [
        asyncio.create_task(
            kol_copy_trade(redis, settings, signal_stream=signal_stream),
            name="strategy.kol_copy",
        ),
        asyncio.create_task(
            new_launch_snipe(redis, settings, signal_stream=signal_stream),
            name="strategy.new_launch",
        ),
        # ... other strategy tasks ...
    ]

    # --- AgentConfirmer (optional) ---
    if settings.agent_enabled:
        confirmer = AgentConfirmer(redis, settings)
        tasks.append(
            asyncio.create_task(confirmer.run(), name="agent.confirmer")
        )
        logger.info("AgentConfirmer enabled — model={}", settings.agent_model)
    else:
        logger.info("AgentConfirmer disabled (AGENT_ENABLED=false)")

    # --- RiskManager, Execution, etc. (unchanged) ---
    # tasks += [asyncio.create_task(risk_manager.run(), name="risk_manager"), ...]

    await asyncio.gather(*tasks)
```

---

## Strategy Task Signal Stream Parameter

Each Strategy task needs a `signal_stream` parameter so it knows where to publish.
This is a minimal, non-breaking change to the existing Strategy interface.

```python
# solana_bot/components/strategy/confluence.py

async def publish_buy_signal(
    redis,
    signal: dict,
    signal_stream: str = "stream.signals",   # default unchanged behaviour
) -> None:
    """
    Publish a BUY signal to the appropriate stream.
    When AgentConfirmer is active, signal_stream = "stream.signals.raw".
    """
    await redis.xadd(signal_stream, signal)
```

Each strategy task passes `signal_stream` down to `publish_buy_signal`. Existing code
that omits the parameter continues working unchanged (publishes to `stream.signals`).

---

## Signal Schema Addition

BUY signals on `stream.signals.raw` use the same schema as `stream.signals` with
two additional optional fields that `AgentConfirmer` reads for prompt building:

```python
{
    # --- Existing fields (unchanged) ---
    "mint":            "7xKp3q...",
    "symbol":          "PEPEAI",
    "side":            "BUY",
    "strategy":        "kol_copy_trade",
    "confidence":      "0.72",          # float str [0, 1]
    "entry_usdc":      "0.000042",
    "liquidity_usdc":  "285000",
    "ts":              "1718000000.0",

    # --- New optional fields for agent scoring ---
    "sources":         "kol_wallet,twitter_spike",   # comma-sep signal source names
    "kol_count":       "3",                           # number of KOL wallets that bought
    "price_change_1h": "42.3",                        # % price change last hour (float str)
    "social_sources":  "2 KOL tweets, 1 CT thread",  # human-readable social summary

    # --- Added by AgentConfirmer on output to stream.signals ---
    # "llm_scored":   "true"
    # "llm_score":    "0.82"
    # (confidence is updated in place)
}
```

If `sources`, `kol_count`, `price_change_1h`, `social_sources` are absent, the prompt
degrades gracefully to `n/a` values — AgentConfirmer never fails due to missing fields.

---

## Shutdown Order

Add AgentConfirmer between Strategy and RiskManager in the shutdown sequence.
Order: Scanners → Strategy → **AgentConfirmer** → RiskManager → Execution.

```python
async def shutdown(tasks: list[asyncio.Task], settings: Settings) -> None:
    # 1. Cancel scanners
    for t in tasks:
        if t.get_name().startswith("scanner."):
            t.cancel()
    await asyncio.gather(*[t for t in tasks if t.get_name().startswith("scanner.")],
                         return_exceptions=True)

    # 2. Cancel strategy tasks
    for t in tasks:
        if t.get_name().startswith("strategy."):
            t.cancel()
    await asyncio.gather(*[t for t in tasks if t.get_name().startswith("strategy.")],
                         return_exceptions=True)

    # 3. Cancel AgentConfirmer (allow up to 5s to finish current LLM call)
    for t in tasks:
        if t.get_name() == "agent.confirmer":
            t.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(t), timeout=5.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

    # 4. RiskManager, Execution, etc.
    # ...
```

---

## Latency Budget

| Strategy | Timeout | Why |
|---|---|---|
| `new_launch_snipe` | **2s** | Token launches expire in seconds — miss window = no trade |
| `kol_copy_trade` | 5s | KOL trades move fast but not sub-second |
| `momentum_spike` | 5s | Momentum windows are a few minutes |
| `graduation_trade` | 8s | Graduation events give a wider window |
| `smart_money_confluence` | 8s | Slower, patient strategy |
| `social_alpha` | 8s | Slowest, highest bar |

`claude-haiku-4-5` typical latency is 300–800ms for a 100-token response. Even with
network overhead, the 2s budget for `new_launch_snipe` is tight. If latency exceeds
2s more than ~5% of the time, consider:

1. Pre-warming the prompt cache by sending a dummy scoring request at startup
2. Reducing `new_launch_snipe` timeout to `AGENT_SKIP` mode (pass all through)
3. Falling back to a local heuristic scorer for time-critical strategies

```python
# Optional: skip LLM for strategies where latency risk > benefit
AGENT_SKIP_STRATEGIES: set[str] = set(
    os.getenv("AGENT_SKIP_STRATEGIES", "").split(",")
)
# Example: AGENT_SKIP_STRATEGIES=new_launch_snipe
```

---

## .env Example

```bash
# Agent layer
AGENT_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-api03-...
AGENT_MODEL=claude-haiku-4-5
AGENT_MAX_TOKENS=100

# Optional: skip agent for time-sensitive strategies
AGENT_SKIP_STRATEGIES=new_launch_snipe
```

---

## Observability

`AgentConfirmer` emits structured Loguru logs at every decision point:

```
INFO  agent_confirmer | LLM scored mint=7xKp3q... strategy=kol_copy_trade orig=0.720 llm=0.820 final=0.750
WARN  agent_confirmer | LLM timeout after 2.0s for mint=3aZr9x...
WARN  agent_confirmer | LLM error for mint=8bNc1y...: anthropic.RateLimitError
DEBUG agent_confirmer | Cache hit llm.score.7xKp3q...
DEBUG agent_confirmer | SELL passthrough mint=9dPm4z...
```

Add a Grafana panel counting `llm_scored=true` signals vs total BUY signals to track
the agent hit rate. A hit rate below 50% may indicate the Anthropic API is throttling.
