# GMGN

GMGN provides trending tokens, smart wallet tracking, honeypot detection, and token safety scores. No official API key — uses public endpoints. Treat as **best-effort**: always fall back gracefully if unreachable.

Base URL: `https://gmgn.ai/defi/quotation/v1`

## Trending Tokens (every 60s)

```python
GMGN_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Referer": "https://gmgn.ai/",
    "Accept": "application/json",
}

async def poll_gmgn_trending(session: aiohttp.ClientSession, redis):
    url = "https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h"
    params = {
        "orderby": "swaps",
        "direction": "desc",
        "filters[]": "not_honeypot",
    }
    try:
        async with session.get(
            url, params=params, headers=GMGN_HEADERS,
            timeout=aiohttp.ClientTimeout(total=12)
        ) as resp:
            if resp.status != 200:
                logger.warning(f"GMGN trending returned {resp.status}")
                return
            data = await resp.json()
    except Exception as e:
        logger.warning(f"GMGN trending failed: {e} — skipping cycle")
        return

    tokens = data.get("data", {}).get("rank", [])
    for token in tokens[:50]:   # top 50 only
        mint = token.get("address", "")
        if not mint or await is_duplicate(redis, "gmgn_trending", mint, window_s=300):
            continue

        signal = TrendingSignal(
            mint=mint,
            symbol=token.get("symbol", "UNKNOWN"),
            source=SignalSource.GMGN,
            volume_1h_usdc=float(token.get("volume", 0)),
            price_change_1h_pct=float(token.get("price_change_percent", 0)),
            liquidity_usdc=float(token.get("liquidity", 0)),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.trending", signal.model_dump_json())
```

## Token Safety Info (on-demand)

Call before allowing a token through the safety gate. Cache result.

```python
async def get_gmgn_token_info(session: aiohttp.ClientSession, redis, mint: str) -> dict | None:
    cache_key = f"gmgn.token.{mint}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    url = f"https://gmgn.ai/defi/quotation/v1/tokens/sol/{mint}"
    try:
        async with session.get(
            url, headers=GMGN_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
    except Exception:
        return None

    token_data = data.get("data", {}).get("token")
    if token_data:
        await redis.set(cache_key, json.dumps(token_data), ex=120)
    return token_data
```

## Key GMGN Fields

```python
token = {
    "address": "<mint>",
    "symbol": "BONK",
    "price": 0.00001234,
    "volume": 1200000,          # USD volume 1h
    "swaps": 1840,              # swap count 1h
    "liquidity": 450000,
    "holder_count": 12400,
    "top10_holder_rate": 0.31,  # 0–1. Red flag if > 0.5
    "renounced": True,          # mint authority burned
    "is_honeypot": False,
    "is_open_source": True,
    "burn_ratio": 0.85,         # % of LP tokens burned
    "burn_status": "burn",      # "burn" | "unburn"
    "price_change_percent": 18.5,
    "price_change_percent5m": 2.1,
    "smart_degen_count": 4,     # # of smart wallets holding
    "rat_trader_amount_rate": 0.02,  # sniper/bot ratio — high = suspicious
}
```

## Smart Wallet Feed (alternative to KOL wallet polling)

GMGN tracks "smart money" wallets that consistently profit. Poll their recent buys:

```python
async def get_smart_wallet_buys(session: aiohttp.ClientSession, wallet: str) -> list[dict]:
    url = f"https://gmgn.ai/defi/quotation/v1/smartmoney/sol/walletNew/{wallet}"
    params = {"period": "7d", "orderby": "profit", "direction": "desc"}
    try:
        async with session.get(
            url, params=params, headers=GMGN_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json()
            return data.get("data", {}).get("activities", [])
    except Exception:
        return []
```

## Fallback Behavior

GMGN is an unofficial API — it may change or go down. Always treat it as optional enrichment:

```python
async def get_gmgn_safety_fields(session, redis, mint) -> dict:
    data = await get_gmgn_token_info(session, redis, mint)
    if data is None:
        # return safe defaults — do not block trade on GMGN unavailability
        return {
            "is_honeypot": False,
            "top10_holder_rate": None,  # unknown
            "renounced": None,
        }
    return {
        "is_honeypot": data.get("is_honeypot", False),
        "top10_holder_rate": data.get("top10_holder_rate"),
        "renounced": data.get("renounced"),
    }
```

If `top10_holder_rate` or `renounced` is `None` (GMGN unavailable), skip those checks rather than blocking all trades.
