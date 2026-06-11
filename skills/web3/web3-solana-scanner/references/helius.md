# Helius Webhooks

Helius is a premium Solana RPC provider that also offers **real-time webhook notifications** — instead of polling wallet transactions every 15s, Helius pushes an HTTP POST to your server the moment a wallet transacts. This is the most efficient way to track KOL wallets at scale.

API Key: `HELIUS_API_KEY` env var
Dashboard: https://dev.helius.xyz

## Why Webhooks Over Polling

| | Polling (RPC) | Helius Webhook |
|---|---|---|
| Latency | 5–15s | <1s |
| API calls | N wallets × every 15s | 0 (push-based) |
| Scale | Degrades with # wallets | Flat cost |
| Missed txns | Possible if txn falls between polls | Never |

Use webhooks for all KOL wallet tracking. Use RPC polling only as fallback when Helius is unavailable.

## Webhook Setup (one-time, via Helius API)

```python
async def register_helius_webhook(
    session: aiohttp.ClientSession,
    wallet_addresses: list[str],
    callback_url: str,  # your public endpoint: https://yourbot.com/helius
):
    url = f"https://api.helius.xyz/v0/webhooks?api-key={os.environ['HELIUS_API_KEY']}"
    payload = {
        "webhookURL": callback_url,
        "transactionTypes": ["SWAP"],
        "accountAddresses": wallet_addresses,
        "webhookType": "enhanced",
    }
    async with session.post(url, json=payload) as resp:
        data = await resp.json()
        webhook_id = data["webhookID"]
        logger.info(f"Helius webhook registered: {webhook_id}")
        return webhook_id
```

Store `webhook_id` in Redis: `config.helius.webhook_id`. Used to add/remove wallets later.

## Add/Remove Wallets Dynamically

```python
async def update_helius_webhook(
    session: aiohttp.ClientSession,
    webhook_id: str,
    wallet_addresses: list[str],  # full list (not delta)
):
    url = f"https://api.helius.xyz/v0/webhooks/{webhook_id}?api-key={os.environ['HELIUS_API_KEY']}"
    payload = {"accountAddresses": wallet_addresses}
    async with session.put(url, json=payload) as resp:
        return resp.status == 200
```

## Webhook Receiver (FastAPI endpoint)

The bot needs a small HTTP server to receive Helius push events. Run as an asyncio task alongside the Scanner.

```python
from fastapi import FastAPI, Request
import uvicorn

app = FastAPI()

@app.post("/helius")
async def helius_webhook(request: Request):
    events = await request.json()
    for event in events:
        await process_helius_event(event)
    return {"ok": True}

async def process_helius_event(event: dict):
    tx_type = event.get("type")
    if tx_type != "SWAP":
        return

    fee_payer = event.get("feePayer", "")  # the wallet that initiated the swap
    if not fee_payer:
        return

    # check if this wallet is in our KOL list
    label = await redis.get(f"kol.wallet.label.{fee_payer}")
    if not label:
        return

    # extract token received (output of the swap)
    token_transfers = event.get("tokenTransfers", [])
    for transfer in token_transfers:
        if transfer.get("toUserAccount") == fee_payer and transfer.get("mint"):
            signal = WalletBuySignal(
                wallet=fee_payer,
                wallet_label=label.decode(),
                mint=transfer["mint"],
                symbol=transfer.get("symbol", "UNKNOWN"),
                amount_sol=float(event.get("nativeTransfers", [{}])[0].get("amount", 0)) / 1e9,
                tx_signature=event.get("signature", ""),
                source=SignalSource.HELIUS,
                ts=int(time.time() * 1000),
            )
            await redis.publish("scanner.wallet.buy", signal.model_dump_json())
            break

async def start_webhook_server():
    config = uvicorn.Config(app, host="0.0.0.0", port=8080, log_level="warning")
    server = uvicorn.Server(config)
    await server.serve()
```

## Helius Enhanced Transaction Fields

```python
event = {
    "signature": "5KZ...abc",
    "type": "SWAP",
    "timestamp": 1718000000,
    "feePayer": "<wallet_address>",
    "fee": 5000,
    "nativeTransfers": [
        {"fromUserAccount": "<wallet>", "toUserAccount": "<program>", "amount": 10500000000}
    ],
    "tokenTransfers": [
        {
            "fromUserAccount": "<program>",
            "toUserAccount": "<wallet>",
            "mint": "<output_token_mint>",
            "tokenAmount": 4056000,
            "symbol": "BONK",
        }
    ],
    "accountData": [...],
    "instructions": [...],
}
```

## Fallback to RPC Polling

If Helius webhook server is down or unreachable, fall back automatically:

```python
async def scanner_wallet_task(redis, rpc, session):
    use_webhook = os.environ.get("HELIUS_API_KEY") and os.environ.get("HELIUS_WEBHOOK_URL")
    if use_webhook:
        await start_webhook_server()  # push-based
    else:
        await poll_kol_wallets_loop(redis, rpc)  # polling fallback
```
