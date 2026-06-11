# Pump.fun

Pump.fun is a Solana token launchpad. Tokens launch on a bonding curve — once the curve fills (~$69k market cap), the token graduates to Raydium and gets a real liquidity pool. Detecting tokens at launch (pre-graduation) is a high-risk, high-reward strategy.

## Two Detection Strategies

### Strategy A: Pump.fun API (new launches)
Fetch tokens that just launched. Best for monitoring early-stage tokens.

```python
async def poll_pumpfun_new(session: aiohttp.ClientSession, redis):
    url = "https://frontend-api.pump.fun/coins/latest"
    params = {"includeNsfw": "false", "limit": "50"}
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            if resp.status != 200:
                return
            tokens = await resp.json()
    except Exception as e:
        logger.warning(f"Pump.fun API failed: {e}")
        return

    for token in tokens:
        mint = token.get("mint", "")
        if not mint or await is_duplicate(redis, "pumpfun_new", mint, window_s=3600):
            continue

        market_cap_usd = float(token.get("usd_market_cap", 0))
        if market_cap_usd < 5_000:       # skip micro-caps with no traction
            continue

        signal = NewTokenSignal(
            mint=mint,
            symbol=token.get("symbol", "UNKNOWN"),
            source=SignalSource.PUMPFUN,
            liquidity_usdc=market_cap_usd * 0.1,   # estimate: ~10% of mcap is liquid
            age_seconds=_calc_age_from_created(token.get("created_timestamp")),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.new", signal.model_dump_json())
```

### Strategy B: Pump.fun WebSocket (real-time events)
Connect to Pump.fun WebSocket for real-time new coin events. Lower latency than polling.

```python
import websockets
import json

PUMPFUN_WS = "wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket"

async def stream_pumpfun_events(redis):
    while True:
        try:
            async with websockets.connect(PUMPFUN_WS) as ws:
                # Socket.io handshake
                await ws.send('40')
                await ws.send('42["subscribeNewToken"]')

                async for message in ws:
                    if not message.startswith("42"):
                        continue
                    payload = json.loads(message[2:])
                    if payload[0] != "newCoinCreated":
                        continue
                    token = payload[1]
                    await _handle_pumpfun_new_token(token, redis)

        except Exception as e:
            logger.warning(f"Pump.fun WebSocket disconnected: {e} — reconnecting in 5s")
            await asyncio.sleep(5)

async def _handle_pumpfun_new_token(token: dict, redis):
    mint = token.get("mint", "")
    if not mint or await is_duplicate(redis, "pumpfun_ws", mint, window_s=3600):
        return

    signal = NewTokenSignal(
        mint=mint,
        symbol=token.get("symbol", "UNKNOWN"),
        source=SignalSource.PUMPFUN,
        liquidity_usdc=float(token.get("usd_market_cap", 0)) * 0.1,
        age_seconds=0,  # just created
        ts=int(time.time() * 1000),
    )
    await redis.publish("scanner.token.new", signal.model_dump_json())
```

## Graduation Detection (bonding curve → Raydium)

When a Pump.fun token graduates, it gets a Raydium pool. This is a strong signal — the token has proven demand.

```python
async def poll_pumpfun_graduated(session: aiohttp.ClientSession, redis):
    url = "https://frontend-api.pump.fun/coins"
    params = {"sort": "last_trade_timestamp", "order": "DESC", "includeNsfw": "false"}
    try:
        async with session.get(url, params=params, timeout=aiohttp.ClientTimeout(total=10)) as resp:
            data = await resp.json()
    except Exception:
        return

    for token in data:
        if not token.get("raydium_pool"):  # only graduated tokens have this
            continue
        mint = token["mint"]
        if await is_duplicate(redis, "pumpfun_graduated", mint, window_s=3600):
            continue

        signal = NewTokenSignal(
            mint=mint,
            symbol=token.get("symbol", "UNKNOWN"),
            source=SignalSource.PUMPFUN,
            liquidity_usdc=float(token.get("virtual_sol_reserves", 0)) * 150,  # rough SOL→USD
            age_seconds=_calc_age_from_created(token.get("created_timestamp")),
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.new", signal.model_dump_json())
```

## Key Pump.fun Fields

```python
token = {
    "mint": "<mint_address>",
    "symbol": "DOGE2",
    "name": "Doge 2.0",
    "description": "...",
    "created_timestamp": 1718000000000,
    "usd_market_cap": 45000,
    "virtual_sol_reserves": 30.5,
    "virtual_token_reserves": 793100000,
    "raydium_pool": None,               # None = on bonding curve, string = graduated
    "complete": False,                  # True = bonding curve filled
    "total_supply": 1_000_000_000,
    "twitter": "https://x.com/...",
    "telegram": "https://t.me/...",
    "website": "https://...",
}
```

## Risk Notes

- Pump.fun tokens are **extremely high risk** — most go to zero within hours
- Never skip token safety checks for Pump.fun tokens, even with strong social signal
- Apply tighter `min_token_age_seconds` (suggest 300s minimum) before buying
- `rat_trader_amount_rate` from GMGN is especially important for Pump.fun tokens — snipers are common

```python
def _calc_age_from_created(created_ts_ms: int | None) -> float:
    if not created_ts_ms:
        return 0
    return (time.time() * 1000 - created_ts_ms) / 1000
```
