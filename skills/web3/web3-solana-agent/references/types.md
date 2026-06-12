# Shared Types — AgentScore & TokenContext

Shared dataclasses used by both `orchestrator_agent.py` and all sub-agents.
Keeping them in a separate module breaks the circular import:
`orchestrator_agent.py` → `base.py` → `orchestrator_agent.py`.

```python
# solana_bot/components/agents/types.py

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class AgentScore:
    score:     float          # 0–100
    reasoning: str
    timed_out: bool = False


@dataclass
class TokenContext:
    mint: str

    # Market data (from state.price.{mint})
    price_usd:         float = 0.0
    market_cap_usd:    float = 0.0
    volume_24h_usd:    float = 0.0
    liquidity_usd:     float = 0.0
    price_change_1h:   float = 0.0

    # Token metadata (from state.token.{mint})
    holder_count:      int   = 0
    age_minutes:       int   = 0

    # Safety data (from state.safety.{mint})
    rugcheck_score:    float = 100.0   # 100 = safe, 0 = high risk
    is_honeypot:       bool  = False
    liquidity_locked:  bool  = False
    top_holder_pct:    float = 0.0

    # Social data (from state.social.{mint})
    kol_buy_count:     int   = 0
    telegram_mentions: int   = 0
    twitter_sentiment: float = 0.5    # 0=negative, 1=positive
    narrative:         str   = ""

    # Portfolio state (from state.open_positions_count, state.daily_loss_pct)
    # Same value for all tokens in a batch — fetched once by OrchestratorAgent
    open_positions_count: int   = 0
    daily_loss_pct:       float = 0.0
```
