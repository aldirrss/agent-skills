# Execution Component

Full implementation of the `Execution` class — the only component that holds the Keypair, calls Jupiter, and submits transactions to Solana.

## Complete Class

```python
# execution/execution.py

from __future__ import annotations

import asyncio
import json
import uuid
from decimal import Decimal
from time import time_ns

from loguru import logger
from redis.asyncio import Redis
from solders.keypair import Keypair

from .jupiter import execute_swap, SwapResult

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
USDC_DECIMALS = 6

STREAM_SWAPS = "stream.swaps"
STREAM_FILLS = "stream.fills"
CONSUMER_GROUP = "exec-group"
CONSUMER_NAME = "execution-1"


class Execution:
    """
    Reads swap requests from stream.swaps, executes them via Jupiter,
    and publishes results to stream.fills.

    This is the ONLY component that:
      - holds the Keypair object
      - calls Jupiter V6 API
      - signs and submits Solana transactions
    """

    def __init__(
        self,
        keypair: Keypair,
        rpc_url: str,
        rpc_fallback_url: str,
        session,               # aiohttp.ClientSession
        redis: Redis,
        dry_run: bool = True,
    ) -> None:
        self._keypair = keypair          # never passed out of this class
        self._rpc_url = rpc_url
        self._rpc_fallback_url = rpc_fallback_url
        self._session = session
        self._redis = redis
        self._dry_run = dry_run

        # One asyncio.Lock per mint — prevents concurrent swaps on the same token.
        self._locks: dict[str, asyncio.Lock] = {}

        if dry_run:
            logger.warning("Execution running in DRY_RUN mode — no transactions will be sent")

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Create consumer group (idempotent) and start the read loop."""
        try:
            await self._redis.xgroup_create(
                STREAM_SWAPS, CONSUMER_GROUP, id="0", mkstream=True
            )
            logger.info(f"Consumer group '{CONSUMER_GROUP}' created on {STREAM_SWAPS}")
        except Exception as exc:
            if "BUSYGROUP" in str(exc):
                logger.debug(f"Consumer group '{CONSUMER_GROUP}' already exists")
            else:
                raise

        logger.info("Execution component started")
        await self._read_loop()

    async def stop(self) -> None:
        logger.info("Execution component stopping")

    # ------------------------------------------------------------------
    # XREADGROUP loop
    # ------------------------------------------------------------------

    async def _read_loop(self) -> None:
        """
        Continuously read pending + new messages from stream.swaps.
        On restart, '>' delivers new messages; '0' replays unacknowledged ones.
        """
        # First pass: recover any unacknowledged messages from before a crash
        await self._drain_pending()

        # Main loop: process new messages as they arrive
        while True:
            try:
                results = await self._redis.xreadgroup(
                    groupname=CONSUMER_GROUP,
                    consumername=CONSUMER_NAME,
                    streams={STREAM_SWAPS: ">"},
                    count=1,
                    block=5000,  # ms — yields control to event loop while waiting
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.error(f"XREADGROUP error: {exc}")
                await asyncio.sleep(2)
                continue

            if not results:
                continue

            for _stream, messages in results:
                for msg_id, data in messages:
                    await self._process(msg_id, data)

    async def _drain_pending(self) -> None:
        """Replay messages that were delivered but never ACKed (crash recovery)."""
        while True:
            results = await self._redis.xreadgroup(
                groupname=CONSUMER_GROUP,
                consumername=CONSUMER_NAME,
                streams={STREAM_SWAPS: "0"},
                count=10,
            )
            if not results:
                break
            msgs = results[0][1] if results else []
            if not msgs:
                break
            for msg_id, data in msgs:
                logger.info(f"Replaying pending message {msg_id}")
                await self._process(msg_id, data)

    # ------------------------------------------------------------------
    # Per-message dispatch
    # ------------------------------------------------------------------

    async def _process(self, msg_id: bytes | str, data: dict) -> None:
        """
        Acquire the per-mint lock, execute the swap, release the lock.
        Always ACK — even on failure — to prevent infinite replay loops.
        Failed swaps are recorded in stream.fills with status="failed".
        """
        mint: str = data.get("mint", "")
        side: str = data.get("side", "").upper()

        if not mint:
            logger.error(f"Malformed swap message (no mint): {data}")
            await self._redis.xack(STREAM_SWAPS, CONSUMER_GROUP, msg_id)
            return

        lock = self._locks.setdefault(mint, asyncio.Lock())

        async with lock:
            try:
                if side == "BUY":
                    await self._execute_buy(data)
                elif side == "SELL":
                    await self._execute_sell(data)
                else:
                    logger.error(f"Unknown side '{side}' in swap message: {data}")
            except Exception as exc:
                logger.exception(f"Unhandled error processing swap {data.get('swap_id')}: {exc}")
                await self._publish_fill(
                    swap_id=data.get("swap_id", ""),
                    mint=mint,
                    symbol=data.get("symbol", ""),
                    side=side,
                    status="failed",
                    tx_signature="",
                    amount_usdc=data.get("amount_usdc", "0"),
                    amount_tokens="0",
                    price_usdc="0",
                    reason=data.get("reason", ""),
                )
            finally:
                await self._redis.xack(STREAM_SWAPS, CONSUMER_GROUP, msg_id)

    # ------------------------------------------------------------------
    # BUY
    # ------------------------------------------------------------------

    async def _execute_buy(self, data: dict) -> None:
        """
        Execute a BUY: USDC → token.

        Converts amount_usdc (string, human-readable) to integer USDC micro-units
        (6 decimals), then calls execute_swap.
        """
        swap_id = data["swap_id"]
        mint = data["mint"]
        symbol = data["symbol"]
        reason = data.get("reason", "entry")
        slippage_bps = int(data.get("slippage_bps", 100))

        # Convert USDC amount to integer micro-units (6 decimals)
        amount_usdc_decimal = Decimal(data["amount_usdc"])
        amount_usdc_units = int(amount_usdc_decimal * 10 ** USDC_DECIMALS)

        logger.info(
            f"BUY {symbol} | swap_id={swap_id} | "
            f"amount_usdc={data['amount_usdc']} | slippage={slippage_bps}bps"
        )

        # Priority fee: standard for entry buys
        priority = "auto"

        result: SwapResult = await execute_swap(
            session=self._session,
            keypair=self._keypair,
            rpc_url=self._rpc_url,
            rpc_fallback_url=self._rpc_fallback_url,
            input_mint=USDC_MINT,
            output_mint=mint,
            amount=amount_usdc_units,
            slippage_bps=slippage_bps,
            priority_fee=priority,
            dry_run=self._dry_run,
        )

        # Calculate actual price from fill amounts
        price_usdc = "0"
        if result.amount_out > 0:
            price_usdc = str(
                round(amount_usdc_decimal / Decimal(result.amount_out), 12)
            )

        await self._publish_fill(
            swap_id=swap_id,
            mint=mint,
            symbol=symbol,
            side="BUY",
            status=result.status,
            tx_signature=result.tx_signature,
            amount_usdc=data["amount_usdc"],
            amount_tokens=str(result.amount_out),
            price_usdc=price_usdc,
            reason=reason,
        )

    # ------------------------------------------------------------------
    # SELL
    # ------------------------------------------------------------------

    async def _execute_sell(self, data: dict) -> None:
        """
        Execute a SELL: token → USDC.

        Uses amount_tokens from the swap message (integer token units, already
        calculated by RiskManager from the open position).

        For stop_loss and emergency_stop reasons, uses autoMultiplier:3 priority
        to guarantee fast transaction inclusion during congestion.
        """
        swap_id = data["swap_id"]
        mint = data["mint"]
        symbol = data["symbol"]
        reason = data.get("reason", "take_profit")
        slippage_bps = int(data.get("slippage_bps", 100))

        # amount_tokens is already in integer token units (smallest denomination)
        amount_tokens = int(data["amount_tokens"])

        logger.info(
            f"SELL {symbol} | swap_id={swap_id} | "
            f"amount_tokens={amount_tokens} | reason={reason} | slippage={slippage_bps}bps"
        )

        # Higher priority for urgent sells
        priority = (
            "autoMultiplier:3"
            if reason in ("stop_loss", "emergency_stop")
            else "auto"
        )

        result: SwapResult = await execute_swap(
            session=self._session,
            keypair=self._keypair,
            rpc_url=self._rpc_url,
            rpc_fallback_url=self._rpc_fallback_url,
            input_mint=mint,
            output_mint=USDC_MINT,
            amount=amount_tokens,
            slippage_bps=slippage_bps,
            priority_fee=priority,
            dry_run=self._dry_run,
        )

        # amount_out is USDC micro-units — convert to human-readable string
        amount_usdc_out = str(
            round(Decimal(result.amount_out) / 10 ** USDC_DECIMALS, 6)
        )

        # Calculate price per token from fill
        price_usdc = "0"
        if amount_tokens > 0 and result.amount_out > 0:
            price_usdc = str(
                round(Decimal(result.amount_out) / 10 ** USDC_DECIMALS / Decimal(amount_tokens), 12)
            )

        await self._publish_fill(
            swap_id=swap_id,
            mint=mint,
            symbol=symbol,
            side="SELL",
            status=result.status,
            tx_signature=result.tx_signature,
            amount_usdc=amount_usdc_out,
            amount_tokens=str(amount_tokens),
            price_usdc=price_usdc,
            reason=reason,
        )

    # ------------------------------------------------------------------
    # Publish fill
    # ------------------------------------------------------------------

    async def _publish_fill(
        self,
        *,
        swap_id: str,
        mint: str,
        symbol: str,
        side: str,
        status: str,
        tx_signature: str,
        amount_usdc: str,
        amount_tokens: str,
        price_usdc: str,
        reason: str,
    ) -> None:
        """
        XADD to stream.fills.

        This method is called for every swap attempt — confirmed, failed,
        timed out, or dry_run. PositionTracker and DBWriter depend on it
        for state consistency.
        """
        fill_id = f"fill_{uuid.uuid4().hex[:12]}"
        ts = time_ns() // 1_000_000  # milliseconds

        payload = {
            "fill_id": fill_id,
            "swap_id": swap_id,
            "mint": mint,
            "symbol": symbol,
            "side": side,
            "status": status,
            "tx_signature": tx_signature,
            "amount_usdc": amount_usdc,
            "amount_tokens": amount_tokens,
            "price_usdc": price_usdc,
            "reason": reason,
            "ts": str(ts),
        }

        await self._redis.xadd(STREAM_FILLS, payload)

        logger.info(
            f"fill published | fill_id={fill_id} | swap_id={swap_id} | "
            f"side={side} | status={status} | symbol={symbol} | "
            f"amount_usdc={amount_usdc} | amount_tokens={amount_tokens} | "
            f"tx={tx_signature[:16] + '...' if tx_signature else 'none'}"
        )
```

## SwapResult Dataclass

```python
# execution/jupiter.py (partial — full implementation in jupiter-flow.md)

from dataclasses import dataclass


@dataclass
class SwapResult:
    status: str          # "confirmed" | "failed" | "timeout" | "dry_run"
    tx_signature: str    # empty string if not submitted
    amount_out: int      # token units received (0 if failed/timeout/dry_run)
    quote_price: str     # estimated price from Jupiter quote (string, not float)
```

## Startup Wiring (bot engine integration)

```python
# engine.py (excerpt)

import os
import base64
from solders.keypair import Keypair
import aiohttp
from redis.asyncio import Redis

from execution.execution import Execution


async def create_execution(redis: Redis, session: aiohttp.ClientSession) -> Execution:
    # Load keypair from env — never from Redis, DB, or disk at runtime
    keypair_b64 = os.environ["WALLET_KEYPAIR_B64"]
    keypair_bytes = base64.b64decode(keypair_b64)
    keypair = Keypair.from_bytes(keypair_bytes)

    dry_run = os.environ.get("DRY_RUN", "true").lower() != "false"

    return Execution(
        keypair=keypair,
        rpc_url=os.environ["RPC_PRIMARY_URL"],
        rpc_fallback_url=os.environ["RPC_FALLBACK_URL"],
        session=session,
        redis=redis,
        dry_run=dry_run,
    )
```

## Lock Lifecycle Notes

- Locks are created lazily on first access: `self._locks.setdefault(mint, asyncio.Lock())`
- Locks live for the duration of the process — they are never deleted
- If a lock is held and a second swap for the same mint arrives, the second is queued until the first completes (including its fill publish and XACK)
- This guarantees that a stop-loss sell cannot race with an entry buy for the same mint
