# Rugcheck

Rugcheck provides token safety scores for Solana tokens. Free API, no key required. Use as an additional safety gate after DEXScreener/GMGN checks.

Base URL: `https://api.rugcheck.xyz/v1`

## Token Report

```python
async def get_rugcheck_report(
    session: aiohttp.ClientSession, redis, mint: str
) -> dict | None:
    cache_key = f"rugcheck.report.{mint}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    url = f"https://api.rugcheck.xyz/v1/tokens/{mint}/report/summary"
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
    except Exception as e:
        logger.debug(f"Rugcheck failed for {mint[:8]}: {e}")
        return None

    await redis.set(cache_key, json.dumps(data), ex=300)   # cache 5 min
    return data
```

## Key Fields

```python
{
    "mint": "<mint_address>",
    "score": 8500,          # 0–10000. Higher = safer
    "score_normalised": 85, # 0–100
    "risks": [
        {
            "name": "Low Liquidity",
            "value": "$12,400",
            "description": "...",
            "score": 2000,
            "level": "warn",    # "warn" | "danger" | "info"
        },
        {
            "name": "Mintable",
            "value": "",
            "description": "Token can be minted by the authority",
            "score": 5000,
            "level": "danger",
        },
    ],
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "token": {
        "mintAuthority": None,   # None = renounced
        "freezeAuthority": None,
        "supply": 1000000000,
        "decimals": 9,
        "isInitialized": True,
    },
    "markets": [
        {
            "pubkey": "<pool_address>",
            "marketType": "raydium",
            "lp": {
                "lpLocked": 0.95,      # 95% LP tokens locked — good
                "lpLockedUSD": 425000,
            }
        }
    ]
}
```

## Safety Decision from Rugcheck

```python
MIN_RUGCHECK_SCORE = 70   # from config.risk

def evaluate_rugcheck(report: dict | None) -> tuple[bool, str | None]:
    """Returns (is_safe, reason_if_not)"""
    if report is None:
        return True, None   # unavailable — don't block on it

    score = report.get("score_normalised", 100)
    if score < MIN_RUGCHECK_SCORE:
        return False, f"rugcheck score too low: {score}/100"

    # check for explicit danger risks
    for risk in report.get("risks", []):
        if risk.get("level") == "danger":
            name = risk.get("name", "unknown")
            return False, f"rugcheck danger: {name}"

    # check LP lock
    markets = report.get("markets", [])
    for market in markets:
        lp_locked = market.get("lp", {}).get("lpLocked", 1.0)
        if lp_locked < 0.5:   # less than 50% LP locked
            return False, f"LP only {lp_locked*100:.0f}% locked"

    return True, None
```

## Integration in Safety Gate

```python
async def run_full_safety_check(session, redis, mint, dex_data, gmgn_data) -> TokenSafetyResult:
    # 1. Basic checks (liquidity, honeypot, holder concentration)
    basic = await check_token_safety(mint, dex_data, gmgn_data)
    if not basic.safe:
        return basic

    # 2. Rugcheck (additional layer)
    report = await get_rugcheck_report(session, redis, mint)
    safe, reason = evaluate_rugcheck(report)
    if not safe:
        return TokenSafetyResult(safe=False, reason=reason)

    return TokenSafetyResult(safe=True, reason=None)
```

## Notes

- Rugcheck scores can be slow to update for very new tokens — scores may be unavailable for tokens <30 min old
- If score is unavailable (None returned), pass the token through — rely on GMGN + DEXScreener checks instead
- High score does NOT guarantee safety — it reduces risk, not eliminates it
