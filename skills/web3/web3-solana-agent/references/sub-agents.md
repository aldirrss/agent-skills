# Sub-Agents — Market, Safety, Risk, Social

All sub-agents share the same interface: `score_batch(mints, contexts, keys) -> dict[str, AgentScore]`.
Token-to-key assignment: `keys[token_index % len(keys)]`.
`AgentScore` and `TokenContext` are defined in `references/types.md` (`solana_bot/components/agents/types.py`).

---

## Base Class

```python
# solana_bot/components/agents/base.py

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod

import litellm
from loguru import logger

from solana_bot.components.agents.types import AgentScore, TokenContext
from solana_bot.components.key_pool     import ProviderKey
from solana_bot.config import Settings

NEUTRAL_SCORE = 50.0
litellm.set_verbose = False   # suppress litellm debug output


class BaseAgent(ABC):
    TIMEOUT: float = 8.0    # per-token LLM call timeout (seconds)
    NAME:    str   = "base"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._log     = logger.bind(component=self.NAME)

    async def score_batch(
        self,
        mints:         list[str],
        contexts:      dict[str, TokenContext],
        provider_keys: list[ProviderKey],
    ) -> dict[str, AgentScore]:
        """
        Score all mints concurrently via litellm.
        Each token gets a deterministic ProviderKey: provider_keys[i % len(provider_keys)].
        Timed-out or errored tokens return NEUTRAL_SCORE — never raises.
        """
        tasks = {
            mint: asyncio.create_task(
                self._score_one(mint, contexts[mint], provider_keys[i % len(provider_keys)])
            )
            for i, mint in enumerate(mints)
        }

        settled = await asyncio.gather(*tasks.values(), return_exceptions=True)

        results: dict[str, AgentScore] = {}
        for mint, outcome in zip(tasks.keys(), settled):
            if isinstance(outcome, asyncio.TimeoutError):
                self._log.warning("{} per-token timeout: {}", self.NAME, mint)
                results[mint] = AgentScore(
                    score=NEUTRAL_SCORE, reasoning="timeout", timed_out=True
                )
            elif isinstance(outcome, Exception):
                self._log.warning("{} error for {}: {}", self.NAME, mint, outcome)
                results[mint] = AgentScore(
                    score=NEUTRAL_SCORE, reasoning="error", timed_out=True
                )
            else:
                results[mint] = outcome

        return results

    async def _score_one(self, mint: str, ctx: TokenContext, pk: ProviderKey) -> AgentScore:
        response = await asyncio.wait_for(
            litellm.acompletion(
                model=pk.model,
                messages=[{"role": "user", "content": self._build_prompt(ctx)}],
                max_tokens=150,
                api_key=pk.api_key,
                temperature=0.1,    # low temp for consistent scoring
            ),
            timeout=self.TIMEOUT,
        )
        return self._parse_response(response.choices[0].message.content)

    @abstractmethod
    def _build_prompt(self, ctx: TokenContext) -> str: ...

    def _parse_response(self, text: str) -> AgentScore:
        """
        Expected LLM output:
            SCORE: 75
            REASON: <one line>
        """
        score     = NEUTRAL_SCORE
        reasoning = "no_reason_parsed"

        for line in text.splitlines():
            line = line.strip()
            if line.startswith("SCORE:"):
                try:
                    score = float(line.split(":", 1)[1].strip())
                    score = max(0.0, min(100.0, score))
                except ValueError:
                    pass
            elif line.startswith("REASON:"):
                reasoning = line.split(":", 1)[1].strip()

        return AgentScore(score=score, reasoning=reasoning)
```

---

## Market Agent

```python
# solana_bot/components/agents/market.py

from solana_bot.components.agents.base  import BaseAgent
from solana_bot.components.agents.types import TokenContext


class MarketAgent(BaseAgent):
    NAME    = "market"
    TIMEOUT = 5.0

    def _build_prompt(self, ctx: TokenContext) -> str:
        return f"""You are a crypto market analyst evaluating a Solana token for entry quality.

Token data:
- Price: ${ctx.price_usd:.6f}
- Market cap: ${ctx.market_cap_usd:,.0f}
- Liquidity: ${ctx.liquidity_usd:,.0f}
- 24h volume: ${ctx.volume_24h_usd:,.0f}
- 1h price change: {ctx.price_change_1h:+.1f}%
- Token age: {ctx.age_minutes} minutes
- Holder count: {ctx.holder_count}

Score this token 0–100 for entry quality.
- 90–100: Exceptional momentum, deep liquidity, strong volume, early entry
- 70–89:  Good setup, reasonable liquidity, healthy trend
- 50–69:  Neutral, mixed signals
- 30–49:  Weak setup — low volume, thin liquidity, or late entry
- 0–29:   Poor — no momentum, suspicious volume, or extremely thin

Reply in exactly this format:
SCORE: <number 0-100>
REASON: <one sentence>"""
```

---

## Safety Agent

```python
# solana_bot/components/agents/safety.py

from solana_bot.components.agents.base  import BaseAgent
from solana_bot.components.agents.types import TokenContext


class SafetyAgent(BaseAgent):
    NAME    = "safety"
    TIMEOUT = 3.0

    def _build_prompt(self, ctx: TokenContext) -> str:
        honeypot_str   = "YES — CRITICAL RISK" if ctx.is_honeypot else "No"
        locked_str     = "Yes" if ctx.liquidity_locked else "No — risk"
        rugcheck_label = (
            "HIGH RISK"   if ctx.rugcheck_score < 40 else
            "MEDIUM RISK" if ctx.rugcheck_score < 70 else
            "LOW RISK"
        )

        return f"""You are a Solana token safety auditor.

Safety data:
- Rugcheck score: {ctx.rugcheck_score:.0f}/100 ({rugcheck_label})
- Honeypot detected: {honeypot_str}
- Liquidity locked: {locked_str}
- Top holder concentration: {ctx.top_holder_pct:.1f}% of supply
- Holder count: {ctx.holder_count}

Score this token 0–100 for safety.
- 90–100: Clean contract, locked liquidity, healthy distribution
- 70–89:  Minor concerns but generally safe
- 50–69:  Notable risks, proceed with caution
- 30–49:  High risk — significant red flags
- 0–29:   Dangerous — likely rug or honeypot

CRITICAL: If honeypot=YES, score must be 0.
If rugcheck_score < 30, score must be <= 20.

Reply in exactly this format:
SCORE: <number 0-100>
REASON: <one sentence>"""
```

---

## Risk Agent

```python
# solana_bot/components/agents/risk.py

from solana_bot.components.agents.base  import BaseAgent
from solana_bot.components.agents.types import TokenContext


class RiskAgent(BaseAgent):
    NAME    = "risk"
    TIMEOUT = 5.0

    def _build_prompt(self, ctx: TokenContext) -> str:
        return f"""You are a crypto risk manager evaluating whether to open a new position.

Portfolio state:
- Open positions: {ctx.open_positions_count}
- Daily PnL: {ctx.daily_loss_pct:+.2f}%

Token risk profile:
- Liquidity: ${ctx.liquidity_usd:,.0f} (exit feasibility)
- Market cap: ${ctx.market_cap_usd:,.0f}
- 1h price change: {ctx.price_change_1h:+.1f}%
- Token age: {ctx.age_minutes} minutes

Score 0–100 for risk/reward favorability.
- 90–100: Excellent R/R, deep liquidity, low portfolio exposure
- 70–89:  Good R/R with acceptable risk
- 50–69:  Neutral — balanced risk
- 30–49:  Unfavorable R/R or too much portfolio exposure
- 0–29:   Poor R/R — likely chasing, illiquid exit, or overexposed

Reply in exactly this format:
SCORE: <number 0-100>
REASON: <one sentence>"""
```

---

## Social Agent

```python
# solana_bot/components/agents/social.py

from solana_bot.components.agents.base  import BaseAgent
from solana_bot.components.agents.types import TokenContext


class SocialAgent(BaseAgent):
    NAME    = "social"
    TIMEOUT = 8.0

    def _build_prompt(self, ctx: TokenContext) -> str:
        sentiment_label = (
            "positive" if ctx.twitter_sentiment > 0.6 else
            "negative" if ctx.twitter_sentiment < 0.4 else
            "neutral"
        )

        return f"""You are a crypto social analyst evaluating narrative strength and community momentum.

Social data:
- KOL wallet buys: {ctx.kol_buy_count} wallets
- Telegram mentions: {ctx.telegram_mentions}
- Twitter sentiment: {sentiment_label} ({ctx.twitter_sentiment:.2f})
- Narrative: "{ctx.narrative}"

Score this token 0–100 for social momentum quality.
- 90–100: Multiple credible KOLs buying, organic community, strong narrative
- 70–89:  Good social backing, credible sources, coherent narrative
- 50–69:  Mixed signals — some hype but unclear organic backing
- 30–49:  Weak social — likely coordinated pump or paid calls
- 0–29:   No credible social signals or clear bot/shill activity

Reply in exactly this format:
SCORE: <number 0-100>
REASON: <one sentence>"""
```
