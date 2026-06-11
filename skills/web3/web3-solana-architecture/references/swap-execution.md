# Swap Execution

Reference for building the Execution component — Jupiter API, transaction signing, RPC submission.

## Jupiter V6 Swap API

Base URL: `https://quote-api.jup.ag/v6`

### Step 1: Get Quote
```
GET /quote
  ?inputMint={input_mint}
  &outputMint={output_mint}
  &amount={amount_lamports_or_tokens}
  &slippageBps={slippage}
  &onlyDirectRoutes=false
```

BUY example (USDC → BONK):
- `inputMint` = `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (USDC)
- `outputMint` = token mint address
- `amount` = USDC amount in micro-units (50 USDC = `50_000_000`, 6 decimals)
- `slippageBps` = from config (default 100 = 1%)

SELL example (BONK → USDC): swap inputMint/outputMint, amount = token units.

### Step 2: Get Swap Transaction
```
POST /swap
Content-Type: application/json

{
  "quoteResponse": <quote object from step 1>,
  "userPublicKey": "<wallet pubkey string>",
  "wrapAndUnwrapSol": true,
  "dynamicComputeUnitLimit": true,
  "prioritizationFeeLamports": "auto"
}
```

Response: `{ "swapTransaction": "<base64 encoded transaction>" }`

### Step 3: Sign and Send

```python
import base64
from solders.transaction import VersionedTransaction
from solders.keypair import Keypair
from solana.rpc.async_api import AsyncClient

async def sign_and_send(
    swap_tx_b64: str,
    keypair: Keypair,
    rpc_client: AsyncClient,
) -> str:
    raw_tx = base64.b64decode(swap_tx_b64)
    tx = VersionedTransaction.from_bytes(raw_tx)

    # sign with keypair
    signed_tx = keypair.sign_message(bytes(tx.message))
    tx.signatures[0] = signed_tx

    resp = await rpc_client.send_raw_transaction(
        bytes(tx),
        opts=TxOpts(skip_preflight=False, preflight_commitment="confirmed"),
    )
    return str(resp.value)  # tx signature
```

### Step 4: Confirm Transaction

```python
async def wait_for_confirmation(
    signature: str,
    rpc_client: AsyncClient,
    timeout_s: int = 60,
) -> bool:
    from solana.rpc.commitment import Confirmed
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        resp = await rpc_client.get_signature_statuses([signature])
        status = resp.value[0]
        if status and status.confirmation_status == "confirmed":
            return True
        if status and status.err:
            return False
        await asyncio.sleep(2)
    return False  # timeout
```

## Slippage Strategy

| Token type | Recommended slippageBps |
|---|---|
| High liquidity (>$500k) | 50 (0.5%) |
| Medium liquidity ($50k–$500k) | 100 (1%) |
| Low liquidity (<$50k) | 200–300 (2–3%) |
| New launch (<1h old) | 500 (5%) |

Always read slippage from `config.risk` — never hardcode.

## RPC Endpoints

Use a **premium RPC node** — public endpoints are rate-limited and unreliable for trading.

Recommended providers: Helius, QuickNode, Triton.

Config pattern:
```json
{
  "rpc": {
    "primary_url": "https://rpc.helius.xyz/?api-key=...",
    "fallback_url": "https://solana-mainnet.g.alchemy.com/v2/..."
  }
}
```

Always implement fallback:
```python
async def send_with_fallback(tx_bytes, primary, fallback):
    try:
        return await primary.send_raw_transaction(tx_bytes, ...)
    except Exception:
        return await fallback.send_raw_transaction(tx_bytes, ...)
```

## Priority Fees

Use `prioritizationFeeLamports: "auto"` in Jupiter /swap request — Jupiter calculates the optimal fee based on current network congestion. Never hardcode lamport values.

For emergency sells (stop loss, emergency stop), override with `"prioritizationFeeLamports": "autoMultiplier:3"` to guarantee fast inclusion.

## Token Decimals

Always fetch token decimals from on-chain metadata before calculating amounts:
```python
async def get_decimals(mint: str, rpc: AsyncClient) -> int:
    info = await rpc.get_account_info(Pubkey.from_string(mint))
    # parse mint account data — byte 44 is decimals
    return info.value.data[44]
```

Cache result in Redis: `token.decimals.{mint}` (TTL: permanent — decimals never change).
