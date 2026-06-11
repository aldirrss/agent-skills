# Strategy: KOL Copy Trade

Copy trades from known profitable wallets. When a KOL buys a token, verify safety, accumulate enrichment signals, then mirror the trade.

**Anchor:** `kol_wallet` or `smart_money_multi`
**Min Score:** 50
**Signal Window:** 300s (5 min)
**Risk Level:** Medium

## Logic Flow

```
scanner.wallet.buy received
    ↓
Is wallet in state.kol.wallets? → No: ignore
    ↓ Yes
Token safety check (liquidity, honeypot, rugpull)
    ↓ Pass
Add to signal buffer: source=kol_wallet, score=40
    ↓
Check enrichment signals in buffer (last 5 min)
    ↓
Total score ≥ 50? → No: wait for more signals
    ↓ Yes
Not on cooldown? position not open?
    ↓ Yes
Publish BUY to stream.signals
```

## Implementation

```python
import json, time
from decimal import Decimal

async def kol_copy_trade_task(redis, session, buffer: SignalBuffer):
    pubsub = redis.pubsub()
    await pubsub.subscribe("scanner.wallet.buy")

    async for message in pubsub.listen():
        if message["type"] != "message":
            continue

        signal = WalletBuySignal.model_validate_json(message["data"])

        # verify wallet is in our KOL list
        if not await redis.sismember("state.kol.wallets", signal.wallet):
            continue

        mint = signal.mint

        # safety gate
        safety = await run_full_safety_check_cached(session, redis, mint)
        if not safety.safe:
            logger.debug(f"KOL_COPY safety reject: {mint[:8]} — {safety.reason}")
            continue

        # add anchor signal to buffer
        buffer.add(mint, "kol_wallet", SIGNAL_WEIGHTS["kol_wallet"], signal.model_dump())

        # check for smart_money_multi: if 2+ KOL wallets bought same token in window
        kol_buys = [
            s for s in buffer.get_active(mint, 300)
            if s.source == "kol_wallet"
        ]
        if len(kol_buys) >= 2:
            buffer.add(mint, "smart_money_multi", SIGNAL_WEIGHTS["smart_money_multi"], {})

        # evaluate confluence
        if await is_signal_on_cooldown(redis, "kol_copy_trade", mint):
            continue

        ready = await evaluate_confluence(
            mint=mint,
            symbol=signal.symbol,
            buffer=buffer,
            strategy_name="kol_copy_trade",
            anchor_source="kol_wallet",
            window_s=300,
            min_score=50,
            redis=redis,
        )
        if not ready:
            continue

        # enrich with current price from DEXScreener cache
        pair_data = await get_cached_pair(session, redis, mint)
        price_usdc = pair_data.get("priceUsd", "0") if pair_data else "0"
        liquidity = float(pair_data.get("liquidity", {}).get("usd", 0)) if pair_data else 0

        active = buffer.get_active(mint, 300)
        await publish_buy_signal(
            mint=mint,
            symbol=signal.symbol,
            score=sum(s.score for s in active),
            sources=[s.source for s in active],
            strategy="kol_copy_trade",
            price_usdc=price_usdc,
            liquidity_usdc=liquidity,
            redis=redis,
        )
        buffer.clear(mint)
```

## Enrichment Signals That Boost KOL Copy

While waiting for confluence, other Scanner signals for the same token within the 5-min window add score:

| Signal | Score Added | How detected |
|---|---|---|
| GMGN trending | +25 | scanner.token.trending, source=gmgn |
| Birdeye trending | +20 | scanner.token.trending, source=birdeye |
| DEXScreener volume | +20 | scanner.token.trending, source=dexscreener |
| Twitter spike | +15 | scanner.token.trending, source=twitter |
| Telegram alpha | +10 | scanner.token.new, source=telegram |

Strategy subscribes to **all** scanner channels simultaneously, not just `scanner.wallet.buy`:

```python
await pubsub.subscribe(
    "scanner.wallet.buy",
    "scanner.token.trending",
    "scanner.token.new",
)
```

## KOL Confidence Modifier

Not all KOL wallets are equal. Apply a multiplier based on wallet win rate (from Cielo):

```python
async def get_kol_score_modifier(redis, wallet: str) -> float:
    stats_raw = await redis.get(f"kol.wallet.stats.{wallet}")
    if not stats_raw:
        return 1.0  # no data — use base score
    stats = json.loads(stats_raw)
    winrate = float(stats.get("winrate", 0.5))
    # 1.0 at 60% winrate, up to 1.5 at 90%+
    return min(1.0 + (winrate - 0.60) * 1.25, 1.5) if winrate >= 0.60 else 0.8

# Usage:
modifier = await get_kol_score_modifier(redis, signal.wallet)
adjusted_score = int(SIGNAL_WEIGHTS["kol_wallet"] * modifier)
buffer.add(mint, "kol_wallet", adjusted_score, signal.model_dump())
```
