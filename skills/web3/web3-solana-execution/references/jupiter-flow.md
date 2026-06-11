# Jupiter V6 Swap Flow

Complete Python implementation of every step: quote, swap transaction, signing, RPC submission, confirmation polling, and error handling.

## Constants

```python
JUPITER_BASE_URL = "https://quote-api.jup.ag/v6"
USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
CONFIRMATION_POLL_INTERVAL = 2      # seconds between get_signature_statuses calls
CONFIRMATION_TIMEOUT = 60           # seconds before treating as timeout
```

## SwapResult Dataclass

```python
from dataclasses import dataclass


@dataclass
class SwapResult:
    status: str       # "confirmed" | "failed" | "timeout" | "dry_run"
    tx_signature: str # empty string if not sent
    amount_out: int   # token units received (smallest denomination); 0 if not confirmed
    quote_price: str  # estimated price string from quote (never float)
```

## Step 1: GET /quote

```python
async def get_jupiter_quote(
    session,        # aiohttp.ClientSession
    input_mint: str,
    output_mint: str,
    amount: int,    # integer, smallest denomination (lamports / token units)
    slippage_bps: int,
) -> dict:
    """
    Fetch best route quote from Jupiter.

    Returns the full quote response dict (passed unchanged to /swap).
    Raises RuntimeError if Jupiter returns an error field.

    amount:
      - BUY:  USDC micro-units  (50 USDC = 50_000_000, 6 decimals)
      - SELL: token units in smallest denomination (fetch token decimals first)
    """
    params = {
        "inputMint": input_mint,
        "outputMint": output_mint,
        "amount": str(amount),          # must be string in URL
        "slippageBps": str(slippage_bps),
        "onlyDirectRoutes": "false",
    }

    async with session.get(
        f"{JUPITER_BASE_URL}/quote",
        params=params,
        timeout=aiohttp.ClientTimeout(total=10),
    ) as resp:
        resp.raise_for_status()
        data = await resp.json()

    if "error" in data:
        raise RuntimeError(f"Jupiter /quote error: {data['error']}")

    return data
```

## Step 2: POST /swap — Get Serialized Transaction

```python
async def get_jupiter_swap_transaction(
    session,
    quote_response: dict,
    user_public_key: str,
    priority_fee: str = "auto",
) -> str:
    """
    Exchange a quote for a serialized VersionedTransaction (base64).

    priority_fee:
      "auto"            — Jupiter picks a suitable fee (standard trades)
      "autoMultiplier:3" — 3x multiplier (stop_loss, emergency_stop)

    Returns base64-encoded transaction string.
    """
    payload = {
        "quoteResponse": quote_response,
        "userPublicKey": user_public_key,
        "wrapAndUnwrapSol": True,
        "dynamicComputeUnitLimit": True,
        "prioritizationFeeLamports": priority_fee,
    }

    async with session.post(
        f"{JUPITER_BASE_URL}/swap",
        json=payload,
        timeout=aiohttp.ClientTimeout(total=10),
    ) as resp:
        resp.raise_for_status()
        data = await resp.json()

    if "error" in data:
        raise RuntimeError(f"Jupiter /swap error: {data['error']}")

    return data["swapTransaction"]  # base64 string
```

## Step 3 & 4: Deserialize and Sign

```python
import base64
from solders.transaction import VersionedTransaction
from solders.keypair import Keypair


def sign_transaction(swap_tx_b64: str, keypair: Keypair) -> bytes:
    """
    Deserialize a Jupiter base64 transaction and sign it with the keypair.

    Returns raw transaction bytes ready for send_raw_transaction.

    Note: Jupiter pre-populates slot 0 of signatures[]. We replace it
    with our keypair signature over the serialized message bytes.
    """
    raw = base64.b64decode(swap_tx_b64)
    tx = VersionedTransaction.from_bytes(raw)

    # Sign the message bytes — solders Keypair.sign_message returns a Signature
    signature = keypair.sign_message(bytes(tx.message))
    tx.signatures[0] = signature

    return bytes(tx)
```

## Step 5: Send via RPC (with Fallback)

```python
from solana.rpc.async_api import AsyncClient
from solana.rpc.types import TxOpts


async def send_transaction_with_fallback(
    tx_bytes: bytes,
    primary_url: str,
    fallback_url: str,
) -> str:
    """
    Submit a signed transaction to Solana RPC.

    Tries primary RPC first. On ConnectionError, retries with fallback.
    Returns the transaction signature string.

    Uses skip_preflight=False to catch obvious errors before broadcasting.
    preflight_commitment="confirmed" runs simulation against confirmed state.
    """
    opts = TxOpts(skip_preflight=False, preflight_commitment="confirmed")

    async with AsyncClient(primary_url) as primary:
        try:
            resp = await primary.send_raw_transaction(tx_bytes, opts=opts)
            return str(resp.value)
        except ConnectionError as exc:
            logger.warning(f"Primary RPC connection error, falling back: {exc}")

    async with AsyncClient(fallback_url) as fallback:
        resp = await fallback.send_raw_transaction(tx_bytes, opts=opts)
        return str(resp.value)
```

## Step 6: Confirmation Polling

```python
import asyncio
from solana.rpc.async_api import AsyncClient


async def wait_for_confirmation(
    signature: str,
    rpc_url: str,
    timeout_s: int = CONFIRMATION_TIMEOUT,
    poll_interval_s: int = CONFIRMATION_POLL_INTERVAL,
) -> str:
    """
    Poll get_signature_statuses until confirmed, failed, or timeout.

    Returns:
      "confirmed" — transaction included and confirmed
      "failed"    — transaction included but execution error (on-chain revert)
      "timeout"   — not confirmed within timeout_s seconds

    Important: a "timeout" here does NOT mean the transaction failed.
    The caller must check on-chain with get_transaction(sig) before retrying.
    """
    deadline = asyncio.get_event_loop().time() + timeout_s

    async with AsyncClient(rpc_url) as rpc:
        while asyncio.get_event_loop().time() < deadline:
            resp = await rpc.get_signature_statuses([signature])
            status = resp.value[0] if resp.value else None

            if status is not None:
                if status.err:
                    logger.error(f"Transaction {signature[:20]}... on-chain error: {status.err}")
                    return "failed"
                if status.confirmation_status in ("confirmed", "finalized"):
                    return "confirmed"

            await asyncio.sleep(poll_interval_s)

    logger.warning(f"Transaction {signature[:20]}... confirmation timeout after {timeout_s}s")
    return "timeout"
```

## Complete execute_swap Orchestrator

```python
async def execute_swap(
    session,
    keypair: Keypair,
    rpc_url: str,
    rpc_fallback_url: str,
    input_mint: str,
    output_mint: str,
    amount: int,
    slippage_bps: int,
    priority_fee: str = "auto",
    dry_run: bool = True,
) -> SwapResult:
    """
    Full Jupiter swap flow: quote → transaction → sign → send → confirm.

    Parameters
    ----------
    amount      Integer in smallest denomination. BUY: USDC micro-units.
                SELL: token units.
    dry_run     If True, signs the transaction locally but does not submit.
                Returns status="dry_run", amount_out=0.

    Returns SwapResult with status, tx_signature, amount_out, quote_price.
    """
    user_pubkey = str(keypair.pubkey())

    # Step 1: Quote
    try:
        quote = await get_jupiter_quote(
            session=session,
            input_mint=input_mint,
            output_mint=output_mint,
            amount=amount,
            slippage_bps=slippage_bps,
        )
    except Exception as exc:
        logger.error(f"Jupiter /quote failed: {exc}")
        return SwapResult(status="failed", tx_signature="", amount_out=0, quote_price="0")

    out_amount = int(quote.get("outAmount", 0))
    quote_price = quote.get("price", "0")

    # Step 2: Get serialized transaction
    try:
        swap_tx_b64 = await get_jupiter_swap_transaction(
            session=session,
            quote_response=quote,
            user_public_key=user_pubkey,
            priority_fee=priority_fee,
        )
    except Exception as exc:
        logger.error(f"Jupiter /swap failed: {exc}")
        return SwapResult(status="failed", tx_signature="", amount_out=0, quote_price=quote_price)

    # Steps 3 & 4: Deserialize and sign
    try:
        tx_bytes = sign_transaction(swap_tx_b64, keypair)
    except Exception as exc:
        logger.error(f"Transaction signing failed: {exc}")
        return SwapResult(status="failed", tx_signature="", amount_out=0, quote_price=quote_price)

    # DRY_RUN: log and return without submitting
    if dry_run:
        logger.info(
            f"DRY_RUN | tx_bytes={len(tx_bytes)}B | "
            f"input={input_mint[:8]}... → output={output_mint[:8]}... | "
            f"amount={amount} | expected_out={out_amount}"
        )
        return SwapResult(
            status="dry_run",
            tx_signature="",
            amount_out=0,
            quote_price=quote_price,
        )

    # Step 5: Send
    try:
        sig = await send_transaction_with_fallback(tx_bytes, rpc_url, rpc_fallback_url)
        logger.info(f"Transaction sent: {sig}")
    except Exception as exc:
        logger.error(f"RPC send_raw_transaction failed: {exc}")
        return SwapResult(status="failed", tx_signature="", amount_out=0, quote_price=quote_price)

    # Step 6: Confirm
    confirmation_status = await wait_for_confirmation(sig, rpc_url)

    if confirmation_status == "confirmed":
        return SwapResult(
            status="confirmed",
            tx_signature=sig,
            amount_out=out_amount,
            quote_price=quote_price,
        )
    else:
        # "failed" or "timeout" — amount_out is 0 because we don't know actual fill
        return SwapResult(
            status=confirmation_status,
            tx_signature=sig,
            amount_out=0,
            quote_price=quote_price,
        )
```

## RPC Fallback Pattern

The fallback is applied only at the send step. Quote and swap-transaction requests hit Jupiter's API directly (no fallback needed — they are stateless reads). The critical failure point is submission.

```python
# Pattern: try primary, catch ConnectionError, try fallback.
# Do NOT catch all exceptions — let non-connection errors surface immediately.
try:
    resp = await primary_rpc.send_raw_transaction(tx_bytes, opts=opts)
except ConnectionError:
    resp = await fallback_rpc.send_raw_transaction(tx_bytes, opts=opts)
```

If both primary and fallback raise ConnectionError, the exception propagates to `execute_swap`, which catches it and returns `status="failed"`. A fill is still published.

## Retry Safety

**Never retry without checking on-chain first.** A timeout result means the transaction may have landed. Before building and sending a new transaction:

```python
async def check_transaction_on_chain(sig: str, rpc_url: str) -> bool:
    """Return True if transaction is on-chain (confirmed or failed with error)."""
    async with AsyncClient(rpc_url) as rpc:
        resp = await rpc.get_transaction(
            sig,
            encoding="json",
            commitment="confirmed",
            max_supported_transaction_version=0,
        )
    return resp.value is not None
```

If `check_transaction_on_chain` returns True for a timed-out swap, update the fill status and do not re-submit.

## Common Error Codes and Handling

### `SlippageToleranceExceeded`
Jupiter /swap returns HTTP 400 with error message containing "SlippageToleranceExceeded".

**Cause:** Price moved between quote and swap. Common on low-liquidity tokens.

**Handling:**
```python
# In execute_swap, after get_jupiter_swap_transaction raises:
if "SlippageToleranceExceeded" in str(exc):
    logger.warning(f"Slippage exceeded for {output_mint} — skipping trade")
    return SwapResult(status="failed", ...)
# Do NOT retry with higher slippage automatically — this is a sandwich risk.
# Let RiskManager decide whether to retry with new quote.
```

### `InsufficientFunds`
Jupiter /swap or RPC preflight returns insufficient funds error.

**Cause:** Wallet SOL balance too low to cover transaction fee + ATA rent.

**Handling:**
```python
if "InsufficientFunds" in str(exc) or "insufficient funds" in str(exc).lower():
    logger.error("Insufficient SOL balance — cannot execute swap")
    # Publish fill with status="failed" and reason="insufficient_funds"
    # Alert Monitor component
    return SwapResult(status="failed", ...)
```

### `BlockhashNotFound`
RPC returns BlockhashNotFound during preflight.

**Cause:** Recent blockhash fetched by Jupiter has expired (>60s old).

**Handling:** Treat as failed — do not retry the same transaction bytes. If the trade is still valid, the RiskManager should re-evaluate and publish a new swap message.

```python
if "BlockhashNotFound" in str(exc):
    logger.warning("Blockhash expired — transaction cannot be submitted")
    return SwapResult(status="failed", ...)
```

### Confirmation Timeout (60s)
The transaction was submitted but not confirmed within the timeout window.

**Handling:**
1. Return `status="timeout"` from `wait_for_confirmation`
2. Publish fill with `status="timeout"` immediately (so PositionTracker knows the swap is uncertain)
3. After publishing, run `check_transaction_on_chain(sig, rpc_url)` asynchronously
4. If found on-chain, update the fill status (XADD a correction fill or update via DB)
5. If not found after additional 30s, the transaction has expired — it is safe to retry

### `SendTransactionPreflightFailure`
Preflight simulation failed. Common causes: wrong accounts, program error, compute budget exceeded.

**Handling:** These are usually deterministic — retrying the same transaction will fail again. Log the full error, return `status="failed"`, do not retry.
