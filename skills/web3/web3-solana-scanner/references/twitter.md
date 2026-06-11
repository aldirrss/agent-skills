# Twitter/X Social Signals

Monitor Twitter/X for token mention spikes. A sudden surge in mentions of a token symbol or mint address can precede a price pump. Requires Twitter API v2 (Basic tier minimum, ~$100/mo).

API Key: `TWITTER_BEARER_TOKEN` env var

## Recent Search (every 60s)

```python
TWITTER_HEADERS = {
    "Authorization": f"Bearer {os.environ.get('TWITTER_BEARER_TOKEN', '')}",
}

async def poll_twitter_mentions(
    session: aiohttp.ClientSession, redis,
    tracked_tokens: list[dict],  # list of {mint, symbol}
):
    for token in tracked_tokens:
        symbol = token["symbol"]
        mint = token["mint"]

        count = await _get_mention_count(session, symbol)
        if count is None:
            continue

        prev_key = f"twitter.count.{mint}"
        prev = int(await redis.get(prev_key) or 0)
        await redis.set(prev_key, count, ex=3600)

        if prev == 0:
            continue  # no baseline yet

        growth_pct = (count - prev) / max(prev, 1) * 100
        if growth_pct >= 100:    # mentions doubled in last hour
            signal = TrendingSignal(
                mint=mint,
                symbol=symbol,
                source=SignalSource.TWITTER,
                volume_1h_usdc=0,   # not applicable for social signals
                price_change_1h_pct=0,
                liquidity_usdc=0,
                ts=int(time.time() * 1000),
            )
            await redis.publish("scanner.token.trending", signal.model_dump_json())
            logger.info(f"Twitter spike: ${symbol} mentions +{growth_pct:.0f}% in 1h")

        await asyncio.sleep(1)  # rate limit: 1 search per second on Basic tier

async def _get_mention_count(session, symbol: str) -> int | None:
    url = "https://api.twitter.com/2/tweets/counts/recent"
    params = {
        "query": f"${symbol} lang:en -is:retweet",
        "granularity": "hour",
    }
    try:
        async with session.get(
            url, params=params, headers=TWITTER_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            total = data.get("meta", {}).get("total_tweet_count", 0)
            return total
    except Exception as e:
        logger.debug(f"Twitter count failed for ${symbol}: {e}")
        return None
```

## Tweet Search (find specific mentions)

```python
async def search_recent_tweets(
    session: aiohttp.ClientSession, query: str, max_results: int = 10
) -> list[dict]:
    url = "https://api.twitter.com/2/tweets/search/recent"
    params = {
        "query": query,
        "max_results": max_results,
        "tweet.fields": "created_at,author_id,public_metrics",
        "sort_order": "recency",
    }
    try:
        async with session.get(
            url, params=params, headers=TWITTER_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json()
            return data.get("data", [])
    except Exception:
        return []
```

## KOL Twitter Tracking

If you know the Twitter handles of KOL traders, track their tweets for token mentions:

```python
async def poll_kol_tweets(session: aiohttp.ClientSession, redis, kol_handle: str):
    query = f"from:{kol_handle} ($) lang:en -is:retweet"
    tweets = await search_recent_tweets(session, query, max_results=5)
    for tweet in tweets:
        tweet_id = tweet["id"]
        if await redis.get(f"twitter.seen.{tweet_id}"):
            continue
        await redis.set(f"twitter.seen.{tweet_id}", "1", ex=86400)

        text = tweet.get("text", "")
        # extract cashtags ($SYMBOL) from tweet
        symbols = re.findall(r'\$([A-Z]{2,10})', text.upper())
        for symbol in symbols:
            logger.info(f"KOL @{kol_handle} tweeted about ${symbol}")
            # publish as social trending signal (Strategy will look up mint by symbol)
            await redis.publish("scanner.social.kol_mention", json.dumps({
                "kol_handle": kol_handle,
                "symbol": symbol,
                "tweet_id": tweet_id,
                "ts": int(time.time() * 1000),
            }))
```

## Rate Limits

| Tier | Monthly tweets | Search calls/15min |
|---|---|---|
| Free | 500 read | 1 |
| Basic ($100/mo) | 10,000 read | 15 |
| Pro ($5,000/mo) | 1M read | 300 |

For most bots, Basic tier ($100/mo) is sufficient. Free tier is too limited for real-time monitoring.

## Fallback

If `TWITTER_BEARER_TOKEN` is not set, skip Twitter polling entirely — log at startup:

```python
if not os.environ.get("TWITTER_BEARER_TOKEN"):
    logger.info("Twitter monitoring disabled (no TWITTER_BEARER_TOKEN)")
    return
```

Twitter is an enrichment signal, not a core requirement. Bot should work without it.
