# KOL Wallet Tracking

Track known profitable wallets by polling their recent transactions via Solana RPC. Use this as a fallback when Helius webhooks are not configured. See `helius.md` for the preferred push-based approach.

## KOL Wallet Registry

Store wallet addresses and labels in Redis:

```python
# Redis Set: wallet addresses
state.kol.wallets   →  {"ABcD...1234", "EFgH...5678", ...}

# Redis String per wallet: human label
kol.wallet.label.{address}  →  "sol_whale_1"
kol.wallet.label.ABcD...1234  →  "famous_trader_xyz"
```

Seed at startup from `config.kol_wallets` list in config file.

## Polling Loop (every 15s per wallet)

```python
async def poll_kol_wallets_loop(redis, rpc: AsyncClient):
    while True:
        wallets = await redis.smembers("state.kol.wallets")
        tasks = [_check_wallet(redis, rpc, w.decode()) for w in wallets]
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.sleep(15)

async def _check_wallet(redis, rpc: AsyncClient, wallet: str):
    label_bytes = await redis.get(f"kol.wallet.label.{wallet}")
    label = label_bytes.decode() if label_bytes else wallet[:8]

    try:
        sigs_resp = await rpc.get_signatures_for_address(
            Pubkey.from_string(wallet),
            limit=5,                       # last 5 transactions only
            commitment="confirmed",
        )
    except Exception as e:
        logger.debug(f"RPC error checking wallet {wallet[:8]}: {e}")
        return

    for sig_info in sigs_resp.value:
        sig = str(sig_info.signature)
        # skip already processed signatures
        if await redis.get(f"kol.seen.sig.{sig}"):
            continue
        await redis.set(f"kol.seen.sig.{sig}", "1", ex=3600)

        tx = await _fetch_tx(rpc, sig)
        if not tx:
            continue

        buy = _extract_buy(tx, wallet)
        if not buy:
            continue

        signal = WalletBuySignal(
            wallet=wallet,
            wallet_label=label,
            mint=buy["mint"],
            symbol=buy.get("symbol", "UNKNOWN"),
            amount_sol=buy["amount_sol"],
            tx_signature=sig,
            source=SignalSource.KOL_WALLET,
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.wallet.buy", signal.model_dump_json())
```

## Transaction Fetch

```python
async def _fetch_tx(rpc: AsyncClient, signature: str) -> object | None:
    try:
        resp = await rpc.get_transaction(
            signature,
            encoding="jsonParsed",
            max_supported_transaction_version=0,
            commitment="confirmed",
        )
        return resp.value
    except Exception as e:
        logger.debug(f"Failed to fetch tx {signature[:12]}: {e}")
        return None
```

## Buy Extraction from Transaction

```python
def _extract_buy(tx, wallet: str) -> dict | None:
    """Detect if the wallet received tokens (buy) in this transaction."""
    meta = tx.transaction.meta
    if not meta or meta.err:
        return None

    post_balances = {
        b.account_index: b
        for b in (meta.post_token_balances or [])
    }
    pre_balances = {
        b.account_index: int(b.ui_token_amount.amount)
        for b in (meta.pre_token_balances or [])
    }

    for idx, post in post_balances.items():
        owner = post.owner
        if owner != wallet:
            continue
        post_amount = int(post.ui_token_amount.amount)
        pre_amount = pre_balances.get(idx, 0)
        if post_amount <= pre_amount:
            continue  # balance decreased or unchanged — not a buy

        # estimate SOL spent: look at native SOL balance change
        pre_sol = meta.pre_balances[0] if meta.pre_balances else 0
        post_sol = meta.post_balances[0] if meta.post_balances else 0
        sol_spent = max(0, pre_sol - post_sol) / 1e9

        return {
            "mint": post.mint,
            "symbol": "UNKNOWN",   # enrich from DEXScreener/Birdeye if needed
            "amount_tokens": post_amount - pre_amount,
            "amount_sol": sol_spent,
        }
    return None
```

## Finding Quality KOL Wallets

Sources to identify profitable wallets:
- **Cielo Finance** (`cielo.md`) — PnL leaderboard, filter by win rate >60% and >20 trades
- **GMGN Smart Money** — GMGN labels wallets as "smart money" based on historical PnL
- **Birdeye Whale Tracker** — large position wallets
- Manual research: scan Twitter/X for traders posting PnL screenshots, verify on-chain

Minimum criteria before adding to KOL list:
- Win rate ≥ 60% (last 30 days)
- Average trade > $500
- At least 20 completed trades
- Not a known sniper bot (check `rat_trader_amount_rate` on GMGN)

## Rate Limiting

`getSignaturesForAddress` and `getTransaction` are cheap RPC calls but can still hit rate limits on public nodes. With Helius or QuickNode premium:
- Safe for 50+ wallets at 15s interval
- Add jitter to avoid thundering herd: `await asyncio.sleep(random.uniform(0, 2))`

```python
import random
await asyncio.sleep(random.uniform(0, 2))  # spread wallet checks over 2s window
```
