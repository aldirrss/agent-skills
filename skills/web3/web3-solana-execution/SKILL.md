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
Execution maintains `_locks: dict[str, asyncio.Lock]` — one lock per token mint. No two swap attempts for the same mint can be in-flight simultaneously. This prevents double-buys and race conditions between a buy and an emergency sell.

**2. Keypair never leaves Execution**
The `Keypair` object is instantiated once in `__init__` and never passed to any other component, written to Redis, logged, or stored in the database. Signing happens only inside `_execute_buy` / `_execute_sell`.

**3. dry_run=True is the default**
All code assumes `DRY_RUN=true` unless `DRY_RUN=false` is explicitly set. In dry-run mode, Execution logs the transaction bytes and publishes `status="dry_run"` but never submits to the network.

**4. Every swap attempt generates a fill**
Even if Jupiter quote fails, signing fails, or the transaction times out, Execution must publish a fill to `stream.fills` with the appropriate `status`. PositionTracker and DBWriter depend on this for state consistency.

**5. Check on-chain before retry**
Never re-submit a transaction without first calling `get_transaction(sig)`. A network timeout does not mean the transaction failed — it may have been confirmed on a fork that became canonical.

**6. Stop-loss and emergency sells use higher priority fee**
For `reason` in `stop_loss` / `emergency_stop`, Jupiter /swap uses `"prioritizationFeeLamports": "autoMultiplier:3"` instead of `"auto"`.

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

## Jupiter Error Handling — Decision Table

These are deterministic errors. Do NOT retry with the same transaction bytes.

| Error | Cause | Action |
|---|---|---|
| `SlippageToleranceExceeded` | Price moved between quote and swap | Return `failed` — do NOT auto-retry with higher slippage (sandwich risk) |
| `InsufficientFunds` | SOL balance too low for fee + ATA rent | Return `failed`, alert Monitor — requires human intervention |
| `BlockhashNotFound` | Blockhash from Jupiter expired (>60s old) | Return `failed` — let RiskManager re-evaluate and publish fresh swap |
| `SendTransactionPreflightFailure` | Wrong accounts, compute budget exceeded | Return `failed` — deterministic, retry will fail again |

For `SlippageToleranceExceeded` specifically: do not raise slippage and retry automatically. This is a sandwich attack vector. RiskManager decides whether to republish with updated slippage after re-quoting.

## Confirmation Status Decision Tree

After `send_raw_transaction`, poll `get_signature_statuses` every 2s up to 60s:

```
status.confirmation_status == "confirmed" or "finalized"
    → return "confirmed" ✅

status.err is not None
    → return "failed" — transaction landed but execution error (on-chain revert)

60s elapsed, status is None or "processed"
    → return "timeout"
    → publish fill with status="timeout" immediately
    → then async: check_transaction_on_chain(sig)
        → found on-chain → publish correction fill with status="confirmed"
        → not found after +30s → transaction expired, safe to allow RiskManager retry
```

**Why "processed" is not enough:** `processed` means the transaction was seen by the validator but not yet included in a confirmed block. Never treat `processed` as success — it can still be dropped.

## Partial Fill Scenario

Jupiter may return less `outAmount` than quoted when pool liquidity changes between quote and execution. This is not an error — the transaction confirms with a smaller token amount.

Handling:
- `amount_out` in `SwapResult` reflects the **actual** on-chain output from the Jupiter response
- Publish the real `amount_tokens` in `stream.fills` (not the quoted estimate)
- PositionTracker uses `amount_tokens` from the fill to seed the position — never the quote estimate

```python
# In _execute_buy, after confirmed swap:
# quote.outAmount is an estimate — use the actual result.amount_out
actual_tokens = result.amount_out   # from SwapResult, populated by Jupiter /swap response
```

## RPC Fallback Behavior

Fallback applies **only at the send step**. Quote and swap-transaction requests are stateless reads and use Jupiter's API directly with no fallback.

```
send_raw_transaction → primary RPC
    ├── ConnectionError → retry with fallback RPC (one attempt)
    │       ├── success → continue to confirmation polling
    │       └── ConnectionError → return status="failed"
    └── Any other exception → return status="failed" immediately (do not fallback)
```

Confirmation polling always uses primary RPC. If primary is down during polling, the timeout path applies — the async on-chain check after timeout can use fallback RPC.

## Quick Self-Check Before Finishing Execution Code

- [ ] `Keypair` object never passed outside `Execution` class
- [ ] `asyncio.Lock` acquired per-mint before every swap
- [ ] `stream.fills` published for every attempt: `confirmed` | `failed` | `timeout` | `dry_run`
- [ ] `SlippageToleranceExceeded` → return `failed`, not retry with higher slippage
- [ ] `BlockhashNotFound` → return `failed`, not re-sign same bytes
- [ ] Confirmation polling checks for `confirmed` or `finalized`, not `processed`
- [ ] `timeout` fill published immediately, then async on-chain check before allowing retry
- [ ] `stop_loss` / `emergency_stop` → `prioritizationFeeLamports: "autoMultiplier:3"`
- [ ] `amount_tokens` in fill = actual `result.amount_out`, not quote estimate
- [ ] `DRY_RUN=true` is default — mainnet requires explicit `DRY_RUN=false`

## Reference Files

| Building... | Read |
|---|---|
| Full Execution class, XREADGROUP loop, lock handling | `references/execution-component.md` |
| Jupiter V6 quote/swap, signing, RPC submission, full error handling | `references/jupiter-flow.md` |
| DRY_RUN mode, simulation helpers, go-live checklist | `references/dry-run.md` |
