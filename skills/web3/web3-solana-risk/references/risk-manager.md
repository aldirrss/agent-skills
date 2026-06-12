# RiskManager

Full implementation of the RiskManager component. Reads `stream.agent.approved` (BUY) and `stream.signals` (SELL passthrough) via XREADGROUP, validates all safety rules, sizes positions, derives slippage, and publishes approved swap requests to `stream.swaps`.

## Class: `RiskManager`

```python
# components/risk_manager.py
import asyncio
import json
import time
import uuid
from decimal import Decimal, ROUND_DOWN

from loguru import logger

# ── Code constants — config cannot override these ─────────────────────────────
MAX_POSITION_USDC        = Decimal("500")
MAX_CONCURRENT_POSITIONS = 5
MIN_SOL_RESERVE          = Decimal("0.05")   # SOL held back for fees

# Per-strategy size multipliers
STRATEGY_MULTIPLIERS: dict[str, Decimal] = {
    "kol_copy_trade":          Decimal("1.0"),
    "graduation_trade":        Decimal("1.0"),
    "smart_money_confluence":  Decimal("1.0"),
    "momentum_spike":          Decimal("0.8"),
    "new_launch_snipe":        Decimal("0.5"),
    "social_alpha":            Decimal("0.5"),
}


class RiskManager:
    CONSUMER = "risk-manager-1"
    GROUP    = "risk-group"

    def __init__(self, redis, settings):
        self.redis    = redis
        self.settings = settings
        self.log      = logger.bind(component="risk_manager")

    # ── Main loop ─────────────────────────────────────────────────────────────

    async def run(self, stop_event: asyncio.Event) -> None:
        """XREADGROUP loop — runs until stop_event is set."""
        self.log.info("RiskManager started")
        await self._ensure_consumer_group()

        while not stop_event.is_set():
            try:
                messages = await self.redis.xreadgroup(
                    self.GROUP,
                    self.CONSUMER,
                    {"stream.agent.approved": ">"},
                    count=1,
                    block=1000,
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.log.warning(f"XREADGROUP error: {exc}")
                await asyncio.sleep(1)
                continue

            for _stream, entries in (messages or []):
                for msg_id, data in entries:
                    await self._process(msg_id, data)

        self.log.info("RiskManager stopped")

    async def _ensure_consumer_group(self) -> None:
        """Create consumer group if it doesn't exist (idempotent)."""
        try:
            await self.redis.xgroup_create(
                "stream.agent.approved", self.GROUP, id="0", mkstream=True
            )
            self.log.debug(f"Consumer group '{self.GROUP}' created")
        except Exception as exc:
            if "BUSYGROUP" not in str(exc):
                raise

    # ── Signal dispatch ───────────────────────────────────────────────────────

    async def _process(self, msg_id: str, data: dict) -> None:
        mint     = data.get("mint", "")
        action   = data.get("action", "")
        strategy = data.get("strategy", "")

        self.log.debug(f"Signal received: action={action} mint={mint[:8]}... strategy={strategy}")

        try:
            if action == "BUY":
                await self._handle_buy(msg_id, data, mint, strategy)
            elif action == "SELL":
                await self._handle_sell(msg_id, data, mint)
            else:
                self.log.warning(f"Unknown action '{action}' — discarding msg_id={msg_id}")
                await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
        except Exception as exc:
            self.log.error(f"Signal processing error: {exc} | msg_id={msg_id} mint={mint[:8]}...")
            # Always ACK to avoid infinite retry loop on a permanently bad message
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)

    # ── BUY handler ───────────────────────────────────────────────────────────

    async def _handle_buy(
        self,
        msg_id: str,
        data: dict,
        mint: str,
        strategy: str,
    ) -> None:
        risk_cfg = json.loads(await self.redis.get("config.risk") or "{}")
        symbol   = data.get("symbol", mint[:8])

        # ── Safety gate ───────────────────────────────────────────────────────

        # 1. No existing position for this mint
        if await self.redis.exists(f"state.position.{mint}"):
            self.log.debug(f"BUY rejected — position exists: {symbol}")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # 2. Max concurrent positions
        position_keys = await self.redis.keys("state.position.*")
        if len(position_keys) >= MAX_CONCURRENT_POSITIONS:
            self.log.debug(
                f"BUY rejected — max concurrent positions ({MAX_CONCURRENT_POSITIONS}) reached"
            )
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # 3. Daily loss circuit breaker
        daily_pnl = Decimal(await self.redis.get("stats.daily_pnl") or "0")
        max_daily_loss = Decimal(str(risk_cfg.get("max_daily_loss_usdc", 200)))
        if daily_pnl <= -max_daily_loss:
            self.log.warning(
                f"BUY rejected — circuit breaker active: daily_pnl={daily_pnl} USDC"
            )
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # 4. Bot must be running
        bot_status = await self.redis.get("state.bot.status")
        if bot_status != "running":
            self.log.debug(f"BUY rejected — bot status is '{bot_status}'")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # 5. Wallet USDC balance check
        wallet_usdc = Decimal(await self.redis.get("state.wallet.usdc_balance") or "0")
        min_viable  = Decimal(str(risk_cfg.get("min_viable_position_usdc", 5)))
        if wallet_usdc < min_viable:
            self.log.warning(f"BUY rejected — insufficient USDC balance: {wallet_usdc}")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # 6. SOL reserve check (fees)
        sol_balance = Decimal(await self.redis.get("state.wallet.sol_balance") or "0")
        if sol_balance < MIN_SOL_RESERVE:
            self.log.warning(
                f"BUY rejected — SOL balance {sol_balance} below reserve {MIN_SOL_RESERVE}"
            )
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # ── Position sizing ───────────────────────────────────────────────────

        confidence = Decimal(str(data.get("confidence", "0.5")))
        size_usdc  = _calculate_size(wallet_usdc, confidence, strategy, risk_cfg)

        if size_usdc <= 0:
            self.log.debug(f"BUY rejected — calculated size is zero: {symbol}")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        # ── Slippage ──────────────────────────────────────────────────────────

        liquidity    = float(data.get("liquidity_usdc", 0))
        slippage_bps = _get_slippage(liquidity)

        # ── Stop loss / take profit prices ────────────────────────────────────
        # SL: liquidity-tiered code constant (SL_TIERS)
        # TP: 2× modal code constant (TAKE_PROFIT_PCT = 1.0)

        entry_price       = Decimal(str(data.get("price_usdc", "0")))
        stop_loss_price   = calculate_stop_loss_price(entry_price, liquidity)
        take_profit_price = calculate_take_profit_price(entry_price)

        # ── Publish to stream.swaps ───────────────────────────────────────────

        swap: dict[str, str] = {
            "swap_id":            f"swp_{uuid.uuid4().hex[:8]}",
            "signal_id":          data.get("signal_id", ""),
            "mint":               mint,
            "symbol":             symbol,
            "side":               "BUY",
            "amount_usdc":        str(size_usdc),
            "slippage_bps":       str(slippage_bps),
            "strategy":           strategy,
            "entry_price":        str(entry_price),
            "stop_loss_price":    str(stop_loss_price),
            "take_profit_price":  str(take_profit_price),
            "ts":                 str(int(time.time() * 1000)),
        }
        await self.redis.xadd("stream.swaps", swap)
        await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)

        self.log.info(
            f"BUY approved: {symbol} | size={size_usdc} USDC | "
            f"slippage={slippage_bps}bps | strategy={strategy} | "
            f"SL={stop_loss_price} TP={take_profit_price}"
        )

    # ── SELL handler ──────────────────────────────────────────────────────────

    async def _handle_sell(self, msg_id: str, data: dict, mint: str) -> None:
        # Position must exist — we derive the token amount to sell from state
        pos_raw = await self.redis.get(f"state.position.{mint}")
        if not pos_raw:
            self.log.debug(f"SELL rejected — no open position for mint={mint[:8]}...")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        pos    = json.loads(pos_raw)
        symbol = pos.get("symbol", mint[:8])
        reason = data.get("reason", "strategy")

        # Emergency/stop-loss sells use maximum slippage to guarantee a fill
        slippage_bps = 1000 if reason in ("stop_loss", "emergency_stop") else 200

        # Sell the full position (amount_tokens from position state)
        amount_tokens = pos.get("amount_tokens", "0")
        if amount_tokens == "0":
            self.log.error(f"SELL rejected — amount_tokens is 0 for {symbol}")
            await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)
            return

        swap: dict[str, str] = {
            "swap_id":       f"swp_{uuid.uuid4().hex[:8]}",
            "signal_id":     data.get("signal_id", ""),
            "mint":          mint,
            "symbol":        symbol,
            "side":          "SELL",
            "amount_tokens": amount_tokens,
            "slippage_bps":  str(slippage_bps),
            "reason":        reason,
            "ts":            str(int(time.time() * 1000)),
        }
        await self.redis.xadd("stream.swaps", swap)
        await self.redis.xack("stream.agent.approved", self.GROUP, msg_id)

        self.log.info(
            f"SELL approved: {symbol} | tokens={amount_tokens} | "
            f"slippage={slippage_bps}bps | reason={reason}"
        )
```

## Module-Level Helpers

These pure functions are defined at module level so they can be unit-tested without instantiating the class.

```python
def _calculate_size(
    wallet_usdc: Decimal,
    confidence: Decimal,
    strategy: str,
    cfg: dict,
) -> Decimal:
    """
    Calculate approved position size in USDC.

    Hard ceiling MAX_POSITION_USDC is enforced here — config cannot raise it.
    """
    base       = Decimal(str(cfg.get("base_position_usdc", 50)))
    max_pct    = Decimal(str(cfg.get("max_wallet_pct", 0.10)))
    multiplier = STRATEGY_MULTIPLIERS.get(strategy, Decimal("1.0"))

    # Scale base by confidence score, then apply strategy multiplier
    sized = base * confidence * multiplier

    # Two soft caps: wallet percentage and absolute code constant
    wallet_cap = wallet_usdc * max_pct
    result     = min(sized, wallet_cap, MAX_POSITION_USDC)

    if result < sized:
        logger.bind(component="risk_manager").debug(
            f"Position size capped: raw={sized:.2f} → approved={result:.2f} USDC "
            f"(wallet_cap={wallet_cap:.2f}, MAX={MAX_POSITION_USDC})"
        )

    return result.quantize(Decimal("0.01"))


def _get_slippage(liquidity_usdc: float) -> int:
    """Derive slippage bps from pool liquidity depth."""
    if liquidity_usdc >= 500_000:
        return 50
    if liquidity_usdc >= 50_000:
        return 100
    if liquidity_usdc >= 10_000:
        return 200
    return 500
```

## Consumer Group Bootstrap

Called from `main.py` `_ensure_consumer_groups()` at startup — idempotent, safe to call multiple times.

```python
async def ensure_risk_consumer_group(redis) -> None:
    try:
        await redis.xgroup_create(
            "stream.agent.approved",
            "risk-group",
            id="0",       # start from beginning to catch any pending messages
            mkstream=True,
        )
    except Exception as exc:
        if "BUSYGROUP" not in str(exc):
            raise
```

## Wiring in main.py

```python
risk_manager = RiskManager(redis=redis, settings=settings)
stop_event   = asyncio.Event()

tasks = [
    asyncio.create_task(risk_manager.run(stop_event), name="risk_manager"),
    # ... other component tasks
]
```

## Full stream.swaps Schema

RiskManager is the sole publisher of `stream.swaps`. Fields written:

| Field | Type | Present on | Description |
|---|---|---|---|
| `swap_id` | str | BUY + SELL | `swp_` + 8-char UUID hex |
| `batch_id` | str | BUY only | Passthrough from `stream.agent.approved` (OrchestratorAgent batch) |
| `mint` | str | BUY + SELL | Token mint address |
| `symbol` | str | BUY + SELL | Human-readable ticker |
| `side` | str | BUY + SELL | `"BUY"` or `"SELL"` |
| `amount_usdc` | str (Decimal) | BUY only | Approved position size |
| `amount_tokens` | str (int) | SELL only | Full position token amount from `state.position.{mint}` |
| `slippage_bps` | str (int) | BUY + SELL | Derived from liquidity or reason |
| `strategy` | str | BUY only | Source strategy name |
| `entry_price` | str (Decimal) | BUY only | Signal price at approval time |
| `stop_loss_price` | str (Decimal) | BUY only | entry × (1 − stop_loss_pct) |
| `take_profit_price` | str (Decimal) | BUY only | entry × (1 + take_profit_pct) |
| `reason` | str | SELL only | `strategy` \| `stop_loss` \| `take_profit` \| `max_hold_time` \| `emergency_stop` |
| `ts` | str (ms epoch) | BUY + SELL | Approval timestamp |
