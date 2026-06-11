# Prompt Design

LLM prompt patterns for token signal scoring. All prompts are designed for
`claude-haiku-4-5` — the fastest and cheapest Claude model, suitable for
low-latency scoring in a hot trading pipeline.

---

## System Prompt

```python
# solana_bot/components/agent/prompts.py

def build_system_prompt() -> str:
    return """\
You are a senior crypto analyst evaluating Solana meme and DeFi tokens for a \
trading bot. Your job is to score inbound buy signals 0.0–1.0 based on narrative \
strength, social signal quality, and red flags.

Be concise. Return JSON only. No markdown, no explanation outside the JSON.

SCORING GUIDE:
- 0.8–1.0: Strong narrative, organic social proof, clean on-chain — high conviction
- 0.6–0.8: Decent signal, minor concerns — proceed with normal sizing
- 0.4–0.6: Weak or mixed signal — reduce position or skip
- 0.0–0.4: Spam/bot signals, rug indicators, no real narrative — reject

ALWAYS return exactly: {"score": <float 0.0-1.0>, "reason": "<one sentence max 120 chars>"}
"""
```

**Why cache the system prompt:** At ~150 tokens, the system prompt is stable across all
calls within a session. With `cache_control: {type: "ephemeral"}`, subsequent calls
pay ~0.1× input cost for the cached prefix. At 1000 signals/day this saves ~90% of
system prompt token cost.

---

## User Prompt Template

```python
def build_user_prompt(signal: dict) -> str:
    """
    Build the scoring prompt from a signal dict.
    All fields are optional — missing values degrade gracefully to 'n/a'.
    """
    symbol         = signal.get("symbol", "")
    mint           = signal.get("mint", "")
    strategy       = signal.get("strategy", "")
    sources        = signal.get("sources", "")          # e.g. "kol_wallet,twitter_spike"
    liquidity_usdc = signal.get("liquidity_usdc", "0")
    price_change_1h = signal.get("price_change_1h", "0")
    kol_count      = signal.get("kol_count", "0")
    social_sources = signal.get("social_sources", "")   # e.g. "3 telegram calls, 2 KOL tweets"

    try:
        liq = f"${float(liquidity_usdc):,.0f}"
    except (ValueError, TypeError):
        liq = liquidity_usdc

    try:
        pct = f"{float(price_change_1h):+.1f}%"
    except (ValueError, TypeError):
        pct = price_change_1h

    return (
        f"Token: {symbol} ({mint[:8]}...)\n"
        f"Strategy: {strategy}\n"
        f"Signal sources: {sources}\n"
        f"Liquidity: {liq}\n"
        f"Price change 1h: {pct}\n"
        f"KOL wallets involved: {kol_count}\n"
        f"Social signals: {social_sources or 'none'}\n"
        f"\n"
        f"Score this signal 0.0–1.0 based on:\n"
        f"1. Narrative strength (is there a real story/use case?)\n"
        f"2. Social signal quality (organic vs bot/paid)\n"
        f"3. Red flags (if any from the data above)\n"
        f"\n"
        f"Return JSON: {{\"score\": 0.0-1.0, \"reason\": \"one sentence\"}}"
    )
```

### Example prompts

**High-conviction signal:**
```
Token: PEPEAI (7xKp3q...)
Strategy: kol_copy_trade
Signal sources: kol_wallet,twitter_spike,gmgn_trending
Liquidity: $285,000
Price change 1h: +42.3%
KOL wallets involved: 3
Social signals: 2 KOL tweets, 1 CT thread

Score this signal 0.0–1.0 based on:
1. Narrative strength (is there a real story/use case?)
2. Social signal quality (organic vs bot/paid)
3. Red flags (if any from the data above)

Return JSON: {"score": 0.0-1.0, "reason": "one sentence"}
```

Expected response:
```json
{"score": 0.82, "reason": "3 KOL wallets on-chain + organic CT activity, $285k liquidity adequate, strong momentum"}
```

**Low-quality signal:**
```
Token: MOON2 (3aZr9x...)
Strategy: social_alpha
Signal sources: telegram_alpha
Liquidity: $12,000
Price change 1h: +180.0%
KOL wallets involved: 0
Social signals: 8 telegram calls

Score this signal 0.0–1.0 based on:
1. Narrative strength (is there a real story/use case?)
2. Social signal quality (organic vs bot/paid)
3. Red flags (if any from the data above)

Return JSON: {"score": 0.0-1.0, "reason": "one sentence"}
```

Expected response:
```json
{"score": 0.18, "reason": "Telegram-only, zero KOL wallets, 180% pump on $12k liquidity — classic coordinated dump"}
```

---

## Response Parsing

```python
import json
from typing import Optional


def parse_llm_response(raw: str) -> Optional[float]:
    """
    Parse LLM JSON response and extract score.

    Handles:
    - Clean JSON: {"score": 0.75, "reason": "..."}
    - Markdown-wrapped: ```json\n{"score": 0.75}\n```
    - Whitespace padding

    Returns None on any parse failure (triggers passthrough in AgentConfirmer).
    """
    if not raw or not raw.strip():
        return None

    text = raw.strip()

    # Strip markdown code fences if present
    if text.startswith("```"):
        lines = text.splitlines()
        text = "\n".join(
            line for line in lines
            if not line.strip().startswith("```")
        ).strip()

    try:
        data  = json.loads(text)
        score = float(data["score"])
        return max(0.0, min(1.0, score))   # clamp to [0, 1]
    except (json.JSONDecodeError, KeyError, ValueError, TypeError):
        return None
```

**Fallback behavior table:**

| LLM Response | `parse_llm_response` | `AgentConfirmer` action |
|---|---|---|
| `{"score": 0.75, "reason": "..."}` | `0.75` | Blend confidence |
| ` ```json\n{"score": 0.6}\n``` ` | `0.6` | Blend confidence |
| `{"score": 1.5, "reason": "..."}` | `1.0` (clamped) | Blend confidence |
| `{"error": "..."}` | `None` | Pass original through |
| Empty string | `None` | Pass original through |
| Timeout (asyncio.TimeoutError) | — | Pass original through |
| Network error | — | Pass original through |

---

## Confidence Adjustment Formula

```python
def blend_confidence(original: float, llm_score: float) -> float:
    """
    Blend on-chain confidence (70%) with LLM score (30%).

    LLM contributes 30% weight — never fully overrides on-chain signals.
    On-chain indicators (liquidity, wallet activity, KOL buys) are objective.
    LLM adds soft-signal quality assessment on top.
    """
    return original * 0.7 + llm_score * 0.3
```

**Examples:**

| Original confidence | LLM score | Final confidence | Interpretation |
|---|---|---|---|
| 0.90 | 0.85 | 0.885 | Strong both ways — clear buy |
| 0.75 | 0.20 | 0.585 | Good on-chain, weak narrative — reduced but passes |
| 0.55 | 0.90 | 0.655 | Mediocre on-chain, excellent narrative — boosted |
| 0.40 | 0.05 | 0.295 | Weak on-chain, LLM confirms spam — likely filtered by RiskManager |
| 0.60 | None (timeout) | 0.60 (unchanged) | Passthrough — no LLM influence |

---

## Token Budget

`claude-haiku-4-5` pricing: $1.00 / 1M input, $5.00 / 1M output.

| Component | Tokens (est.) |
|---|---|
| System prompt | ~150 (cached after first call) |
| User prompt | ~120 |
| Response | ~40 |
| **Total per call** | **~310 tokens** |
| **With cache hit** | **~160 tokens** (only user prompt + response) |

At 1,000 BUY signals/day:
- Without caching: ~310K tokens/day → ~$0.31/day
- With system prompt caching: ~160K tokens/day → ~$0.16/day

Set `max_tokens=100` — response is always tiny JSON. Prevents runaway output costs.

---

## Prompt Caching Implementation

```python
# In AgentConfirmer._score_signal()

response = await self.client.messages.create(
    model=self.settings.agent_model,
    max_tokens=self.settings.agent_max_tokens,  # 100
    system=[
        {
            "type": "text",
            "text": build_system_prompt(),
            "cache_control": {"type": "ephemeral"},  # TTL 5 min — stable across all calls
        }
    ],
    messages=[
        {"role": "user", "content": build_user_prompt(signal)}
        # Note: no cache_control on user message — changes per signal
    ],
)
```

Verify cache hits in logs by inspecting `response.usage`:
```python
usage = response.usage
logger.debug(
    "LLM usage: input={} cache_read={} cache_write={} output={}",
    usage.input_tokens,
    usage.cache_read_input_tokens,
    usage.cache_creation_input_tokens,
    usage.output_tokens,
)
```

A healthy session shows `cache_read_input_tokens > 0` after the first call.
