# Data Sources

DEXScreener, GMGN, on-chain RPC, and KOL wallet tracking patterns.

## DEXScreener API

Free, no API key required. Best for token discovery and basic metrics.

Base URL: `https://api.dexscreener.com`

### Fetch New Pairs (Solana)
```python
async def fetch_new_pairs(session: aiohttp.ClientSession, min_liquidity_usd: float = 10000) -> list[dict]:
    url = "https://api.dexscreener.com/token-profiles/latest/v1"
    async with session.get(url) as resp:
        data = await resp.json()
    return [
        p for p in data
        if p.get("chainId") == "solana"
        and float(p.get("liquidity", {}).get("usd", 0)) >= min_liquidity_usd
    ]
```

### Search Token by Mint
```python
async def get_token_info(session: aiohttp.ClientSession, mint: str) -> dict | None:
    url = f"https://api.dexscreener.com/latest/dex/tokens/{mint}"
    async with session.get(url) as resp:
        data = await resp.json()
    pairs = data.get("pairs") or []
    if not pairs:
        return None
    # return the pair with highest liquidity
    return max(pairs, key=lambda p: float(p.get("liquidity", {}).get("usd", 0)))
```

### Key fields to extract
```python
{
    "baseToken": {"address": "<mint>", "symbol": "BONK"},
    "priceUsd": "0.00001234",
    "liquidity": {"usd": 450000},
    "volume": {"h1": 120000, "h6": 800000, "h24": 3200000},
    "priceChange": {"h1": 18.5, "h6": 42.1, "h24": 110.0},
    "txns": {"h1": {"buys": 340, "sells": 120}},
    "pairCreatedAt": 1718000000000,  # ms timestamp
}
```

Rate limit: ~300 req/min per IP. Add 200ms delay between calls to stay safe.

## GMGN API

GMGN provides trending tokens, smart wallet tracking, and token safety scores.

Base URL: `https://gmgn.ai/defi/quotation/v1`

### Trending Tokens (Solana)
```python
async def fetch_gmgn_trending(session: aiohttp.ClientSession) -> list[dict]:
    url = "https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h"
    params = {"orderby": "swaps", "direction": "desc", "filters[]": "not_honeypot"}
    headers = {"User-Agent": "Mozilla/5.0"}  # required
    async with session.get(url, params=params, headers=headers) as resp:
        data = await resp.json()
    return data.get("data", {}).get("rank", [])
```

### Key GMGN fields
```python
{
    "address": "<mint>",
    "symbol": "BONK",
    "price": 0.00001234,
    "swaps": 1840,           # swap count in 1h
    "volume": 1200000,       # volume in USD in 1h
    "liquidity": 450000,
    "holder_count": 12400,
    "top10_holder_rate": 0.31,   # top 10 holders % — red flag if >0.5
    "is_honeypot": false,
    "is_open_source": true,
    "renounced": true,           # mint authority renounced
}
```

Note: GMGN is a third-party API. Its availability may change. Always wrap calls in try/except and fall back to DEXScreener if GMGN is unreachable.

## On-Chain KOL Wallet Tracking

Track known profitable wallets by polling their transaction history via Solana RPC.

```python
async def get_recent_token_buys(
    wallet: str,
    rpc: AsyncClient,
    limit: int = 10,
) -> list[dict]:
    sigs_resp = await rpc.get_signatures_for_address(
        Pubkey.from_string(wallet),
        limit=limit,
    )
    buys = []
    for sig_info in sigs_resp.value:
        tx = await rpc.get_transaction(
            sig_info.signature,
            encoding="jsonParsed",
            max_supported_transaction_version=0,
        )
        if tx and tx.value:
            buy = _parse_swap_from_tx(tx.value)
            if buy:
                buys.append(buy)
    return buys

def _parse_swap_from_tx(tx) -> dict | None:
    # look for token balance changes in postTokenBalances vs preTokenBalances
    meta = tx.transaction.meta
    if not meta:
        return None
    pre = {b.account_index: int(b.ui_token_amount.amount) for b in (meta.pre_token_balances or [])}
    post = {b.account_index: int(b.ui_token_amount.amount) for b in (meta.post_token_balances or [])}
    for idx, post_amount in post.items():
        pre_amount = pre.get(idx, 0)
        if post_amount > pre_amount:
            # token balance increased — this is a buy
            balance = meta.post_token_balances[idx]
            return {
                "mint": balance.mint,
                "amount_delta": post_amount - pre_amount,
                "tx_signature": str(tx.transaction.transaction.signatures[0]),
            }
    return None
```

### KOL Wallet Registry

Store KOL wallet addresses in Redis: `state.kol.wallets` (Set).

Add/remove wallets at runtime via `stream.commands`:
```json
{"cmd": "UPDATE_CONFIG", "payload": {"key": "state.kol.wallets", "op": "add", "value": "ABcD...1234"}}
```

Label wallets for alert messages:
```
kol.wallet.label.{address}  →  "sol_whale_1" (Redis String, no TTL)
```

### Poll interval recommendations

| Source | Interval | Notes |
|---|---|---|
| DEXScreener new pairs | 10s | /token-profiles endpoint refreshes ~every 10s |
| DEXScreener trending | 30s | volume/price change data |
| GMGN trending | 60s | less frequent updates |
| KOL wallet history | 15s per wallet | getSignaturesForAddress is cheap |
| On-chain price (via RPC) | on-demand | only when confirming a position |

## Caching in Redis

```python
# Cache token info to avoid hammering APIs
CACHE_TTL = {
    "token.info.{mint}": 30,        # DEXScreener pair data, seconds
    "gmgn.trending": 60,            # trending list
    "token.decimals.{mint}": 0,     # permanent (decimals never change)
    "kol.buy.{wallet}.{mint}": 300, # dedupe: don't re-signal same wallet buy
}
```

Always check cache before API call:
```python
cached = await redis.get(f"token.info.{mint}")
if cached:
    return json.loads(cached)
data = await fetch_from_api(mint)
await redis.set(f"token.info.{mint}", json.dumps(data), ex=30)
return data
```
