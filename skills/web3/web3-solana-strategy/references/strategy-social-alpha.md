# Strategy: Social Alpha

Enter when a token receives coordinated social attention — Telegram alpha call confirmed by Twitter mention spike AND on-chain volume. Highest noise, requires strictest threshold.

**Anchor:** `telegram_alpha` + `twitter_spike` (both required)
**Min Score:** 75 (highest threshold — social signals are noisy)
**Signal Window:** 900s (15 min)
**Risk Level:** High

## Why Strictest Threshold

- Telegram channels are paid pump groups 80% of the time
- Twitter spikes can be bot-driven
- Social Alpha only works when social + on-chain data agrees
- Position size is 50% of normal (same as New Launch Snipe)

## Logic Flow

```
telegram alpha call → add telegram_alpha signal
    +
Twitter mention spike → add twitter_spike signal
    +
On-chain volume confirmation (GMGN or Birdeye trending)
    ↓
All three present within 15 min window?
    ↓ Yes
Safety check (strict: require rugcheck score ≥ 80)
    ↓ Pass
Score ≥ 75? → BUY
```

## Implementation

```python
async def social_alpha_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe(
        "scanner.token.new",        # telegram mint call
        "scanner.token.trending",   # twitter spike + volume
        "scanner.social.kol_mention",    # KOL Twitter mention
        "scanner.social.telegram_mention",  # telegram cashtag (no mint yet)
    )

    # symbol → mint lookup cache (enriched from DEXScreener)
    symbol_mint_cache: dict[str, str] = {}

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        channel = message["channel"].decode()
        data = json.loads(message["data"])

        if channel == "scanner.token.new" and data.get("source") == "telegram":
            mint = data.get("mint", "")
            if not mint:
                continue
            buffer.add(mint, "telegram_alpha", SIGNAL_WEIGHTS["telegram_alpha"], data)
            symbol_mint_cache[data.get("symbol", "")] = mint

        elif channel == "scanner.social.telegram_mention":
            # symbol-only signal — look up mint
            symbol = data.get("symbol", "")
            mint = symbol_mint_cache.get(symbol, "")
            if not mint:
                # try DEXScreener lookup
                mint = await resolve_symbol_to_mint(session, redis, symbol)
                if mint:
                    symbol_mint_cache[symbol] = mint
            if mint:
                buffer.add(mint, "telegram_alpha", SIGNAL_WEIGHTS["telegram_alpha"], data)

        elif channel == "scanner.token.trending":
            source = data.get("source", "")
            mint = data.get("mint", "")
            if not mint:
                continue
            weight_key = {
                "twitter": "twitter_spike",
                "gmgn": "gmgn_trending",
                "birdeye": "birdeye_trending",
                "dexscreener": "dexscreener_volume",
            }.get(source)
            if weight_key:
                buffer.add(mint, weight_key, SIGNAL_WEIGHTS[weight_key], data)

        elif channel == "scanner.social.kol_mention":
            symbol = data.get("symbol", "")
            mint = symbol_mint_cache.get(symbol, "")
            if mint:
                buffer.add(mint, "twitter_spike", SIGNAL_WEIGHTS["twitter_spike"], data)

        # check for both anchors
        for mint in list(buffer._buffer.keys()):
            has_telegram = buffer.has_source(mint, "telegram_alpha", 900)
            has_twitter = buffer.has_source(mint, "twitter_spike", 900)
            if not (has_telegram and has_twitter):
                continue

            if await is_signal_on_cooldown(redis, "social_alpha", mint):
                continue

            # strict safety: require rugcheck score ≥ 80
            safety = await run_full_safety_check_cached(session, redis, mint)
            if not safety.safe:
                continue
            report = await get_rugcheck_report(session, redis, mint)
            if report and report.get("score_normalised", 0) < 80:
                logger.debug(f"Social alpha rugcheck too low for {mint[:8]}")
                continue

            symbol = buffer.get_active(mint, 900)[0].raw.get("symbol", "UNKNOWN")
            ready = await evaluate_confluence(
                mint=mint,
                symbol=symbol,
                buffer=buffer,
                strategy_name="social_alpha",
                anchor_source="telegram_alpha",
                window_s=900,
                min_score=75,
                redis=redis,
            )
            if not ready:
                continue

            pair = await get_cached_pair(session, redis, mint)
            active = buffer.get_active(mint, 900)
            await publish_buy_signal(
                mint=mint,
                symbol=symbol,
                score=sum(s.score for s in active),
                sources=list({s.source for s in active}),
                strategy="social_alpha",
                price_usdc=pair.get("priceUsd", "0") if pair else "0",
                liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)) if pair else 0,
                redis=redis,
            )
            buffer.clear(mint)
```

## Score Paths

Both anchors combined = 10+15=25. Need 50 more for threshold of 75:

| Path | Total | Result |
|---|---|---|
| Telegram + Twitter only | 10+15=25 | Not enough |
| + KOL wallet | 25+40=65 | Not enough |
| + KOL + GMGN | 25+40+25=90 | BUY ✓ |
| + GMGN + Birdeye + DEXScreener | 25+25+20+20=90 | BUY ✓ |
| + KOL + Birdeye | 25+40+20=85 | BUY ✓ |

Social Alpha **requires on-chain confirmation** (GMGN/Birdeye/DEXScreener) — pure social is never enough.

## Symbol → Mint Resolution

Telegram often posts `$SYMBOL` without the mint address. Resolve via DEXScreener search:

```python
async def resolve_symbol_to_mint(session, redis, symbol: str) -> str | None:
    cache_key = f"symbol.mint.{symbol.upper()}"
    cached = await redis.get(cache_key)
    if cached:
        return cached.decode()

    url = f"https://api.dexscreener.com/latest/dex/search?q={symbol}"
    async with session.get(url, timeout=aiohttp.ClientTimeout(total=8)) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()

    pairs = [
        p for p in (data.get("pairs") or [])
        if p.get("chainId") == "solana"
        and p.get("baseToken", {}).get("symbol", "").upper() == symbol.upper()
    ]
    if not pairs:
        return None

    best = max(pairs, key=lambda p: float(p.get("liquidity", {}).get("usd", 0)))
    mint = best["baseToken"]["address"]
    await redis.set(cache_key, mint, ex=3600)
    return mint
```

## Channel Quality Tracking

Track which Telegram channels produce profitable signals vs noise:

```python
# After each Social Alpha trade closes, DBWriter records:
# channel → win/loss
# Periodically review: disable channels with <40% hit rate
await redis.hincrby(f"stats.telegram.channel.{channel_name}", "total", 1)
# on profitable close:
await redis.hincrby(f"stats.telegram.channel.{channel_name}", "wins", 1)
```
