# DEXScreener

Free, no API key. Best for new pair discovery and basic token metrics.

Base URL: `https://api.dexscreener.com`

## New Pairs Poller (every 10s)

```python
async def poll_new_pairs(session: aiohttp.ClientSession, redis, min_liquidity: float = 10_000):
    url = "https://api.dexscreener.com/token-profiles/latest/v1"
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
        if resp.status != 200:
            return
        data = await resp.json()

    for token in data:
        if token.get("chainId") != "solana":
            continue

        mint = token.get("tokenAddress", "")
        if not mint:
            continue

        if await is_duplicate(redis, "dexscreener_new", mint, window_s=3600):
            continue

        signal = NewTokenSignal(
            mint=mint,
            symbol=token.get("symbol", "UNKNOWN"),
            source=SignalSource.DEXSCREENER,
            liquidity_usdc=float(token.get("liquidity", 0)),
            age_seconds=_calc_age(token.get("pairCreatedAt")),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.new", signal.model_dump_json())
```

## Trending Poller (every 30s)

```python
async def poll_trending(session: aiohttp.ClientSession, redis):
    url = "https://api.dexscreener.com/token-boosts/top/v1"
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
        if resp.status != 200:
            return
        data = await resp.json()

    for token in data:
        if token.get("chainId") != "solana":
            continue
        mint = token.get("tokenAddress", "")
        if not mint or await is_duplicate(redis, "dexscreener_trending", mint, window_s=300):
            continue

        # fetch full pair data for this mint
        pair = await get_pair_by_mint(session, mint)
        if not pair:
            continue

        signal = TrendingSignal(
            mint=mint,
            symbol=pair.get("baseToken", {}).get("symbol", "UNKNOWN"),
            source=SignalSource.DEXSCREENER,
            volume_1h_usdc=float(pair.get("volume", {}).get("h1", 0)),
            price_change_1h_pct=float(pair.get("priceChange", {}).get("h1", 0)),
            liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.trending", signal.model_dump_json())
```

## Get Pair by Mint

```python
async def get_pair_by_mint(session: aiohttp.ClientSession, mint: str) -> dict | None:
    url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
    pairs = data.get("pairs") or []
    if not pairs:
        return None
    # pick highest liquidity pair
    return max(pairs, key=lambda p: float(p.get("liquidity", {}).get("usd", 0)))
```

## Key Fields Reference

```python
pair = {
    "baseToken": {"address": "<mint>", "symbol": "BONK", "name": "Bonk"},
    "priceUsd": "0.00001234",
    "priceNative": "0.0000000812",    # price in SOL
    "liquidity": {"usd": 450000, "base": 18000000000, "quote": 225000},
    "volume": {"m5": 12000, "h1": 120000, "h6": 800000, "h24": 3200000},
    "priceChange": {"m5": 2.1, "h1": 18.5, "h6": 42.1, "h24": 110.0},
    "txns": {
        "m5":  {"buys": 45, "sells": 12},
        "h1":  {"buys": 340, "sells": 120},
        "h24": {"buys": 2800, "sells": 1100},
    },
    "pairCreatedAt": 1718000000000,   # ms timestamp
    "dexId": "raydium",
    "url": "https://dexscreener.com/solana/...",
}
```

## Rate Limits & Error Handling

- No official rate limit published — stay under ~300 req/min per IP
- Add 200ms minimum between calls in the same polling loop
- On 429: back off 30s, log warning, skip this cycle
- On timeout/connection error: log warning, skip this cycle (do NOT retry immediately)

```python
async def safe_get(session, url, **kwargs) -> dict | None:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10), **kwargs) as resp:
            if resp.status == 429:
                logger.warning("DEXScreener rate limited — backing off 30s")
                await asyncio.sleep(30)
                return None
            if resp.status != 200:
                return None
            return await resp.json()
    except (aiohttp.ClientError, asyncio.TimeoutError) as e:
        logger.warning(f"DEXScreener request failed: {e}")
        return None
```

## Helper

```python
def _calc_age(created_at_ms: int | None) -> float:
    if not created_at_ms:
        return 999999
    return (time.time() * 1000 - created_at_ms) / 1000
```
