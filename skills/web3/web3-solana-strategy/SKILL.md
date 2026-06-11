---
name: web3-solana-strategy
description: Strategy component for Solana DEX trading bot — signal confluence, entry/exit decisions, and position monitoring. Use this whenever the user is building or debugging the Strategy layer, including confluence logic, signal scoring, entry rules, exit rules (take profit, stop loss, time-based), position monitoring loop, or any of the six trading strategies (KOL Copy Trade, New Launch Snipe, Graduation Trade, Momentum/Volume Spike, Smart Money Confluence, Social Alpha). Trigger even when the user mentions one specific area (e.g. "how to combine signals", "when to trigger a buy", "how to detect stop loss", "how to weight KOL signals vs social signals"). All Strategy output goes to stream.signals defined in web3-solana-architecture.
requires:
  - web3-solana
  - web3-solana-architecture
  - web3-solana-scanner
---

# web3-solana-strategy

Strategy is the **brain** of the bot. It consumes signals from Scanner (Redis pub/sub), evaluates confluence, applies entry rules, and publishes buy/sell decisions to `stream.signals`. It also runs a position monitor loop that checks open positions against stop loss and take profit.

Strategy never touches the wallet, never calls Jupiter, never writes to the DB. Its only outputs are entries to `stream.signals`.

## Confluence Model: Hybrid

Every strategy uses a **hybrid model**:
1. **Anchor signal** — one strong signal that must be present (required)
2. **Enrichment signals** — additional signals that increase confidence score
3. **Safety gate** — token must pass all safety checks (rugpull, liquidity, honeypot)
4. **Confidence threshold** — combined score must meet minimum before publishing

```
Anchor signal (required)
    +
Enrichment signals (optional, add score)
    +
Safety gate (pass/fail)
    =
BUY decision (if score >= threshold)
```

## Confidence Score

Each signal source contributes a fixed score. Scores are additive.

```python
SIGNAL_WEIGHTS = {
    "kol_wallet":          40,   # highest trust — real money on the line
    "smart_money_multi":   35,   # 2+ Cielo wallets agreeing
    "pumpfun_graduation":  30,   # proven demand milestone
    "gmgn_trending":       25,
    "birdeye_trending":    20,
    "dexscreener_volume":  20,
    "pumpfun_new":         15,
    "twitter_spike":       15,
    "telegram_alpha":      10,   # lowest trust — high noise
}

MIN_CONFIDENCE_SCORE = 50  # from config.strategy — BUY only if score >= this
```

## Six Trading Strategies

Each strategy is an asyncio task. All can be enabled/disabled independently via `config.strategy.enabled_strategies`.

| Strategy | Anchor | Min Score |
|---|---|---|
| KOL Copy Trade | `kol_wallet` or `smart_money_multi` | 50 |
| New Launch Snipe | `pumpfun_new` | 65 |
| Graduation Trade | `pumpfun_graduation` | 55 |
| Momentum/Volume Spike | `gmgn_trending` + `dexscreener_volume` | 60 |
| Smart Money Confluence | `smart_money_multi` | 70 |
| Social Alpha | `telegram_alpha` + `twitter_spike` | 75 |

Higher min score for riskier strategies (Social Alpha, New Launch Snipe).

## Signal Window

Signals must arrive within a time window to count as confluence. Outside the window, signals are stale and ignored.

```python
SIGNAL_WINDOWS = {
    "kol_copy_trade":        300,   # 5 min
    "new_launch_snipe":       60,   # 1 min — act fast or miss
    "graduation_trade":      600,   # 10 min
    "momentum_spike":        300,   # 5 min
    "smart_money_confluence": 600,  # 10 min
    "social_alpha":          900,   # 15 min
}
```

## Position Monitor

Separate asyncio task that runs every 5s, checking all open positions against SL/TP.

```python
async def position_monitor_loop(redis):
    while True:
        mints = await redis.smembers("state.bot.tokens")
        for mint in mints:
            pos = await redis.get(f"state.position.{mint}")
            if not pos:
                continue
            position = json.loads(pos)
            price = Decimal(await redis.get(f"state.price.{mint}") or "0")
            if price == 0:
                continue
            await _check_exit_conditions(mint, position, price, redis)
        await asyncio.sleep(5)
```

## Reference Files

| Building… | Read |
|---|---|
| KOL Copy Trade implementation | `references/strategy-kol-copy.md` |
| New Launch Snipe implementation | `references/strategy-new-launch.md` |
| Graduation Trade implementation | `references/strategy-graduation.md` |
| Momentum/Volume Spike implementation | `references/strategy-momentum.md` |
| Smart Money Confluence implementation | `references/strategy-smart-money.md` |
| Social Alpha implementation | `references/strategy-social-alpha.md` |
| Signal buffer, confluence engine, exit logic | `references/confluence-engine.md` |
