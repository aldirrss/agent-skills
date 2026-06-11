---
name: web3-solana-scanner
description: Scanner component for Solana DEX trading bot — fetching, normalizing, and publishing token signals from multiple sources. Use this whenever the user is building or debugging the Scanner layer of a Solana bot, including DEXScreener polling, GMGN trending, Pump.fun new launches, Helius webhook integration, Birdeye analytics, Cielo smart money tracking, KOL wallet tracking via RPC, Rugcheck safety validation, Twitter/X social signals, or Telegram alpha channel scraping. Trigger even when the user mentions one source (e.g. "how to detect new Raydium pools", "how to track a wallet in real-time", "how to integrate Helius webhook", "how to fetch GMGN trending"). All Scanner output goes to Redis pub/sub channels defined in web3-solana-architecture.
requires:
  - web3-solana
  - web3-solana-architecture
---

# web3-solana-scanner

The Scanner is the **eyes** of the bot. It fetches data from all external sources, normalizes signals into a unified format, and publishes them to Redis pub/sub for Strategy to consume. It never makes trading decisions — its only job is to detect and surface opportunities.

## Responsibilities

- Poll and stream data from all signal sources
- Normalize each source into unified `TokenSignal` format
- Deduplicate signals within a time window
- Publish to `scanner.token.new`, `scanner.token.trending`, `scanner.wallet.buy`
- Cache raw responses to avoid hammering external APIs
- Run all source pollers as concurrent asyncio tasks

## Unified Signal Format

Every source normalizes into one of three Redis pub/sub messages:

```python
from pydantic import BaseModel
from enum import Enum

class SignalSource(str, Enum):
    DEXSCREENER = "dexscreener"
    GMGN = "gmgn"
    PUMPFUN = "pumpfun"
    BIRDEYE = "birdeye"
    HELIUS = "helius_webhook"
    CIELO = "cielo"
    KOL_WALLET = "kol_wallet"
    RUGCHECK = "rugcheck"
    TWITTER = "twitter"
    TELEGRAM = "telegram"

class NewTokenSignal(BaseModel):
    mint: str
    symbol: str
    source: SignalSource
    liquidity_usdc: float
    age_seconds: float
    ts: int  # epoch ms

class TrendingSignal(BaseModel):
    mint: str
    symbol: str
    source: SignalSource
    volume_1h_usdc: float
    price_change_1h_pct: float
    liquidity_usdc: float
    ts: int

class WalletBuySignal(BaseModel):
    wallet: str
    wallet_label: str
    mint: str
    symbol: str
    amount_sol: float
    tx_signature: str
    source: SignalSource
    ts: int
```

## Scanner Task Map

| Task | Source | Channel | Interval |
|---|---|---|---|
| `dexscreener_new_pairs` | DEXScreener | `scanner.token.new` | 10s |
| `dexscreener_trending` | DEXScreener | `scanner.token.trending` | 30s |
| `gmgn_trending` | GMGN | `scanner.token.trending` | 60s |
| `pumpfun_launches` | Pump.fun | `scanner.token.new` | 5s |
| `birdeye_trending` | Birdeye | `scanner.token.trending` | 30s |
| `helius_webhook` | Helius | `scanner.wallet.buy` | push (no poll) |
| `kol_wallet_poll` | Solana RPC | `scanner.wallet.buy` | 15s per wallet |
| `cielo_smart_money` | Cielo | `scanner.wallet.buy` | 30s |
| `rugcheck_validate` | Rugcheck | internal gate | on-demand |
| `twitter_mentions` | Twitter/X API | `scanner.token.trending` | 60s |
| `telegram_alpha` | Telegram (Telethon) | `scanner.token.new` | push |

## Deduplication

Before publishing any signal, check Redis to avoid sending the same signal twice within a window:

```python
async def is_duplicate(redis, source: str, mint: str, window_s: int = 300) -> bool:
    key = f"scanner.seen.{source}.{mint}"
    exists = await redis.get(key)
    if exists:
        return True
    await redis.set(key, "1", ex=window_s)
    return False
```

Use a 5-minute window for trending signals, 60-minute window for new token signals (a new token shouldn't fire again for an hour).

## Reference Files

| Building… | Read |
|---|---|
| DEXScreener polling, field extraction, rate limits | `references/dexscreener.md` |
| GMGN trending, safety fields, fallback handling | `references/gmgn.md` |
| Pump.fun new launches, bonding curve detection | `references/pumpfun.md` |
| Birdeye token analytics, whale tracking | `references/birdeye.md` |
| Helius webhook server, real-time wallet events | `references/helius.md` |
| KOL wallet polling via Solana RPC | `references/kol-wallet.md` |
| Cielo smart money feed | `references/cielo.md` |
| Rugcheck token safety score API | `references/rugcheck.md` |
| Twitter/X mention tracking | `references/twitter.md` |
| Telegram alpha channel scraping | `references/telegram.md` |
