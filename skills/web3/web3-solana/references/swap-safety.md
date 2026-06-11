# Swap Safety

Jupiter V6 swap flow, transaction signing, confirmation, and failure handling.

## Slippage Tiers

Derive slippage from token liquidity — never hardcode a single value.

```python
def get_slippage_bps(liquidity_usdc: float) -> int:
    if liquidity_usdc >= 500_000:
        return 50    # 0.5% — high liquidity
    elif liquidity_usdc >= 50_000:
        return 100   # 1.0% — medium liquidity
    elif liquidity_usdc >= 10_000:
        return 200   # 2.0% — low liquidity
    else:
        return 500   # 5.0% — very low liquidity / new launch
```

For emergency sells (stop loss, emergency stop), always use 1000 bps (10%) to guarantee execution regardless of liquidity.

## Full Swap Flow

```python
import asyncio
import base64
import time
import aiohttp
from solders.keypair import Keypair
from solders.transaction import VersionedTransaction
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts

JUPITER_API = "https://quote-api.jup.ag/v6"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

async def execute_swap(
    input_mint: str,
    output_mint: str,
    amount: int,              # in smallest unit (lamports or token units)
    slippage_bps: int,
    keypair: Keypair,
    rpc: AsyncClient,
    priority: str = "auto",   # "auto" | "autoMultiplier:3" for urgent
    dry_run: bool = True,
) -> dict:
    async with aiohttp.ClientSession() as session:
        # Step 1: Get quote
        quote = await _get_quote(session, input_mint, output_mint, amount, slippage_bps)
        if not quote:
            return {"status": "failed", "reason": "no_route"}

        # Step 2: Get swap transaction
        swap_tx_b64 = await _get_swap_transaction(
            session, quote, str(keypair.pubkey()), priority
        )
        if not swap_tx_b64:
            return {"status": "failed", "reason": "swap_tx_failed"}

        if dry_run:
            return {"status": "dry_run", "quote": quote}

        # Step 3: Sign and send
        sig = await _sign_and_send(swap_tx_b64, keypair, rpc)

        # Step 4: Confirm
        confirmed = await _wait_for_confirmation(sig, rpc)
        if confirmed:
            return {"status": "confirmed", "tx_signature": sig, "quote": quote}
        else:
            return {"status": "timeout", "tx_signature": sig}


async def _get_quote(session, input_mint, output_mint, amount, slippage_bps):
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount),
        "slippageBps": str(slippage_bps),
        "onlyDirectRoutes": "false",
    }
    async with session.get(f"{JUPITER_API}/quote", params=params) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
        return data if data.get("outAmount") else None


async def _get_swap_transaction(session, quote, user_pubkey, priority):
    payload = {
        "quoteResponse": quote,
        "userPublicKey": user_pubkey,
        "wrapAndUnwrapSol": True,
        "dynamicComputeUnitLimit": True,
        "prioritizationFeeLamports": priority,
    }
    async with session.post(f"{JUPITER_API}/swap", json=payload) as resp:
        if resp.status != 200:
            return None
        data = await resp.json()
        return data.get("swapTransaction")


async def _sign_and_send(swap_tx_b64: str, keypair: Keypair, rpc: AsyncClient) -> str:
    raw_tx = base64.b64decode(swap_tx_b64)
    tx = VersionedTransaction.from_bytes(raw_tx)

    signed_bytes = keypair.sign_message(bytes(tx.message))
    tx.signatures[0] = signed_bytes

    opts = TxOpts(skip_preflight=False, preflight_commitment="confirmed")
    resp = await rpc.send_raw_transaction(bytes(tx), opts=opts)
    return str(resp.value)


async def _wait_for_confirmation(sig: str, rpc: AsyncClient, timeout_s: int = 60) -> bool:
    deadline = asyncio.get_event_loop().time() + timeout_s
    while asyncio.get_event_loop().time() < deadline:
        resp = await rpc.get_signature_statuses([sig])
        status = resp.value[0]
        if status:
            if status.err:
                return False   # on-chain error
            if status.confirmation_status in ("confirmed", "finalized"):
                return True
        await asyncio.sleep(2)
    return False  # timeout
```

## Safe Retry Logic

Never re-send a transaction without checking on-chain first.

```python
async def safe_retry_swap(sig: str, swap_params: dict, rpc: AsyncClient) -> bool:
    # check if original tx landed
    resp = await rpc.get_transaction(sig, encoding="json")
    if resp.value is not None:
        # tx exists on-chain — do NOT re-send
        return resp.value.transaction.meta.err is None

    # tx not found — safe to retry with new blockhash
    result = await execute_swap(**swap_params)
    return result["status"] == "confirmed"
```

## Amount Calculations

```python
USDC_DECIMALS = 6
SOL_DECIMALS = 9

def usdc_to_units(amount_usdc: float) -> int:
    """Convert human USDC to micro-units. 50 USDC → 50_000_000"""
    return int(amount_usdc * 10 ** USDC_DECIMALS)

def tokens_to_units(amount: float, decimals: int) -> int:
    return int(amount * 10 ** decimals)

def units_to_usdc(units: int) -> float:
    return units / 10 ** USDC_DECIMALS
```

## Common Failure Modes

| Error | Cause | Fix |
|---|---|---|
| `no_route` | Jupiter found no valid swap path | Token likely has zero liquidity — skip trade |
| `SlippageToleranceExceeded` | Price moved beyond slippage during tx | Increase slippage_bps for low-liquidity tokens |
| `InsufficientFunds` | Wallet balance too low | Check SOL + USDC balance before swap |
| `BlockhashNotFound` | Transaction expired (>90s in mempool) | Rebuild transaction with fresh blockhash |
| Timeout (no confirmation in 60s) | RPC congestion or dropped tx | Check on-chain before retry |
| `0x1` in tx meta err | On-chain program error | Usually bad slippage or rug — log and skip |
