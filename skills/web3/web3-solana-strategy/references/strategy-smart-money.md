# Strategy: Smart Money Confluence

Enter when 2 or more independent high-quality wallets (from Cielo leaderboard) buy the same token within a short window. Multiple smart money wallets agreeing = very strong signal.

**Anchor:** `smart_money_multi` (≥2 Cielo wallets)
**Min Score:** 70 (highest requirement — but easiest to reach with multi-wallet)
**Signal Window:** 600s (10 min)
**Risk Level:** Low-Medium

## Why This Strategy Is Different

- KOL Copy Trade reacts to **any** tracked wallet
- Smart Money Confluence requires **multiple independent wallets** agreeing
- Much lower false positive rate — coordinated buying by 2+ proven traders is rare noise
- Works even without GMGN/DEXScreener trending data

## Logic Flow

```
scanner.wallet.buy received
    ↓
Is wallet in state.kol.wallets? → No: ignore
    ↓ Yes
Add to buffer: source=kol_wallet, score=40
    ↓
Count distinct KOL wallets buying same token in 10 min window
    ↓
Count ≥ 2? → Add smart_money_multi anchor (+35)
    ↓
Safety check
    ↓ Pass
Score ≥ 70? → BUY
```

## Implementation

```python
async def smart_money_confluence_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe(
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

        if channel == "scanner.wallet.buy":
            wallet = data.get("wallet", "")
            if not await redis.sismember("state.kol.wallets", wallet):
                continue

            modifier = await get_kol_score_modifier(redis, wallet)
            score = int(SIGNAL_WEIGHTS["kol_wallet"] * modifier)
            buffer.add(mint, f"kol_wallet_{wallet[:8]}", score, data)

            # count distinct KOL wallets
            active = buffer.get_active(mint, 600)
            kol_entries = [s for s in active if s.source.startswith("kol_wallet_")]
            distinct_wallets = {s.source for s in kol_entries}

            if len(distinct_wallets) >= 2:
                # inject smart_money_multi anchor if not already present
                if not buffer.has_source(mint, "smart_money_multi", 600):
                    buffer.add(mint, "smart_money_multi", SIGNAL_WEIGHTS["smart_money_multi"], {
                        "wallet_count": len(distinct_wallets),
                    })
                    logger.info(
                        f"Smart money confluence: {data.get('symbol')} "
                        f"— {len(distinct_wallets)} wallets aligned"
                    )

        elif channel == "scanner.token.trending":
            source = data.get("source", "")
            weight_key = {
                "gmgn": "gmgn_trending",
                "birdeye": "birdeye_trending",
                "dexscreener": "dexscreener_volume",
            }.get(source)
            if weight_key:
                buffer.add(mint, weight_key, SIGNAL_WEIGHTS[weight_key], data)

        # anchor required
        if not buffer.has_source(mint, "smart_money_multi", 600):
            continue

        if await is_signal_on_cooldown(redis, "smart_money_confluence", mint):
            continue

        safety = await run_full_safety_check_cached(session, redis, mint)
        if not safety.safe:
            continue

        ready = await evaluate_confluence(
            mint=mint,
            symbol=data.get("symbol", "UNKNOWN"),
            buffer=buffer,
            strategy_name="smart_money_confluence",
            anchor_source="smart_money_multi",
            window_s=600,
            min_score=70,
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
            sources=list({s.source for s in active}),
            strategy="smart_money_confluence",
            price_usdc=pair.get("priceUsd", "0") if pair else "0",
            liquidity_usdc=float(pair.get("liquidity", {}).get("usd", 0)) if pair else 0,
            redis=redis,
        )
        buffer.clear(mint)
```

## Score Paths

`smart_money_multi` = 35. The two underlying `kol_wallet` scores also count (≈40 each):

| Path | Total | Result |
|---|---|---|
| 2 KOL wallets only | 40+40+35=115 | BUY ✓ (very strong) |
| 2 KOL + GMGN | 115+25=140 | BUY ✓ |
| smart_money_multi alone | 35 | Not enough |

In practice, 2 KOL wallet buys always exceeds the threshold. The 70-pt minimum protects against a single wallet triggering this strategy through the `kol_wallet` source.

## 3-Wallet Bonus

When 3+ wallets align, log as a high-confidence event and use full position size:

```python
if len(distinct_wallets) >= 3:
    # override: signal confidence = 1.0, use max position size
    await redis.set(f"strategy.high_confidence.{mint}", "1", ex=300)
    logger.info(f"HIGH CONFIDENCE: {len(distinct_wallets)} smart wallets on {data.get('symbol')}")
```

RiskManager checks `strategy.high_confidence.{mint}` and uses `MAX_POSITION_USDC` directly instead of sizing by confidence.
