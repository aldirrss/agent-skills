# Strategy: Momentum / Volume Spike

Buy tokens showing sudden volume surge and price momentum across multiple on-chain data sources. No KOL wallet required — pure on-chain signal.

**Anchor:** `gmgn_trending` AND `dexscreener_volume` (both required)
**Min Score:** 60
**Signal Window:** 300s (5 min)
**Risk Level:** Medium

## Logic Flow

```
scanner.token.trending received (source=gmgn OR dexscreener OR birdeye)
    ↓
Volume spike check: volume_1h > baseline × spike_multiplier?
    ↓ Yes
Price change check: price_change_1h > MIN_PRICE_CHANGE_PCT?
    ↓ Yes
Add to buffer by source
    ↓
Both gmgn AND dexscreener present in buffer?
    ↓ Yes (double anchor requirement)
Safety check
    ↓ Pass
Score ≥ 60? → BUY
```

## Implementation

```python
# Momentum-specific thresholds
MOMENTUM_MIN_VOLUME_1H = 50_000      # $50k min volume in last 1h
MOMENTUM_MIN_PRICE_CHANGE = 10.0     # +10% minimum in 1h
MOMENTUM_SPIKE_MULTIPLIER = 3.0      # volume must be 3x the token's recent average

async def momentum_spike_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe("scanner.token.trending")

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        data = json.loads(message["data"])
        mint = data.get("mint", "")
        source = data.get("source", "")
        if not mint:
            continue

        volume_1h = float(data.get("volume_1h_usdc", 0))
        price_change_1h = float(data.get("price_change_1h_pct", 0))

        # momentum filters
        if volume_1h < MOMENTUM_MIN_VOLUME_1H:
            continue
        if price_change_1h < MOMENTUM_MIN_PRICE_CHANGE:
            continue
        # reject dump: price going down is not momentum
        if price_change_1h < 0:
            continue

        weight_key = {
            "gmgn": "gmgn_trending",
            "birdeye": "birdeye_trending",
            "dexscreener": "dexscreener_volume",
            "twitter": "twitter_spike",
        }.get(source)
        if not weight_key:
            continue

        buffer.add(mint, weight_key, SIGNAL_WEIGHTS[weight_key], data)

        # double anchor: both gmgn AND dexscreener must be present
        has_gmgn = buffer.has_source(mint, "gmgn_trending", 300)
        has_dex = buffer.has_source(mint, "dexscreener_volume", 300)
        if not (has_gmgn and has_dex):
            continue

        if await is_signal_on_cooldown(redis, "momentum_spike", mint):
            continue

        safety = await run_full_safety_check_cached(session, redis, mint)
        if not safety.safe:
            continue

        ready = await evaluate_confluence(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            buffer=buffer,
            strategy_name="momentum_spike",
            anchor_source="gmgn_trending",   # primary anchor
            window_s=300,
            min_score=60,
            redis=redis,
        )
        if not ready:
            continue

        pair = await get_cached_pair(session, redis, mint)
        active = buffer.get_active(mint, 300)
        await publish_buy_signal(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            score=sum(s.score for s in active),
            sources=[s.source for s in active],
            strategy="momentum_spike",
            price_usdc=pair.get("priceUsd", "0") if pair else "0",
            liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)) if pair else 0,
            redis=redis,
        )
        buffer.clear(mint)
```

## Buy/Sell Ratio Gate

Momentum strategy adds an extra check: buy transactions must significantly outnumber sells.

```python
async def check_buy_sell_momentum(session, redis, mint: str) -> bool:
    pair = await get_cached_pair(session, redis, mint)
    if not pair:
        return False
    txns = pair.get("txns", {}).get("h1", {})
    buys = txns.get("buys", 0)
    sells = txns.get("sells", 1)
    ratio = buys / max(sells, 1)
    if ratio < 2.0:   # buys must be 2x sells for momentum confirmation
        logger.debug(f"Momentum buy/sell ratio too low: {ratio:.2f} for {mint[:8]}")
        return False
    return True
```

## Score Paths

Double anchor (gmgn=25 + dex=20) = 45 base. Need 15 more:

| Path | Total | Result |
|---|---|---|
| GMGN + DEXScreener only | 25+20=45 | Not enough |
| + Birdeye | 45+20=65 | BUY ✓ |
| + Twitter | 45+15=60 | BUY ✓ (exactly threshold) |
| + Birdeye + Twitter | 45+20+15=80 | BUY ✓ (strong) |
| + KOL wallet | 45+40=85 | BUY ✓ (very strong) |

## Avoiding False Momentum

Momentum signals can be wash trading or coordinated pump. Additional guards:

```python
# Token must be older than 24h for momentum strategy
# (new tokens always show "momentum" just from launch hype)
async def check_token_age_for_momentum(pair_data: dict) -> bool:
    created_at = pair_data.get("pairCreatedAt", 0)
    age_hours = (time.time() * 1000 - created_at) / 3_600_000
    return age_hours >= 24
```
