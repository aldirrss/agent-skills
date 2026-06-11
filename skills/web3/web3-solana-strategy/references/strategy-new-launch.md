# Strategy: New Launch Snipe

Buy tokens very early after launch on Pump.fun or Raydium. High risk, high reward. Requires strict safety filters and fast execution.

**Anchor:** `pumpfun_new`
**Min Score:** 65 (higher threshold — new tokens are riskier)
**Signal Window:** 60s (act fast or miss the entry)
**Risk Level:** Very High

## Logic Flow

```
scanner.token.new received (source=pumpfun or dexscreener)
    ↓
Token age ≥ MIN_TOKEN_AGE_SECONDS (config, default 300s)?
    ↓ Yes
Liquidity ≥ min threshold?
    ↓ Yes
Safety check (honeypot, top holder, rugcheck)
    ↓ Pass
Add to buffer: source=pumpfun_new, score=15
    ↓
Wait for enrichment in 60s window
    ↓
Score ≥ 65? → No: ignore (too risky without confirmation)
    ↓ Yes
Publish BUY
```

## Implementation

```python
async def new_launch_snipe_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe(
        "scanner.token.new",
        "scanner.wallet.buy",       # KOL buying new token = strong enrichment
        "scanner.token.trending",   # trending within 60s = volume confirmed
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
            if source not in ("pumpfun", "dexscreener"):
                continue

            age_s = float(data.get("age_seconds", 0))
            min_age = int(await redis.get("config.risk.min_token_age_seconds") or 300)
            if age_s < min_age:
                continue

            liquidity = float(data.get("liquidity_usdc", 0))
            min_liq = float(await redis.get("config.risk.min_liquidity_usdc") or 30_000)
            if liquidity < min_liq:
                continue

            safety = await run_full_safety_check_cached(session, redis, mint)
            if not safety.safe:
                continue

            buffer.add(mint, "pumpfun_new", SIGNAL_WEIGHTS["pumpfun_new"], data)

        elif channel == "scanner.wallet.buy":
            signal = WalletBuySignal.model_validate(data)
            if await redis.sismember("state.kol.wallets", signal.wallet):
                buffer.add(mint, "kol_wallet", SIGNAL_WEIGHTS["kol_wallet"], data)

        elif channel == "scanner.token.trending":
            source = data.get("source", "")
            weight_key = {"gmgn": "gmgn_trending", "birdeye": "birdeye_trending",
                          "dexscreener": "dexscreener_volume"}.get(source)
            if weight_key:
                buffer.add(mint, weight_key, SIGNAL_WEIGHTS[weight_key], data)

        # evaluate after every signal update
        if not buffer.has_source(mint, "pumpfun_new", 60):
            continue   # anchor missing

        if await is_signal_on_cooldown(redis, "new_launch_snipe", mint):
            continue

        ready = await evaluate_confluence(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            buffer=buffer,
            strategy_name="new_launch_snipe",
            anchor_source="pumpfun_new",
            window_s=60,
            min_score=65,
            redis=redis,
        )
        if not ready:
            continue

        pair = await get_cached_pair(session, redis, mint)
        active = buffer.get_active(mint, 60)
        await publish_buy_signal(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            score=sum(s.score for s in active),
            sources=[s.source for s in active],
            strategy="new_launch_snipe",
            price_usdc=pair.get("priceUsd", "0") if pair else "0",
            liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)) if pair else 0,
            redis=redis,
        )
        buffer.clear(mint)
```

## Required Enrichment

New Launch Snipe requires score ≥ 65. Since `pumpfun_new` only gives 15 pts, at least one strong enrichment signal is **mandatory**:

| Enrichment | Score | Effect |
|---|---|---|
| KOL wallet buy | +40 | 15+40=55 → still not enough alone |
| KOL + GMGN trending | +40+25 | 15+40+25=80 → BUY ✓ |
| KOL + Birdeye | +40+20 | 15+40+20=75 → BUY ✓ |
| GMGN + DEXScreener | +25+20 | 15+25+20=60 → not enough |
| GMGN + DEXScreener + Twitter | +25+20+15 | 15+25+20+15=75 → BUY ✓ |

This design prevents sniping purely on a new launch without any secondary confirmation.

## Position Sizing Override

New launches are riskier — use a smaller position size:

```python
# RiskManager checks strategy name and applies multiplier
STRATEGY_SIZE_MULTIPLIER = {
    "new_launch_snipe":   0.5,   # 50% of normal size
    "social_alpha":       0.5,
    "kol_copy_trade":     1.0,
    "graduation_trade":   1.0,
    "momentum_spike":     0.8,
    "smart_money_confluence": 1.0,
}
```

Signal includes `strategy` field — RiskManager reads it for sizing.

## Raydium New Pool (variant)

When a non-Pump.fun token launches directly on Raydium with significant initial liquidity (≥$100k), treat it as a new launch with higher base score:

```python
if source == "raydium_new_pool" and liquidity >= 100_000:
    buffer.add(mint, "pumpfun_new", 25, data)  # higher base score for direct Raydium launch
```
