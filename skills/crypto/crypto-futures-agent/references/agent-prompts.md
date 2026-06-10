# Agent Prompts

System prompt and message builders for `AgentConfirmer`.
Prompt engineering principles applied here:
- Short, focused context — free/small models degrade with long prompts
- Explicit decision contract — agent must call exactly one of `approve_signal` / `reject_signal`
- No hallucination surface — agent gets only factual market data, no open-ended questions

---

## System Prompt

```python
# bot_engine/components/agent/prompts.py

def build_system_prompt() -> str:
    return """\
You are a disciplined crypto futures trading confirmation agent.

ROLE:
A rule-based strategy has already identified a candidate trade setup. Your job
is to confirm or reject it based on market context. You are the second filter,
not the first. Be demanding — only approve setups with genuine confluence.

DECISION CONTRACT:
You MUST call exactly one tool: approve_signal OR reject_signal.
Never respond with plain text. Never call both. Never call neither.

APPROVAL CRITERIA (need at least 3 of 5):
1. Trend alignment — higher timeframe EMA stack supports the direction
2. Momentum — RSI in favorable zone (30-50 for longs, 50-70 for shorts at entry)
3. CVD confluence — cumulative volume delta confirms buyer/seller dominance
4. Structural support — price near key level (EMA, round number, prior swing)
5. Liquidation confluence — liquidation cascade data supports direction

REJECTION TRIGGERS (any one is enough):
- RSI overextended (>75 for long entry, <25 for short entry)
- CVD diverges against direction (price up, CVD down = distribution)
- Funding rate extreme AND against direction (>0.05% for long, <-0.05% for short)
- Heavy liquidation cascade in same direction as entry (momentum exhaustion)
- EMA stack inverted vs direction (9 < 21 for long attempt)

POSITION SIZING AND RISK:
You do NOT determine size — that is RiskManager's job downstream.
You may refine SL/TP only if a structural level (order block, swing pivot,
fair value gap) gives a materially better price. Never widen the SL.

OUTPUT FORMAT:
- reason: concise, specific, max 120 characters
- confidence: your genuine conviction 0.0-1.0 (not always 0.9+)
- refined_sl / refined_tp: only if you have a structural reason; leave empty otherwise
"""
```

---

## Pre-Signal Message Builder

```python
import json
from decimal import Decimal


def build_pre_signal_message(pre_signal: dict) -> str:
    """
    Build the user message from a pre_signal dict.
    Formats all data cleanly for the LLM.
    """
    symbol    = pre_signal.get("symbol", "")
    direction = pre_signal.get("direction", "")
    strategy  = pre_signal.get("strategy", "")
    score     = pre_signal.get("score", "")
    entry     = pre_signal.get("entry", "")
    sl        = pre_signal.get("sl", "")
    tp        = pre_signal.get("tp", "")
    atr       = pre_signal.get("atr", "")
    tf        = pre_signal.get("tf", "")

    # Parse context JSON
    ctx: dict = {}
    try:
        ctx = json.loads(pre_signal.get("context", "{}"))
    except (json.JSONDecodeError, TypeError):
        pass

    # Compute R:R
    try:
        entry_d = Decimal(entry)
        sl_d    = Decimal(sl)
        tp_d    = Decimal(tp)
        risk    = abs(entry_d - sl_d)
        reward  = abs(tp_d - entry_d)
        rr      = float(reward / risk) if risk > 0 else 0.0
    except Exception:
        rr = 0.0

    lines = [
        f"CANDIDATE SIGNAL — {symbol} {direction.upper()}",
        f"Strategy: {strategy} | Timeframe: {tf} | Rule-based score: {score}",
        "",
        "TRADE LEVELS:",
        f"  Entry : {entry}",
        f"  SL    : {sl}  (risk {atr} ATR)",
        f"  TP    : {tp}  (R:R {rr:.2f})",
        "",
        "MARKET INDICATORS:",
        f"  EMA9  : {ctx.get('ema9', 'n/a')}",
        f"  EMA21 : {ctx.get('ema21', 'n/a')}",
        f"  EMA50 : {ctx.get('ema50', 'n/a')}",
        f"  RSI   : {ctx.get('rsi', 'n/a')}",
        f"  CVD delta (last candle): {ctx.get('cvd_delta', 'n/a')}",
        f"  Volume vs avg : {ctx.get('volume_ratio', 'n/a')}x",
        "",
        "FUNDING & LIQUIDATIONS:",
        f"  Funding rate       : {ctx.get('funding_rate', 'n/a')}",
        f"  Funding percentile : {ctx.get('funding_percentile', 'n/a')}th",
        f"  Liq long  5m       : ${ctx.get('liq_long_5m', '0')}",
        f"  Liq short 5m       : ${ctx.get('liq_short_5m', '0')}",
        "",
        "Call approve_signal or reject_signal now.",
    ]
    return "\n".join(lines)
```

---

## Example Prompts (Reference)

### Approve example

```
CANDIDATE SIGNAL — BTCUSDT LONG
Strategy: trend | Timeframe: 15m | Rule-based score: 0.47

TRADE LEVELS:
  Entry : 67234.50
  SL    : 66800.00  (risk 420.00 ATR)
  TP    : 68100.00  (R:R 2.06)

MARKET INDICATORS:
  EMA9  : 67234.50
  EMA21 : 66980.10
  EMA50 : 66100.00
  RSI   : 58.2
  CVD delta (last candle): 1250000
  Volume vs avg : 1.8x

FUNDING & LIQUIDATIONS:
  Funding rate       : 0.0001
  Funding percentile : 45th
  Liq long  5m       : $850000
  Liq short 5m       : $120000
```

Expected response: `approve_signal(confidence=0.72, reason="EMA9>21>50 bullish stack, RSI mid-range, CVD positive, funding neutral, good R:R")`

### Reject example (overextended RSI)

```
RSI   : 78.4
EMA9  : 89430.00  (above EMA21 and EMA50)
CVD delta: -340000  (distribution despite price high)
```

Expected response: `reject_signal(reason="RSI 78 overbought, CVD diverging negative — distribution signal, exhaustion likely")`

---

## Prompt Tuning Notes

| Model family | Observed behavior | Tuning tip |
|---|---|---|
| Llama 3.3 70B (Groq) | Generally follows contract, may add text before tool call | Add "Call the tool immediately, no preamble" to system prompt if needed |
| Gemini Flash | Strong at structured output | Works well as-is |
| DeepSeek Chat | Excellent reasoning, may over-analyze | Add "Be concise" to keep tokens low |
| GPT-4o-mini | Very reliable tool use | Works well as-is |
| Claude Haiku | Best tool use reliability | Works well as-is, slightly verbose reasoning |
| Qwen 2.5 72B | Good but tool use less stable | Set `tool_choice="auto"` instead of `"required"` if errors occur |

**Token budget:** System prompt ~350 tokens + user message ~250 tokens = ~600 tokens input.
Response with one tool call is typically 80-150 tokens.
Total per confirmation: ~750 tokens — very cheap on free tiers.
