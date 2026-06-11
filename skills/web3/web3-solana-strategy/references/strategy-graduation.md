# Strategy: Graduation Trade

Buy tokens that have just graduated from Pump.fun bonding curve to Raydium. Graduation means the token reached ~$69k market cap — it has proven demand. Lower risk than raw new launch snipe.

**Anchor:** `pumpfun_graduation`
**Min Score:** 55
**Signal Window:** 600s (10 min)
**Risk Level:** Medium-High

## Why Graduation Matters

When a Pump.fun token graduates:
- ~$12k SOL (~$69k) was spent buying into the bonding curve — real demand proven
- Liquidity is automatically added to Raydium — tradeable immediately
- Early bonding curve buyers can now sell — creates initial sell pressure
- Optimal entry window: 2–10 minutes after graduation, after first wave of profit-taking

## Logic Flow

```
scanner.token.new received (source=pumpfun, graduation=true)
    ↓
Safety check (top holders, honeypot, rugcheck)
    ↓ Pass
Add anchor: source=pumpfun_graduation, score=30
    ↓
Wait up to 10 min for enrichment
    ↓
Score ≥ 55? → BUY
```

## Implementation

```python
async def graduation_trade_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe(
        "scanner.token.new",
        "scanner.wallet.buy",
        "scanner.token.trending",
    )

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        channel = message["channel"].decode()
        data = json.loads(message["data"])
        mint = data.get("mint", "")
        if not mint:
            continue

        if channel == "scanner.token.new":
            source = data.get("source", "")
            # only care about Pump.fun graduated tokens
            if source != "pumpfun":
                continue
            # Scanner sets a "graduated" flag for these signals
            if not data.get("graduated", False):
                continue

            safety = await run_full_safety_check_cached(session, redis, mint)
            if not safety.safe:
                logger.debug(f"GRADUATION safety reject: {mint[:8]} — {safety.reason}")
                continue

            buffer.add(mint, "pumpfun_graduation", SIGNAL_WEIGHTS["pumpfun_graduation"], data)
            logger.info(f"Graduation detected: {data.get('symbol')} {mint[:8]}")

        elif channel == "scanner.wallet.buy":
            signal_data = json.loads(message["data"])
            wallet = signal_data.get("wallet", "")
            if await redis.sismember("state.kol.wallets", wallet):
                buffer.add(mint, "kol_wallet", SIGNAL_WEIGHTS["kol_wallet"], signal_data)

        elif channel == "scanner.token.trending":
            source = data.get("source", "")
            weight_key = {
                "gmgn": "gmgn_trending",
                "birdeye": "birdeye_trending",
                "dexscreener": "dexscreener_volume",
            }.get(source)
            if weight_key:
                buffer.add(mint, weight_key, SIGNAL_WEIGHTS[weight_key], data)

        # anchor must exist before evaluating
        if not buffer.has_source(mint, "pumpfun_graduation", 600):
            continue

        if await is_signal_on_cooldown(redis, "graduation_trade", mint):
            continue

        ready = await evaluate_confluence(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            buffer=buffer,
            strategy_name="graduation_trade",
            anchor_source="pumpfun_graduation",
            window_s=600,
            min_score=55,
            redis=redis,
        )
        if not ready:
            continue

        pair = await get_cached_pair(session, redis, mint)
        active = buffer.get_active(mint, 600)
        await publish_buy_signal(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            score=sum(s.score for s in active),
            sources=[s.source for s in active],
            strategy="graduation_trade",
            price_usdc=pair.get("priceUsd", "0") if pair else "0",
            liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)) if pair else 0,
            redis=redis,
        )
        buffer.clear(mint)
```

## Graduation Score Paths

`pumpfun_graduation` = 30 pts. Need 25 more to reach threshold of 55:

| Path | Total | Result |
|---|---|---|
| Graduation only | 30 | Not enough |
| Graduation + GMGN | 30+25=55 | BUY ✓ |
| Graduation + Birdeye | 30+20=50 | Not enough |
| Graduation + Birdeye + Twitter | 30+20+15=65 | BUY ✓ |
| Graduation + KOL | 30+40=70 | BUY ✓ (strong) |
| Graduation + DEXScreener | 30+20=50 | Not enough |
| Graduation + DEXScreener + Twitter | 30+20+15=65 | BUY ✓ |

## Graduation-Specific Safety Check

After graduation, additionally check:
- LP tokens locked (should be auto-locked by Pump.fun mechanism — verify via Rugcheck)
- Token age on bonding curve ≥ 1 hour (fast graduations = coordinated pump risk)

```python
async def graduation_extra_checks(session, redis, mint: str, signal_data: dict) -> bool:
    # bonding curve age check
    age_s = float(signal_data.get("age_seconds", 0))
    if age_s < 3600:   # less than 1 hour on bonding curve
        logger.warning(f"Fast graduation warning: {mint[:8]} aged only {age_s:.0f}s")
        # don't block — just warn. Some legitimate tokens graduate fast with strong community

    report = await get_rugcheck_report(session, redis, mint)
    if report:
        for market in report.get("markets", []):
            lp_locked = market.get("lp", {}).get("lpLocked", 0)
            if lp_locked < 0.8:   # Pump.fun should lock ~100% LP
                logger.warning(f"Graduation LP only {lp_locked*100:.0f}% locked: {mint[:8]}")
                return False
    return True
```
