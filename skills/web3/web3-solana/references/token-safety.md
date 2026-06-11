# Token Safety

Rugpull detection, honeypot checks, and liquidity validation before any BUY.

## The Safety Gate

Every BUY signal must pass ALL checks before reaching RiskManager. Fail any single check → reject the trade.

```python
from dataclasses import dataclass

@dataclass
class TokenSafetyResult:
    safe: bool
    reason: str | None  # populated when safe=False

async def check_token_safety(
    mint: str,
    dexscreener_data: dict,
    gmgn_data: dict | None,
) -> TokenSafetyResult:
    checks = [
        _check_min_liquidity(dexscreener_data),
        _check_top_holder_concentration(gmgn_data),
        _check_honeypot(gmgn_data),
        _check_mint_authority(gmgn_data),
        _check_token_age(dexscreener_data),
        _check_buy_sell_ratio(dexscreener_data),
    ]
    for result in checks:
        if not result.safe:
            return result
    return TokenSafetyResult(safe=True, reason=None)
```

## Individual Checks

### Minimum Liquidity
```python
MIN_LIQUIDITY_USDC = 30_000  # configurable via config.risk

def _check_min_liquidity(data: dict) -> TokenSafetyResult:
    liquidity = float(data.get("liquidity", {}).get("usd", 0))
    if liquidity < MIN_LIQUIDITY_USDC:
        return TokenSafetyResult(False, f"liquidity too low: ${liquidity:.0f}")
    return TokenSafetyResult(True, None)
```

Low liquidity means: easy to manipulate price, high slippage, hard to exit.

### Top Holder Concentration
```python
MAX_TOP10_HOLDER_RATE = 0.50  # fail if top 10 hold >50% of supply

def _check_top_holder_concentration(gmgn_data: dict | None) -> TokenSafetyResult:
    if gmgn_data is None:
        return TokenSafetyResult(True, None)  # skip if GMGN unavailable
    rate = gmgn_data.get("top10_holder_rate", 0)
    if rate > MAX_TOP10_HOLDER_RATE:
        return TokenSafetyResult(False, f"top10 holders control {rate*100:.0f}% of supply")
    return TokenSafetyResult(True, None)
```

High concentration = coordinated dump risk.

### Honeypot Detection
```python
def _check_honeypot(gmgn_data: dict | None) -> TokenSafetyResult:
    if gmgn_data is None:
        return TokenSafetyResult(True, None)
    if gmgn_data.get("is_honeypot", False):
        return TokenSafetyResult(False, "honeypot detected by GMGN")
    return TokenSafetyResult(True, None)
```

A honeypot allows buys but blocks sells at the contract level.

### Mint Authority
```python
def _check_mint_authority(gmgn_data: dict | None) -> TokenSafetyResult:
    if gmgn_data is None:
        return TokenSafetyResult(True, None)
    # renounced=True means mint authority is burned — supply is fixed
    if not gmgn_data.get("renounced", False):
        # dev can still mint new tokens — dilution/rug risk
        # this is a warning, not a hard block — configurable
        return TokenSafetyResult(False, "mint authority not renounced")
    return TokenSafetyResult(True, None)
```

### Token Age (Anti-snipe on brand-new tokens)
```python
MIN_TOKEN_AGE_SECONDS = 300  # 5 minutes — skip tokens less than 5 min old

def _check_token_age(data: dict) -> TokenSafetyResult:
    created_at_ms = data.get("pairCreatedAt", 0)
    if created_at_ms == 0:
        return TokenSafetyResult(True, None)
    age_seconds = (time.time() * 1000 - created_at_ms) / 1000
    if age_seconds < MIN_TOKEN_AGE_SECONDS:
        return TokenSafetyResult(False, f"token too new: {age_seconds:.0f}s old")
    return TokenSafetyResult(True, None)
```

Adjustable via config. New-launch sniper bots set this to 0 — understand the risk.

### Buy/Sell Ratio (pump detection)
```python
MIN_BUY_SELL_RATIO = 1.5  # buys should outweigh sells

def _check_buy_sell_ratio(data: dict) -> TokenSafetyResult:
    txns_1h = data.get("txns", {}).get("h1", {})
    buys = txns_1h.get("buys", 0)
    sells = txns_1h.get("sells", 1)
    ratio = buys / max(sells, 1)
    if ratio < MIN_BUY_SELL_RATIO:
        return TokenSafetyResult(False, f"buy/sell ratio too low: {ratio:.2f}")
    return TokenSafetyResult(True, None)
```

## Configurable Thresholds

All thresholds should live in `config.risk` (Redis key), not hardcoded beyond the defaults:

```json
{
  "min_liquidity_usdc": 30000,
  "max_top10_holder_rate": 0.50,
  "min_token_age_seconds": 300,
  "min_buy_sell_ratio": 1.5,
  "require_renounced": true
}
```

Load at startup via `pydantic` model. Validate ranges at load time (e.g. `min_liquidity_usdc` cannot be 0).

## Logging Safety Rejections

Every rejected token must be logged with the reason — for post-analysis:

```python
if not safety.safe:
    logger.warning(f"SAFETY_REJECT mint={mint} symbol={symbol} reason={safety.reason}")
    await redis.incr(f"stats.rejected.{safety.reason.split(':')[0]}")
```

This builds a rejection histogram in Redis for tuning thresholds over time.
