# LLM Signal Integration

How LLM sentiment analysis integrates into the signal confluence without blocking the critical path. LLM is one vote — never the sole decision maker.

## Table of contents
- Architecture principle
- LLM signal agent
- Prompt design
- Caching pattern
- Confluence integration
- Provider rotation
- Fallback behavior

## Architecture principle

```
Critical path (latency-sensitive):
  candle → strategy signals → confluence score → stream.signals

LLM path (async, non-blocking):
  candle → LLMSignalAgent → Redis cache → (read by critical path next cycle)
```

The LLM result is **always one cycle behind** the indicator signals. This is intentional. A 5-minute old LLM sentiment score is still useful context; blocking the order path for a 2-second LLM call is not acceptable.

## LLM signal agent

```python
import asyncio
import json
import time
import httpx
from dataclasses import dataclass

@dataclass
class LLMSignal:
    symbol:    str
    score:     float      # 0.0 (strong bear) to 1.0 (strong bull), 0.5 = neutral
    direction: str        # "bullish" | "bearish" | "neutral"
    reason:    str        # short summary for UI display (max 100 chars)
    ts:        int        # unix ms

class LLMSignalAgent:
    """
    Runs as a shared asyncio task. Periodically updates Redis cache
    for all active symbols. Never called inline from StrategyWorker.
    """
    def __init__(self, redis, registry, provider_configs: list[dict],
                 interval_s: int = 240, ttl_s: int = 300):
        self.redis    = redis
        self.registry = registry
        self.providers = provider_configs   # list of {api_key, base_url, model}
        self.interval = interval_s          # refresh every 4 min
        self.ttl      = ttl_s
        self._provider_idx = 0

    async def run(self, stop_event: asyncio.Event):
        while not stop_event.is_set():
            symbols = self.registry.all_symbols()
            tasks = [self._update_symbol(s) for s in symbols]
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(self.interval)

    async def _update_symbol(self, symbol: str):
        try:
            signal = await self._call_llm(symbol)
            await self.redis.set(
                f"llm.signal.{symbol}",
                json.dumps({
                    "score":     signal.score,
                    "direction": signal.direction,
                    "reason":    signal.reason,
                    "ts":        signal.ts,
                }),
                ex=self.ttl,
            )
        except Exception as e:
            # Cache miss is handled gracefully downstream — do not raise
            pass

    def _next_provider(self) -> dict:
        """Round-robin provider rotation."""
        p = self.providers[self._provider_idx % len(self.providers)]
        self._provider_idx += 1
        return p
```

## Prompt design

The prompt must return **structured JSON only** — no prose, no markdown. Strict format enforced.

```python
async def _call_llm(self, symbol: str) -> LLMSignal:
    provider = self._next_provider()

    # Fetch recent price context from Redis
    price = await self.redis.get(f"state.price.{symbol}") or "unknown"

    # Fetch funding rate for context
    fr_cache = await self.redis.get(f"llm.funding.{symbol}") or "0.0001"

    system_prompt = """You are a crypto market sentiment analyzer.
Respond ONLY with a JSON object, no other text, no markdown.
Schema: {"score": float 0-1, "direction": "bullish|bearish|neutral", "reason": string max 80 chars}
score: 0.0=strongly bearish, 0.5=neutral, 1.0=strongly bullish"""

    user_prompt = f"""Analyze short-term (next 4-8 hours) sentiment for {symbol} futures.
Current price: {price} USDT
Funding rate: {fr_cache} per 8h
Consider: market structure, recent volatility, funding as crowd indicator.
Respond with JSON only."""

    async with httpx.AsyncClient(timeout=8.0) as client:
        resp = await client.post(
            f"{provider['base_url']}/chat/completions",
            headers={"Authorization": f"Bearer {provider['api_key']}"},
            json={
                "model":       provider["model"],
                "messages":    [
                    {"role": "system",  "content": system_prompt},
                    {"role": "user",    "content": user_prompt},
                ],
                "max_tokens":  80,
                "temperature": 0.2,    # low temp = consistent structured output
            },
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"].strip()

    parsed = json.loads(content)
    score = float(parsed["score"])
    if not 0.0 <= score <= 1.0:
        raise ValueError(f"Invalid score: {score}")

    return LLMSignal(
        symbol=symbol,
        score=score,
        direction=parsed["direction"],
        reason=parsed["reason"][:100],
        ts=int(time.time() * 1000),
    )
```

## Caching pattern

```python
async def get_llm_signal(redis, symbol: str) -> dict | None:
    """
    Called by StrategyWorker during confluence scoring.
    Returns None if no cached signal (cache miss = LLM not yet ready).
    Never blocks — reads only from Redis.
    """
    raw = await redis.get(f"llm.signal.{symbol}")
    if not raw:
        return None
    data = json.loads(raw)
    # Reject stale signals (older than 10 min despite TTL)
    age_s = (int(time.time() * 1000) - data["ts"]) / 1000
    if age_s > 600:
        return None
    return data
```

## Confluence integration

```python
async def evaluate_strategy(symbol, config, redis, candle) -> dict | None:
    # ... indicator signals computed here ...

    # LLM signal — non-blocking read from cache
    llm = await get_llm_signal(redis, symbol)

    signals = {
        "htf_bias_aligned":  htf_ok,
        "regime_valid":      regime_ok,
        "indicator_signal":  ind_signal,
        "volume_confirms":   vol_ok,
        "llm_aligned":       _llm_aligned(llm, direction) if llm else False,
    }

    score = sum(signals.values())
    threshold = config.get("confluence_threshold", 3)

    # LLM miss degrades gracefully: 4/5 possible instead of 5/5
    # Threshold stays the same — system still trades, just with less info
    if score < threshold:
        return None

    # Size scales with conviction when LLM available
    confidence = score / len(signals)
    return {
        "symbol":      symbol,
        "direction":   direction,
        "strategy":    config["strategy"],
        "confidence":  str(round(confidence, 3)),
        "entry_price": str(candle["close"]),
        "atr":         str(round(atr, 2)),
        "ts":          str(int(time.time() * 1000)),
    }

def _llm_aligned(llm: dict | None, direction: str) -> bool:
    if not llm:
        return False
    if direction == "long"  and llm["score"] > 0.6:  return True
    if direction == "short" and llm["score"] < 0.4:  return True
    return False
```

## Provider rotation

Support multiple API providers (Gemini, Groq, OpenRouter) for redundancy and rate limit distribution:

```python
PROVIDERS = [
    {"api_key": GEMINI_KEY,     "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
     "model": "gemini-2.0-flash"},
    {"api_key": GROQ_KEY,       "base_url": "https://api.groq.com/openai/v1",
     "model": "llama-3.3-70b-versatile"},
    {"api_key": OPENROUTER_KEY, "base_url": "https://openrouter.ai/api/v1",
     "model": "mistralai/mistral-7b-instruct"},
]
# Rotate round-robin. On provider error, skip to next automatically.
```

## Fallback behavior

| Situation | Behavior |
|---|---|
| Cache miss (LLM not yet run) | `llm_aligned = False`, score = N-1/N, continue trading if threshold met |
| LLM call timeout (> 8s) | Log warning, skip update, use stale cache until next cycle |
| All providers fail | Cache expires (TTL), `llm_aligned` stays False indefinitely |
| JSON parse error | Log error, skip cache update, previous value retained |
| Score out of range | Treat as neutral (0.5), do not crash agent |

The system **never stops trading** due to LLM unavailability. LLM is a bonus signal, not a dependency.
