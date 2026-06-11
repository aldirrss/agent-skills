---
name: web3-solana-execution
description: Execution component for Solana DEX trading bot — Jupiter swap API, transaction signing with solders, RPC submission, confirmation polling, fill publishing, and per-mint asyncio locks. Use this whenever the user is building or debugging the Execution layer, including: Jupiter V6 quote/swap flow, transaction signing with solders Keypair, sending via solana-py AsyncClient, confirmation polling loop, retry safety (check on-chain before retry), per-mint asyncio.Lock to prevent double-swaps, priority fee strategy, or publishing stream.fills. Trigger even when the user mentions one specific area (e.g. "swap transaction timeout", "how to sign Jupiter transaction", "duplicate swap being sent", "how to handle SlippageExceeded error"). Only component that holds the Keypair object.
requires:
  - web3-solana
  - web3-solana-architecture
---

# web3-solana-execution

Execution is the **only component** that holds the wallet Keypair, calls Jupiter, signs transactions, and submits to the Solana network. Every swap attempted — whether confirmed, failed, or timed out — must be published to `stream.fills`. No other component is allowed to touch the keypair or call Jupiter.

## Role in the System

```
RiskManager
    │  XADD stream.swaps
    ▼
Execution  ◄── holds Keypair (singleton, never shared)
    │
    ├── GET  Jupiter /quote
    ├── POST Jupiter /swap  → serialized VersionedTransaction
    ├── Sign with solders keypair.sign_message(bytes(tx.message))
    ├── Send via solana-py AsyncClient.send_raw_transaction
    ├── Poll get_signature_statuses every 2s (60s timeout)
    │
    └── XADD stream.fills  → PositionTracker + DBWriter
```

## Key Invariants

These must never be violated. If generating code that could break them, add an explicit guard.

**1. One asyncio.Lock per mint**
Execution maintains a `_locks: dict[str, asyncio.Lock]` — one lock per token mint. No two swap attempts for the same mint can be in-flight simultaneously. This prevents double-buys and race conditions between a buy and an emergency sell.

**2. Keypair never leaves Execution**
The `Keypair` object is instantiated once in `__init__` and never passed to any other component, written to Redis, logged, or stored in the database. Signing happens only inside `_execute_buy` / `_execute_sell`.

**3. dry_run=True is the default**
All code generation assumes `DRY_RUN=true` unless `DRY_RUN=false` is explicitly set in env. In dry-run mode, Execution logs the transaction bytes and publishes a `status="dry_run"` fill but never submits to the network.

**4. Every swap attempt generates a fill**
Even if Jupiter quote fails, signing fails, or the transaction times out, Execution must publish a fill to `stream.fills` with the appropriate `status` (`confirmed` | `failed` | `timeout` | `dry_run`). PositionTracker and DBWriter depend on this for state consistency.

**5. Check on-chain before retry**
Never re-submit a transaction without first calling `get_transaction(sig)` to verify it did not land. A network timeout does not mean the transaction failed — it may have been confirmed on a fork that just became canonical.

**6. Stop-loss and emergency sells use higher priority fee**
For `reason` values `stop_loss` and `emergency_stop`, the Jupiter /swap request uses `"prioritizationFeeLamports": "autoMultiplier:3"` instead of `"auto"` to guarantee inclusion during congestion.

## stream.swaps Message Schema

Execution reads from this stream (group: `exec-group`, consumer: `execution-1`):

```json
{
  "swap_id": "swp_xyz789",
  "signal_id": "sig_abc123",
  "mint": "So11111111111111111111111111111111111111112",
  "symbol": "BONK",
  "side": "BUY",
  "amount_usdc": "50.00",
  "slippage_bps": 100,
  "reason": "entry",
  "ts": 1718000000100
}
```

`reason` values: `entry` | `take_profit` | `stop_loss` | `emergency_stop`

## stream.fills Message Schema

Execution writes to this stream after every swap attempt:

```json
{
  "fill_id": "fill_111",
  "swap_id": "swp_xyz789",
  "mint": "So11111111111111111111111111111111111111112",
  "symbol": "BONK",
  "side": "BUY",
  "status": "confirmed",
  "tx_signature": "5KZ...abc",
  "amount_usdc": "50.00",
  "amount_tokens": "4056000",
  "price_usdc": "0.00001233",
  "reason": "entry",
  "ts": 1718000001200
}
```

## Reference Files

| Building... | Read |
|---|---|
| Full Execution class, XREADGROUP loop, lock handling | `references/execution-component.md` |
| Jupiter V6 quote/swap, signing, RPC submission, error handling | `references/jupiter-flow.md` |
| DRY_RUN mode, simulation helpers, go-live checklist | `references/dry-run.md` |
