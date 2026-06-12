# DRY_RUN Mode and Testing Patterns

## How DRY_RUN Works

When `dry_run=True` (the default), Execution:

1. Fetches the Jupiter quote (real network call — validates the route exists)
2. Fetches the Jupiter swap transaction (real network call — builds the real tx)
3. Deserializes and signs the transaction locally (real signing — validates keypair and tx format)
4. **Stops here.** Does NOT call `send_raw_transaction`.
5. Logs the transaction byte length, expected output amount, and route summary
6. Returns `SwapResult(status="dry_run", tx_signature="", amount_out=0, ...)`
7. Publishes a fill to `stream.fills` with `status="dry_run"`

This means dry-run exercises every step except the final network submission and confirmation polling. It catches signing errors, malformed payloads, and invalid routes before going live.

```python
# In execute_swap (jupiter.py)

if dry_run:
    logger.info(
        f"DRY_RUN | tx_bytes={len(tx_bytes)}B | "
        f"input={input_mint[:8]}... → output={output_mint[:8]}... | "
        f"amount={amount} | expected_out={out_amount} | "
        f"route={quote.get('routePlan', [{}])[0].get('swapInfo', {}).get('label', 'unknown')}"
    )
    return SwapResult(
        status="dry_run",
        tx_signature="",
        amount_out=0,
        quote_price=quote.get("price", "0"),
    )
```

## Fill Published in DRY_RUN

PositionTracker and DBWriter receive fills with `status="dry_run"`. Both components must handle this status by recording the event without updating open positions or PnL.

```json
{
  "fill_id": "fill_3f8a91c2d4e1",
  "swap_id": "swp_xyz789",
  "mint": "So11111111111111111111111111111111111111112",
  "symbol": "BONK",
  "side": "BUY",
  "status": "dry_run",
  "tx_signature": "",
  "amount_usdc": "50.00",
  "amount_tokens": "0",
  "price_usdc": "0",
  "reason": "entry",
  "ts": "1718000001200"
}
```

PositionTracker behavior on `status="dry_run"`: log the event, do not create a position record in `state.position.{mint}`, do not add mint to `state.bot.tokens`.

## Simulating Fills for Strategy Testing

Use the simulation helper to generate realistic fill data without network calls. Useful for testing Strategy and PositionTracker in isolation.

```python
# execution/simulation.py

import asyncio
import uuid
from decimal import Decimal
from time import time_ns

from redis.asyncio import Redis

USDC_DECIMALS = 6
STREAM_FILLS = "stream.fills"


async def simulate_fill(
    redis: Redis,
    swap_id: str,
    mint: str,
    symbol: str,
    side: str,
    amount_usdc: str,
    simulated_price_usdc: str,
    reason: str = "entry",
) -> str:
    """
    Publish a synthetic fill to stream.fills for testing.

    Calculates token amount from amount_usdc and simulated_price_usdc.
    Returns the fill_id.
    """
    fill_id = f"fill_sim_{uuid.uuid4().hex[:10]}"

    amount_usdc_decimal = Decimal(amount_usdc)
    price = Decimal(simulated_price_usdc)

    # Tokens received (raw units — assume 6 decimals for simulation)
    token_decimals = 6
    amount_tokens = int(
        (amount_usdc_decimal / price) * 10 ** token_decimals
    ) if price > 0 else 0

    payload = {
        "fill_id": fill_id,
        "swap_id": swap_id,
        "mint": mint,
        "symbol": symbol,
        "side": side,
        "status": "simulated",
        "tx_signature": f"SIM_{uuid.uuid4().hex[:20]}",
        "amount_usdc": amount_usdc,
        "amount_tokens": str(amount_tokens),
        "price_usdc": simulated_price_usdc,
        "reason": reason,
        "ts": str(time_ns() // 1_000_000),
    }

    await redis.xadd(STREAM_FILLS, payload)
    return fill_id


async def simulate_buy_sell_cycle(
    redis: Redis,
    mint: str,
    symbol: str,
    entry_price: str,
    exit_price: str,
    amount_usdc: str = "50.00",
    hold_seconds: float = 0,
) -> tuple[str, str]:
    """
    Simulate a complete buy/sell cycle (entry then exit).
    Returns (buy_fill_id, sell_fill_id).
    Useful for testing PositionTracker PnL calculations.
    """
    swap_id_buy = f"swp_sim_{uuid.uuid4().hex[:10]}"
    swap_id_sell = f"swp_sim_{uuid.uuid4().hex[:10]}"

    buy_fill_id = await simulate_fill(
        redis=redis,
        swap_id=swap_id_buy,
        mint=mint,
        symbol=symbol,
        side="BUY",
        amount_usdc=amount_usdc,
        simulated_price_usdc=entry_price,
        reason="entry",
    )

    if hold_seconds > 0:
        await asyncio.sleep(hold_seconds)

    # Calculate tokens from buy fill to use in sell
    token_decimals = 6
    tokens = int(
        (Decimal(amount_usdc) / Decimal(entry_price)) * 10 ** token_decimals
    )
    exit_amount_usdc = str(
        round(Decimal(tokens) / 10 ** token_decimals * Decimal(exit_price), 6)
    )

    sell_fill_id = await simulate_fill(
        redis=redis,
        swap_id=swap_id_sell,
        mint=mint,
        symbol=symbol,
        side="SELL",
        amount_usdc=exit_amount_usdc,
        simulated_price_usdc=exit_price,
        reason="take_profit",
    )

    return buy_fill_id, sell_fill_id
```

## Expected Output Amount (from Quote)

Use this helper to compute expected output without executing the swap. Useful for pre-trade validation.

```python
async def get_expected_output(
    session,
    input_mint: str,
    output_mint: str,
    amount: int,
    slippage_bps: int,
) -> dict:
    """
    Returns a dict with expected output info from Jupiter quote.
    Does not execute any transaction.

    Returns:
      {
        "out_amount": int,          # raw token units
        "price_impact_pct": float,
        "route_label": str,
        "min_out_amount": int,      # after slippage
      }
    """
    from .jupiter import get_jupiter_quote

    quote = await get_jupiter_quote(
        session=session,
        input_mint=input_mint,
        output_mint=output_mint,
        amount=amount,
        slippage_bps=slippage_bps,
    )

    out_amount = int(quote.get("outAmount", 0))
    price_impact = float(quote.get("priceImpactPct", 0))
    route_label = (
        quote.get("routePlan", [{}])[0].get("swapInfo", {}).get("label", "unknown")
    )
    # Jupiter returns otherAmountThreshold as the minimum output after slippage
    min_out = int(quote.get("otherAmountThreshold", 0))

    return {
        "out_amount": out_amount,
        "price_impact_pct": price_impact,
        "route_label": route_label,
        "min_out_amount": min_out,
    }
```

## Switching to Live (DRY_RUN=false)

Switching to mainnet requires an explicit opt-in. The code will not accidentally go live if the env var is missing — missing `DRY_RUN` defaults to `"true"`.

```python
# In bot engine startup:
dry_run = os.environ.get("DRY_RUN", "true").lower() != "false"
```

Setting `DRY_RUN=false` in your environment enables real transactions. This is the only change required — no code changes needed.

```bash
# .env for live trading (treat this file as a secret)
DRY_RUN=false
RPC_PRIMARY_URL=https://rpc.helius.xyz/?api-key=YOUR_KEY
RPC_FALLBACK_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_KEY
WALLET_KEYPAIR_B64=<base64-encoded 64-byte keypair>
```

Never commit `.env` to version control. Never set `DRY_RUN=false` in Docker images or CI environments.

## Go-Live Checklist

Run through every item before setting `DRY_RUN=false`:

### Keypair and Wallet
- [ ] Keypair loaded from `WALLET_KEYPAIR_B64` env var only — not hardcoded, not from file path
- [ ] Keypair never appears in logs (run with dry_run first and grep logs for the pubkey string)
- [ ] Wallet has enough SOL for ATA rent and transaction fees (minimum 0.1 SOL recommended)
- [ ] Wallet has the expected USDC balance for initial trades
- [ ] Keypair is a dedicated trading wallet — not the same as any other wallet you use

### Configuration
- [ ] `config.risk` exists in Redis with valid JSON (max_position_usdc, min_viable_position_usdc — stop_loss_pct/take_profit_pct are code constants, not config)
- [ ] `config.strategy` exists in Redis with valid JSON (enabled_strategies, min_confidence_score)
- [ ] Slippage values in config.risk are non-zero and appropriate for your token targets
- [ ] `MAX_POSITION_USDC` constant in code matches your intended risk ceiling

### Integration Test (dry_run=True first)
- [ ] Run bot with `DRY_RUN=true` for at least 30 minutes and observe:
  - `stream.swaps` receives messages with correct schema
  - `stream.fills` receives `status="dry_run"` messages for each swap
  - PositionTracker does NOT create positions for dry_run fills
  - No errors in logs during XREADGROUP loop
- [ ] Confirm lock behavior: manually add two simultaneous swap messages for the same mint and verify second is queued, not dropped

### RPC and Jupiter
- [ ] Primary RPC URL responds: `curl -s https://rpc.helius.xyz/... -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'` returns `{"result":"ok"}`
- [ ] Fallback RPC URL responds similarly
- [ ] Jupiter quote API reachable: test `GET /quote` with a known pair (SOL → USDC)
- [ ] Confirmation polling tested: a dry_run transaction returns before timeout

### Safety Gates
- [ ] RiskManager only publishes swap messages when `state.bot.status == "running"`
- [ ] Rugpull/honeypot checks run before every BUY (in Strategy or RiskManager)
- [ ] `MAX_POSITION_USDC` constant enforced in code (not just config)
- [ ] Emergency stop tested: publishing `cmd=EMERGENCY_STOP` to stream.commands triggers SELL for all open positions

### Monitoring
- [ ] Monitor component receives fills and logs them
- [ ] Telegram/Discord alert fires on confirmed buy and sell
- [ ] Alert fires on `status="failed"` or `status="timeout"` fills
- [ ] Heartbeat publishing to `state.bot.heartbeat` every 30s

### Final Step
- [ ] All items above checked
- [ ] Set `DRY_RUN=false` in `.env`
- [ ] Start bot with a small initial position size (reduce `max_position_usdc` to $5–$10 for first live trades)
- [ ] Monitor `stream.fills` in real time: `redis-cli XREAD COUNT 10 BLOCK 5000 STREAMS stream.fills $`
- [ ] Confirm first live fill appears in DB within 5 seconds of transaction confirmation
