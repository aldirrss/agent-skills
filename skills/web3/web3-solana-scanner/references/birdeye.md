# Birdeye

Birdeye has an **official API** with reliable uptime, better than GMGN for production use. Requires API key (free tier available). Best for: trending tokens, whale activity, token overview, price feeds.

API Key: set as env var `BIRDEYE_API_KEY`
Base URL: `https://public-api.birdeye.so`

## Setup

```python
BIRDEYE_HEADERS = {
    "X-API-KEY": os.environ["BIRDEYE_API_KEY"],
    "x-chain": "solana",
    "accept": "application/json",
}
```

## Trending Tokens (every 30s)

```python
async def poll_birdeye_trending(session: aiohttp.ClientSession, redis):
    url = "https://public-api.birdeye.so/defi/token_trending"
    params = {"sort_by": "volume1hUSD", "sort_type": "desc", "offset": 0, "limit": 50}
    try:
        async with session.get(
            url, params=params, headers=BIRDEYE_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                logger.warning(f"Birdeye trending {resp.status}")
                return
            data = await resp.json()
    except Exception as e:
        logger.warning(f"Birdeye trending failed: {e}")
        return

    for token in data.get("data", {}).get("items", []):
        mint = token.get("address", "")
        if not mint or await is_duplicate(redis, "birdeye_trending", mint, window_s=300):
            continue

        signal = TrendingSignal(
            mint=mint,
            symbol=token.get("symbol", "UNKNOWN"),
            source=SignalSource.BIRDEYE,
            volume_1h_usdc=float(token.get("volume1hUSD", 0)),
            price_change_1h_pct=float(token.get("priceChange1hPercent", 0)),
            liquidity_usdc=float(token.get("liquidity", 0)),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.trending", signal.model_dump_json())
```

## Token Overview (on-demand, for enrichment)

```python
async def get_birdeye_token_overview(
    session: aiohttp.ClientSession, redis, mint: str
) -> dict | None:
    cache_key = f"birdeye.overview.{mint}"
    cached = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    url = f"https://public-api.birdeye.so/defi/token_overview"
    params = {"address": mint}
    try:
        async with session.get(
            url, params=params, headers=BIRDEYE_HEADERS,
            timeout=aiohttp.ClientTimeout(total=8)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
    except Exception:
        return None

    overview = data.get("data")
    if overview:
        await redis.set(cache_key, json.dumps(overview), ex=60)
    return overview
```

## Whale Transactions (large buys by unknown wallets)

```python
async def poll_birdeye_whale_trades(session: aiohttp.ClientSession, redis, mint: str):
    url = "https://public-api.birdeye.so/defi/txs/token"
    params = {
        "address": mint,
        "tx_type": "swap",
        "sort_type": "desc",
        "limit": 20,
    }
    try:
        async with session.get(
            url, params=params, headers=BIRDEYE_HEADERS,
            timeout=aiohttp.ClientTimeout(total=8)
        ) as resp:
            data = await resp.json()
    except Exception:
        return

    for tx in data.get("data", {}).get("items", []):
        if tx.get("side") != "buy":
            continue
        volume_usd = float(tx.get("volumeUSD", 0))
        if volume_usd < 5_000:    # only care about $5k+ buys
            continue

        wallet = tx.get("owner", "")
        if await is_duplicate(redis, f"birdeye_whale.{mint}", wallet, window_s=300):
            continue

        signal = WalletBuySignal(
            wallet=wallet,
            wallet_label="birdeye_whale",
            mint=mint,
            symbol=tx.get("symbol", "UNKNOWN"),
            amount_sol=volume_usd / 150,  # rough USD→SOL estimate
            tx_signature=tx.get("txHash", ""),
            source=SignalSource.BIRDEYE,
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.wallet.buy", signal.model_dump_json())
```

## Key Birdeye Fields

```python
# token_trending item
{
    "address": "<mint>",
    "symbol": "BONK",
    "name": "Bonk",
    "liquidity": 450000,
    "volume1hUSD": 1200000,
    "volume24hUSD": 9800000,
    "priceChange1hPercent": 18.5,
    "priceChange24hPercent": 110.2,
    "trade1h": 1840,          # swap count in 1h
    "uniqueWallet1h": 620,    # unique wallets in 1h
}

# token_overview
{
    "address": "<mint>",
    "holder": 12400,
    "numberMarkets": 3,
    "mc": 1250000,            # market cap USD
    "supply": 1_000_000_000_000,
    "decimals": 5,
}
```

## Rate Limits

Free tier: 15 req/s. Starter ($99/mo): 50 req/s.

Always add 100ms delay between Birdeye calls in the same loop:
```python
await asyncio.sleep(0.1)
```
