# Cielo Finance

Cielo tracks wallet PnL on Solana and provides a leaderboard of the most profitable traders. Use it to discover new KOL wallets and to enrich existing wallet signals with PnL context.

Website: https://app.cielo.finance
API: Requires API key — apply at https://app.cielo.finance/api

## Wallet PnL Lookup

```python
CIELO_HEADERS = {
    "Authorization": f"Bearer {os.environ.get('CIELO_API_KEY', '')}",
    "Content-Type": "application/json",
}

async def get_wallet_pnl(
    session: aiohttp.ClientSession, wallet: str
) -> dict | None:
    url = f"https://feed-api.cielo.finance/v1/pnl/total-stats"
    params = {"wallet": wallet}
    try:
        async with session.get(
            url, params=params, headers=CIELO_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return None
            data = await resp.json()
            return data.get("data")
    except Exception as e:
        logger.debug(f"Cielo PnL lookup failed for {wallet[:8]}: {e}")
        return None
```

## Key Cielo PnL Fields

```python
{
    "total_pnl_usd": 142500.0,
    "winrate": 0.68,               # 68% win rate
    "total_trades": 234,
    "average_trade_size_usd": 850,
    "best_trade_pnl_usd": 28000,
    "worst_trade_pnl_usd": -1200,
    "tokens_traded": 89,
}
```

## Recent Activity Feed

```python
async def get_wallet_recent_trades(
    session: aiohttp.ClientSession, wallet: str, limit: int = 20
) -> list[dict]:
    url = "https://feed-api.cielo.finance/v1/feed"
    params = {"wallet": wallet, "txType": "swap", "limit": limit}
    try:
        async with session.get(
            url, params=params, headers=CIELO_HEADERS,
            timeout=aiohttp.ClientTimeout(total=10)
        ) as resp:
            if resp.status != 200:
                return []
            data = await resp.json()
            return data.get("data", {}).get("items", [])
    except Exception:
        return []
```

## Recent Trade Fields

```python
{
    "tx_hash": "5KZ...abc",
    "wallet": "<address>",
    "token_in_symbol": "USDC",
    "token_out_symbol": "BONK",
    "token_out_mint": "<mint>",
    "amount_usd": 850,
    "timestamp": 1718000000,
    "pnl_usd": None,               # only set for sell txns
    "chain": "solana",
}
```

## Auto-Discovery of New KOL Wallets

Periodically scan Cielo leaderboard to find new quality wallets to add to `state.kol.wallets`:

```python
async def discover_kol_wallets(
    session: aiohttp.ClientSession, redis
):
    url = "https://feed-api.cielo.finance/v1/leaderboard"
    params = {"chain": "solana", "period": "30d", "limit": 100}
    try:
        async with session.get(
            url, params=params, headers=CIELO_HEADERS,
            timeout=aiohttp.ClientTimeout(total=12)
        ) as resp:
            data = await resp.json()
    except Exception:
        return

    for entry in data.get("data", {}).get("items", []):
        wallet = entry.get("wallet", "")
        winrate = float(entry.get("winrate", 0))
        total_trades = int(entry.get("total_trades", 0))
        avg_size = float(entry.get("average_trade_size_usd", 0))

        # quality filter
        if winrate < 0.60 or total_trades < 20 or avg_size < 500:
            continue

        already_tracking = await redis.sismember("state.kol.wallets", wallet)
        if already_tracking:
            continue

        await redis.sadd("state.kol.wallets", wallet)
        await redis.set(f"kol.wallet.label.{wallet}", f"cielo_{winrate:.0%}_{total_trades}trades")
        logger.info(f"Auto-added KOL wallet: {wallet[:8]} winrate={winrate:.0%} trades={total_trades}")
```

Run `discover_kol_wallets` once per day (not on every scanner cycle).

## Fallback

Cielo API may require approval for API access. If no `CIELO_API_KEY`:
- Skip `discover_kol_wallets` — use manually curated wallet list instead
- Use GMGN smart money endpoint as alternative for wallet discovery
