---
name: web3-solana
description: Senior-level guidance for building Solana on-chain trading systems in Python. Use this whenever the user is writing code that touches Solana DEX trading — wallet management, transaction signing, Jupiter swaps, Raydium/Pump.fun interaction, RPC calls, token accounts, on-chain data fetching, DEXScreener/GMGN integration, KOL wallet tracking, or any bot that moves real SOL/tokens. Trigger even when the user doesn't say "Solana" explicitly but mentions mint address, keypair, lamports, Jupiter, Raydium, GMGN, DEXScreener, pump.fun, solders, solana-py, associated token account, priority fee, or slippage bps. Real money and irreversible transactions are at stake — a missing slippage guard or an exposed private key is a financial loss, not a cosmetic bug. Apply safety rules here rigorously.
---

# Solana On-Chain Trading Development

Building Solana trading bots is unlike normal web development: transactions are **irreversible**, private key exposure means **total loss of funds**, and a bad slippage setting on a low-liquidity token can lose 30% in a single swap. Every code path that touches a keypair, builds a transaction, or calls Jupiter must be treated as if real capital flows through it — because in production it does.

## Non-negotiable safety rules

These apply to ALL generated code in this domain. Do not relax them for "just an example."

1. **Private key never leaves memory.** Load once from env var or encrypted file at startup. Never log it, write it to Redis, store it in DB, or pass it as a function argument beyond the Execution component. If a log line could print the keypair, it is a bug.

2. **Always verify transaction confirmation before updating state.** `send_transaction()` success means the transaction was accepted by the RPC node — it does NOT mean it was confirmed on-chain. Always poll `get_signature_statuses()` until `confirmed` or `finalized`. Never update position state on send alone.

3. **Slippage must be set before every swap — never zero, never skipped.** Zero slippage on a low-liquidity token will cause the transaction to fail. Too-high slippage on a manipulated token will cause a sandwich attack. Always derive slippage from liquidity tier (see `references/swap-safety.md`).

4. **Check token account existence before swap.** If the wallet has no Associated Token Account (ATA) for the output token, Jupiter creates one in the same transaction — but you must pass `wrapAndUnwrapSol: true` and verify the wallet has enough SOL to cover ATA rent (~0.002 SOL). Always check `state.wallet.sol_balance` before executing.

5. **Never retry a failed transaction blindly.** A transaction can fail at RPC level but still land on-chain (network partition, timeout). Always check `get_transaction(sig)` before re-submitting. Double-submitting a swap can result in two buys.

6. **Token amounts use integer arithmetic (lamports/smallest unit).** SOL has 9 decimals (1 SOL = 1_000_000_000 lamports). Each token has its own decimals. Never use `float` for amounts. Use `int` (Python) or `Decimal` → `int` at the boundary.

7. **Priority fees are required on congested network.** A transaction without a priority fee will stall or expire during high-traffic periods. Always use `prioritizationFeeLamports: "auto"` in Jupiter swaps. For stop-loss and emergency sells, use `"autoMultiplier:3"`.

8. **Rugpull and honeypot checks before any BUY.** Before executing a buy on any token, verify: (a) liquidity is above minimum threshold, (b) top 10 holders do not control >50% of supply, (c) contract is not mint-authority-locked to a single wallet. Never buy a token that fails these checks regardless of signal strength.

9. **Position size is bounded by code, not just config.** A config typo must not be able to spend the entire wallet. Enforce a hard ceiling: `MAX_POSITION_USDC = 500` as a code constant. Size is additionally capped at `wallet_balance_usdc * MAX_WALLET_PCT` (default 10%).

10. **Default to devnet/simulation.** Live mainnet trading is opt-in and explicit. Generated bot code must include a `DRY_RUN=true` env var that simulates swaps (logs the transaction bytes but does not send). Flipping to live must require `DRY_RUN=false` explicitly.

If a user request conflicts with one of these (e.g. "skip the rugpull check, I trust this token"), implement what they ask but flag the risk in a comment and in your reply — never silently produce unsafe code.

## How to use this skill

Read the relevant reference file(s) before writing code for that area:

| When the task involves… | Read |
|---|---|
| Wallet setup, keypair loading, ATA, SOL balance | `references/wallet-management.md` |
| Jupiter swap, transaction signing, RPC submission | `references/swap-safety.md` |
| DEXScreener, GMGN, on-chain data, KOL wallets | `references/data-sources.md` |
| Rugpull detection, liquidity checks, honeypot | `references/token-safety.md` |
| Position sizing, stop loss, take profit, max exposure | `references/risk-management.md` |

For any code that places a swap, read both `swap-safety.md` AND `risk-management.md` — they are two halves of the same safety story.

## Recommended stack

```python
solders          # keypair, transaction building, signing (Rust-binding — use this, not solana-py for signing)
solana-py        # AsyncClient for RPC: getBalance, sendTransaction, getSignatureStatuses
aiohttp          # HTTP for DEXScreener API, GMGN API, Jupiter V6 API
asyncio          # all I/O is async — never block the event loop
loguru           # structured logging (never log private keys or seed phrases)
pydantic         # config validation — enforce safety limits at load time
redis[hiredis]   # async state bus between components
asyncpg          # async PostgreSQL for trade history
```

## Solana concepts every bot developer must know

### Lamports
The smallest unit of SOL. `1 SOL = 1_000_000_000 lamports`. All RPC calls return lamports. Always work in lamports internally; convert to SOL only for display.

```python
SOL_DECIMALS = 9
LAMPORTS_PER_SOL = 10 ** SOL_DECIMALS

def lamports_to_sol(lamports: int) -> str:
    return str(lamports / LAMPORTS_PER_SOL)
```

### Token decimals
Each SPL token defines its own decimal places (usually 6 or 9). Always fetch from on-chain mint account. Never assume 6 or 9.

```python
async def get_token_decimals(mint: str, rpc: AsyncClient) -> int:
    info = await rpc.get_account_info(Pubkey.from_string(mint), encoding="base64")
    # mint account layout: byte 44 is decimals
    data = base64.b64decode(info.value.data[0])
    return data[44]
```

Cache result in Redis: `token.decimals.{mint}` with no TTL (decimals never change).

### Associated Token Account (ATA)
Every wallet needs an ATA per token to hold that token. Jupiter creates ATAs automatically in the swap transaction. Ensure wallet has ≥0.01 SOL buffer for ATA rent and transaction fees before any buy.

### Transaction expiry
Solana transactions expire after ~60–90 seconds (based on blockhash). If not confirmed in that window, the transaction is dropped. Always track send timestamp; if no confirmation in 60s, treat as timeout — do NOT re-send without checking on-chain first.

### Priority fees
During high congestion, transactions without priority fees stall. Use Jupiter's `prioritizationFeeLamports: "auto"` — it calls `getRecentPrioritizationFees` and sets an appropriate fee automatically. Never hardcode lamport values.

## Quick self-check before finishing any swap-path code

- [ ] Private key loaded from env var only, never hardcoded or logged
- [ ] Token amounts are `int` (lamports/smallest unit), never `float`
- [ ] Slippage derived from liquidity tier, not hardcoded
- [ ] Confirmation polled after send, not assumed from send response
- [ ] Rugpull/honeypot check runs before every BUY
- [ ] Position size bounded by `MAX_POSITION_USDC` constant
- [ ] `DRY_RUN=true` is the default; mainnet is explicit opt-in
- [ ] SOL balance checked before swap (ATA rent + fee buffer)
- [ ] Retry logic checks on-chain before re-submitting
