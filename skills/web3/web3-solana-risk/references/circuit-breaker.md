# Circuit Breaker & Safety Gate

All safety checks that RiskManager runs before approving a BUY signal. Each check is a standalone async function that can be called independently or composed into the full safety gate sequence.

## Redis Keys Involved

| Key | Type | Set by | Description |
|---|---|---|---|
| `stats.daily_pnl` | String (Decimal) | DBWriter | Cumulative realized PnL today in USDC |
| `state.position.*` | String (JSON) | PositionTracker | One key per open position |
| `state.bot.status` | String | CommandListener | `"running"` \| `"paused"` \| `"stopped"` |
| `state.wallet.usdc_balance` | String (Decimal) | PositionTracker | Live wallet USDC balance |
| `state.wallet.sol_balance` | String (Decimal) | PositionTracker | Live wallet SOL balance |
| `config.risk` | String (JSON) | Config loader | Risk parameters |

## Individual Check Functions

```python
# components/risk_checks.py
import json
from decimal import Decimal
from loguru import logger

log = logger.bind(component="risk_manager")

# Code constants — these cannot be changed via config
MAX_CONCURRENT_POSITIONS = 5
MIN_SOL_RESERVE          = Decimal("0.05")   # SOL kept for transaction fees


async def check_no_existing_position(redis, mint: str) -> tuple[bool, str]:
    """
    BUY is only valid if no open position exists for this mint.
    Prevents doubling into an already-open trade.
    """
    exists = await redis.exists(f"state.position.{mint}")
    if exists:
        return False, f"position already open for mint={mint[:8]}..."
    return True, ""


async def check_max_concurrent_positions(redis) -> tuple[bool, str]:
    """
    Enforce global cap on simultaneous open positions.
    Uses redis.keys() — acceptable here because MAX_CONCURRENT_POSITIONS is small (5).
    """
    position_keys = await redis.keys("state.position.*")
    count = len(position_keys)
    if count >= MAX_CONCURRENT_POSITIONS:
        return False, f"max concurrent positions reached ({count}/{MAX_CONCURRENT_POSITIONS})"
    return True, ""


async def check_circuit_breaker(redis, risk_cfg: dict) -> tuple[bool, str]:
    """
    Halt all new entries if cumulative daily loss exceeds the configured threshold,
    OR if daily profit cap has been reached (lock-in gains).

    When triggered:
    - The signal is rejected and ACK'd (not re-queued)
    - bot status is set to "paused" so all other components also stop entering
    - DBWriter resets stats.daily_pnl at midnight UTC via cron

    stats.daily_pnl is updated by DBWriter after every confirmed fill.
    Negative value = net loss. Positive value = net profit.
    """
    daily_pnl    = Decimal(await redis.get("stats.daily_pnl") or "0")
    max_loss     = Decimal(str(risk_cfg.get("max_daily_loss_usdc",   200)))
    max_profit   = Decimal(str(risk_cfg.get("max_daily_profit_usdc", 100)))

    if daily_pnl <= -max_loss:
        log.critical(
            f"CIRCUIT BREAKER TRIGGERED (loss): daily_pnl={daily_pnl} USDC "
            f"exceeds loss limit={max_loss} USDC"
        )
        await redis.set("state.bot.status", "paused")
        return False, f"circuit breaker active (daily loss): daily_pnl={daily_pnl} USDC"

    if daily_pnl >= max_profit:
        log.info(
            f"DAILY PROFIT CAP REACHED: daily_pnl={daily_pnl} USDC "
            f">= max_daily_profit_usdc={max_profit} USDC — locking in gains"
        )
        await redis.set("state.bot.status", "paused")
        return False, f"daily profit cap reached: daily_pnl={daily_pnl} USDC"

    return True, ""


async def check_bot_status(redis) -> tuple[bool, str]:
    """
    Only accept new BUY signals when the bot is in 'running' state.
    'paused' = circuit breaker or manual pause — no new entries.
    'stopped' = emergency stop in progress — no new entries.

    SELL signals bypass this check (handled in _handle_sell — we must close
    positions regardless of status to avoid being stuck with open exposure).
    """
    status = await redis.get("state.bot.status")
    if status != "running":
        return False, f"bot status is '{status}' (must be 'running')"
    return True, ""


async def check_usdc_balance(redis, risk_cfg: dict) -> tuple[bool, str]:
    """
    Wallet must have at least min_viable_position_usdc available.
    Prevents attempting a swap that would fail due to insufficient input amount.
    """
    wallet_usdc = Decimal(await redis.get("state.wallet.usdc_balance") or "0")
    min_viable  = Decimal(str(risk_cfg.get("min_viable_position_usdc", 5)))

    if wallet_usdc < min_viable:
        return False, f"insufficient USDC balance: {wallet_usdc} < {min_viable}"
    return True, ""


async def check_sol_reserve(redis) -> tuple[bool, str]:
    """
    Wallet must retain MIN_SOL_RESERVE SOL at all times for transaction fees.
    Each swap costs ~0.000005 SOL in base fee plus priority fee.
    Reserve of 0.05 SOL covers ~10,000 transactions before manual top-up is needed.
    """
    sol_balance = Decimal(await redis.get("state.wallet.sol_balance") or "0")
    if sol_balance < MIN_SOL_RESERVE:
        return False, (
            f"SOL balance {sol_balance} below reserve {MIN_SOL_RESERVE} — "
            "top up wallet before trading"
        )
    return True, ""
```

## Full Safety Gate

Runs all checks in sequence. Returns `(approved: bool, reason: str)`. First failure short-circuits the remaining checks.

```python
async def safety_gate(redis, mint: str, risk_cfg: dict) -> tuple[bool, str]:
    """
    Run all BUY safety checks in priority order.
    Each check returns (passed: bool, reason: str).
    First failure returns immediately — no further checks run.

    Usage:
        approved, reason = await safety_gate(redis, mint, risk_cfg)
        if not approved:
            log.debug(f"BUY rejected: {reason}")
            await redis.xack("stream.agent.approved", "risk-group", msg_id)
            return
    """
    checks = [
        check_no_existing_position(redis, mint),
        check_max_concurrent_positions(redis),
        check_circuit_breaker(redis, risk_cfg),
        check_bot_status(redis),
        check_usdc_balance(redis, risk_cfg),
        check_sol_reserve(redis),
    ]

    for coro in checks:
        passed, reason = await coro
        if not passed:
            return False, reason

    return True, ""
```

## Integrating the Gate in `_handle_buy`

```python
async def _handle_buy(self, msg_id, data, mint, strategy):
    risk_cfg = json.loads(await self.redis.get("config.risk") or "{}")

    approved, reason = await safety_gate(self.redis, mint, risk_cfg)
    if not approved:
        self.log.debug(f"BUY rejected [{data.get('symbol', mint[:8])}]: {reason}")
        await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
        return

    # ... proceed to position sizing and publish swap
```

## Resetting the Circuit Breaker Manually

The circuit breaker sets `state.bot.status = "paused"` when triggered. To resume trading after investigating the loss:

**Via Redis CLI:**
```bash
# Inspect current state
redis-cli GET stats.daily_pnl
redis-cli GET state.bot.status

# Reset the daily PnL counter (operator decision — verify losses are understood)
redis-cli SET stats.daily_pnl "0"

# Resume the bot
redis-cli SET state.bot.status "running"
```

**Via the bot command stream:**
```bash
# Send RESUME command through the normal command channel
redis-cli XADD stream.commands '*' cmd RESUME
```

CommandListener handles `RESUME` by setting `state.bot.status = "running"` only if `stats.daily_pnl` is above the threshold or the threshold has been manually adjusted.

**Automated midnight reset:**

DBWriter runs a daily cron (via CommandListener) at 00:00:00 UTC:

```python
async def reset_daily_pnl(redis) -> None:
    """Called by DBWriter at midnight UTC."""
    prev = await redis.get("stats.daily_pnl")
    await redis.set("stats.daily_pnl", "0")
    logger.bind(component="db_writer").info(
        f"Daily PnL reset: previous={prev} USDC"
    )
    # Resume bot if it was paused only by the circuit breaker
    status = await redis.get("state.bot.status")
    if status == "paused":
        await redis.set("state.bot.status", "running")
        logger.bind(component="db_writer").info(
            "Bot auto-resumed after daily PnL reset"
        )
```

## Defensive Notes

**Why ACK on rejection, not NACK?**
Rejected signals are intentional — the signal was valid but conditions weren't met. NACK would re-deliver the same message on restart, but by then the signal is stale (token price has moved, liquidity has changed). Always ACK rejections.

**Why `redis.keys()` for position count?**
`state.position.*` count is bounded by `MAX_CONCURRENT_POSITIONS` (5). This is safe. If the key namespace ever grows, switch to a dedicated counter key or a Redis Set tracking open mints.

**Why set `state.bot.status = "paused"` in the circuit breaker check?**
Other components (Strategy's position monitor) check `state.bot.status` before publishing new signals. By setting it to `"paused"` at circuit breaker time, we prevent Strategy from queueing more signals that RiskManager would just discard — reducing pointless stream churn.
