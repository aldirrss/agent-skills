# Position Manager

Trailing stop, break-even stop, partial TP, and time-based exit — applied to
open positions without human intervention. Read alongside `risk-order-executor.md`
and `position-tracker.md`.

## Table of contents
- Design decisions
- Config schema
- Required additions to existing components (ATR propagation)
- PositionManager component
- OrderExecutor extensions (modify_sl, partial_close)
- PositionTracker extension (partial_close fills)
- main.py integration
- pm_stage reference

---

## Design decisions

**PositionManager calls OrderExecutor directly** (not via a new Redis stream).
Both live in the same asyncio process. The invariant "only OrderExecutor calls
`exchange.create_order`" is preserved — PositionManager decides *what* to do,
OrderExecutor does *how*.

**Polling, not event-driven.** Runs every 10 s. Candle-based strategies on 15m/1h
timeframes do not need sub-second precision here. Price from `state.price.{symbol}`
(updated by DataCollector on every trade, TTL 10 s) is sufficiently fresh.

**pm_stage in Redis state.** Prevents re-applying break-even or trailing activation
across cycles. Always read the latest state before acting — never cache locally.

**ATR propagated from entry.** ATR at the time of entry is stored in
`state.position.{symbol}`. Trailing distance uses this value so the stop
width adapts to the volatility that was present when the position was sized.

---

## Config schema

Added to `config.worker.{symbol}` alongside existing strategy config:

```python
# Full worker config with PM block
{
    "strategy":   "trend",
    "leverage":   5,
    "risk_pct":   0.01,
    "timeframes": ["1h", "15m"],
    "exchange":   "binance",
    "api_key_ref": "BINANCE_MAIN_API_KEY",

    # ── Position management (optional — omit to disable entirely) ────
    "position_management": {
        "enabled": True,

        # Move SL to entry + small buffer when unrealized PnL reaches 1R
        "break_even": {
            "trigger_r":  1.0,      # R at which break-even fires
            "buffer_pct": 0.001,    # 0.1% above/below entry — avoids zero-risk tick stop
        },

        # After 1.5R, trail SL behind price by 1x ATR
        "trailing_stop": {
            "enabled":        True,
            "activate_r":     1.5,   # R at which trailing begins
            "trail_atr_mult": 1.0,   # trail distance = ATR * mult
        },

        # Close 50% of position at 2R; remaining uses break-even + trailing
        "partial_tp": {
            "enabled": True,
            "tp1_r":   2.0,   # R at which partial close fires
            "tp1_pct": 0.5,   # fraction of qty to close
        },

        # Close position if open > 24h without reaching 1R
        "time_exit": {
            "enabled":      True,
            "max_hours":    24,
            "min_r_to_skip": 1.0,   # skip time exit if unrealized_r >= this
        },
    }
}
```

---

## Required additions to existing components

Three small changes are needed to propagate `atr` from signal → order → fill → state.

### 1. RiskManager — add `atr` to stream.orders

```python
# risk-order-executor.md → RiskManager._process()
# In the xadd("stream.orders", ...) call, add one field:
await self.redis.xadd("stream.orders", {
    ...
    "atr":      str(atr),    # ← ADD THIS
    "leverage": str(leverage),
    "ts":       str(int(time.time() * 1000)),
}, ...)
```

### 2. OrderExecutor — forward `atr` to stream.fills

```python
# risk-order-executor.md → OrderExecutor._execute()
# In the xadd("stream.fills", ...) call, add one field:
await self.redis.xadd("stream.fills", {
    ...
    "atr":          data.get("atr", ""),    # ← ADD THIS
    "sl_price":     str(data["sl_price"]),
    ...
}, ...)
```

### 3. PositionTracker — store `atr` in state.position

```python
# position-tracker.md → PositionTracker._open_position()
pos = {
    ...
    "leverage":    data.get("leverage", "5"),
    "atr":         data.get("atr", ""),     # ← ADD THIS
    "opened_at":   data["ts"],
    "pm_stage":    "initial",               # ← ADD THIS
    "pm_trail_peak": "",                    # ← ADD THIS (empty until trailing active)
    "partial_tp_done": False,               # ← ADD THIS
}
```

---

## PositionManager component

```python
# components/position_manager.py
import asyncio
import json
import time
from decimal import Decimal

from logger_setup import component_logger
from config import settings


class PositionManager:
    """
    Monitors open positions every PM_CHECK_INTERVAL_S seconds.
    Applies break-even, trailing stop, partial TP, and time exit rules.
    Calls OrderExecutor directly — no new Redis stream.
    """

    def __init__(self, redis, registry, order_executor):
        self.redis          = redis
        self.registry       = registry
        self.order_executor = order_executor
        self.log            = component_logger("position_manager")

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        while not stop_event.is_set():
            await asyncio.sleep(settings.pm_check_interval_s)   # default 10
            try:
                await self._check_all()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.log.exception("Position manager cycle error")
        self.log.info("Stopped")

    # ── Main cycle ───────────────────────────────────────────────────

    async def _check_all(self) -> None:
        for symbol in self.registry.all_symbols():
            try:
                await self._check_position(symbol)
            except Exception:
                self.log.exception("PM check error", symbol=symbol)

    async def _check_position(self, symbol: str) -> None:
        pos_raw = await self.redis.get(f"state.position.{symbol}")
        if not pos_raw:
            return

        pos     = json.loads(pos_raw)
        config  = json.loads(await self.redis.get(f"config.worker.{symbol}") or "{}")
        pm_cfg  = config.get("position_management", {})
        if not pm_cfg.get("enabled"):
            return

        price_raw = await self.redis.get(f"state.price.{symbol}")
        if not price_raw:
            return   # DataCollector not running yet — skip cycle

        current   = Decimal(price_raw)
        entry     = Decimal(pos["entry_price"])
        sl        = Decimal(pos["sl_price"])
        atr       = Decimal(pos.get("atr") or "0")
        direction = pos["direction"]
        stage     = pos.get("pm_stage", "initial")
        partial_done = bool(pos.get("partial_tp_done", False))
        opened_ms    = int(pos.get("opened_at") or "0")

        stop_dist = abs(entry - sl)
        if stop_dist == 0:
            return   # no risk distance — can't calculate R

        sign         = Decimal("1") if direction == "long" else Decimal("-1")
        unrealized_r = sign * (current - entry) / stop_dist

        # ── Rule 1: Time exit ────────────────────────────────────────
        te_cfg = pm_cfg.get("time_exit", {})
        if te_cfg.get("enabled") and opened_ms > 0:
            elapsed_h   = (int(time.time() * 1000) - opened_ms) / 3_600_000
            min_r_skip  = Decimal(str(te_cfg.get("min_r_to_skip", 1.0)))
            max_hours   = float(te_cfg.get("max_hours", 24))
            if elapsed_h >= max_hours and unrealized_r < min_r_skip:
                self.log.info("Time exit triggered", symbol=symbol,
                              elapsed_h=round(elapsed_h, 1),
                              unrealized_r=round(float(unrealized_r), 2))
                await self.order_executor.emergency_close(
                    symbol, pos, reason="time_exit"
                )
                return

        # ── Rule 2: Trailing stop (active stage) ─────────────────────
        trail_cfg = pm_cfg.get("trailing_stop", {})
        if trail_cfg.get("enabled") and stage == "trailing_active":
            await self._apply_trailing_stop(symbol, pos, trail_cfg,
                                             current, direction, atr, sign)
            return

        # ── Rule 3: Activate trailing stop ───────────────────────────
        if trail_cfg.get("enabled") and stage in ("initial", "break_even_set",
                                                    "partial_tp_done"):
            activate_r = Decimal(str(trail_cfg.get("activate_r", "1.5")))
            if unrealized_r >= activate_r:
                await self._apply_trailing_stop(symbol, pos, trail_cfg,
                                                 current, direction, atr, sign,
                                                 first_activation=True)
                return

        # ── Rule 4: Break-even ────────────────────────────────────────
        be_cfg = pm_cfg.get("break_even", {})
        if be_cfg and stage == "initial":
            be_r = Decimal(str(be_cfg.get("trigger_r", "1.0")))
            if unrealized_r >= be_r:
                await self._apply_break_even(symbol, pos, be_cfg, entry, sl,
                                              direction)
                return

        # ── Rule 5: Partial TP ────────────────────────────────────────
        ptp_cfg = pm_cfg.get("partial_tp", {})
        if ptp_cfg.get("enabled") and not partial_done:
            tp1_r = Decimal(str(ptp_cfg.get("tp1_r", "2.0")))
            if unrealized_r >= tp1_r:
                await self._apply_partial_tp(symbol, pos, ptp_cfg)

    # ── Rule implementations ─────────────────────────────────────────

    async def _apply_break_even(self, symbol: str, pos: dict, be_cfg: dict,
                                  entry: Decimal, current_sl: Decimal,
                                  direction: str) -> None:
        buffer     = entry * Decimal(str(be_cfg.get("buffer_pct", "0.001")))
        new_sl     = (entry + buffer) if direction == "long" else (entry - buffer)

        # Only improve SL — never move it further away
        if direction == "long"  and new_sl <= current_sl:
            return
        if direction == "short" and new_sl >= current_sl:
            return

        success = await self.order_executor.modify_sl(
            symbol, pos, new_sl, reason="break_even"
        )
        if success:
            await self._patch_position(symbol, {
                "sl_price": str(new_sl),
                "pm_stage": "break_even_set",
            })
            self.log.info("Break-even set", symbol=symbol, new_sl=str(new_sl))

    async def _apply_trailing_stop(self, symbol: str, pos: dict, trail_cfg: dict,
                                     current: Decimal, direction: str,
                                     atr: Decimal, sign: Decimal,
                                     first_activation: bool = False) -> None:
        if atr == 0:
            self.log.warning("ATR is zero — trailing stop skipped", symbol=symbol)
            return

        trail_dist = atr * Decimal(str(trail_cfg.get("trail_atr_mult", "1.0")))

        # Restore or initialise the peak price
        raw_peak = pos.get("pm_trail_peak")
        peak     = Decimal(raw_peak) if raw_peak else current

        if first_activation:
            peak = current
        else:
            # Advance peak in the profit direction only
            peak = max(peak, current) if direction == "long" else min(peak, current)

        new_sl     = (peak - trail_dist) if direction == "long" else (peak + trail_dist)
        current_sl = Decimal(pos["sl_price"])

        # SL improved if it moved closer to (not past) current price
        sl_improved = (direction == "long"  and new_sl > current_sl) or \
                      (direction == "short" and new_sl < current_sl)

        updates: dict = {
            "pm_stage":      "trailing_active",
            "pm_trail_peak": str(peak),
        }

        if sl_improved:
            success = await self.order_executor.modify_sl(
                symbol, pos, new_sl, reason="trailing"
            )
            if success:
                updates["sl_price"] = str(new_sl)
                self.log.info("Trailing SL updated",
                              symbol=symbol, new_sl=str(new_sl), peak=str(peak))

        await self._patch_position(symbol, updates)

    async def _apply_partial_tp(self, symbol: str, pos: dict,
                                  ptp_cfg: dict) -> None:
        qty       = Decimal(pos["qty"])
        close_pct = Decimal(str(ptp_cfg.get("tp1_pct", "0.5")))
        close_qty = (qty * close_pct).quantize(Decimal("0.0001"))

        if close_qty <= 0 or close_qty >= qty:
            return

        success = await self.order_executor.partial_close(
            symbol, pos, close_qty, reason="partial_tp"
        )
        if success:
            remaining = qty - close_qty
            await self._patch_position(symbol, {
                "qty":            str(remaining),
                "partial_tp_done": True,
                "pm_stage":       "partial_tp_done",
            })
            self.log.info("Partial TP executed",
                          symbol=symbol, closed=str(close_qty),
                          remaining=str(remaining))

    # ── Helpers ──────────────────────────────────────────────────────

    async def _patch_position(self, symbol: str, updates: dict) -> None:
        """Atomic read-modify-write on state.position.{symbol}."""
        raw = await self.redis.get(f"state.position.{symbol}")
        if not raw:
            return   # position closed between check and patch — ok
        pos = json.loads(raw)
        pos.update(updates)
        await self.redis.set(f"state.position.{symbol}", json.dumps(pos))
```

---

## OrderExecutor extensions

Add these two methods to the `OrderExecutor` class in `risk-order-executor.md`.
Both use the existing `self._lock(symbol)` — no concurrent order placement risk.

```python
# components/order_executor.py — add to OrderExecutor class

async def modify_sl(self, symbol: str, pos: dict,
                     new_sl: Decimal, reason: str = "pm") -> bool:
    """
    Cancel existing SL order, place new SL at new_sl.
    Returns True on success. On failure, the old SL may already be gone —
    the monitoring skill fires a CRITICAL alert in that case.

    CRITICAL edge case: if cancel succeeds but new placement fails,
    the position has NO stop loss. This is handled by:
    1. Publishing an alert to bot.status (monitoring picks it up)
    2. Attempting emergency_close as last resort
    """
    log = component_logger("order_executor", symbol)

    async with self._lock(symbol):
        ex = await self._make_exchange(pos)
        try:
            # ── Cancel old SL ────────────────────────────────────────
            old_sl_id = pos.get("sl_order_id", "")
            if old_sl_id:
                try:
                    await ex.cancel_order(old_sl_id, symbol)
                except ccxt.OrderNotFound:
                    # SL already hit — position may have closed between cycles
                    log.warning("Old SL not found; position likely closed",
                                sl_id=old_sl_id)
                    return False

            # ── Place new SL ──────────────────────────────────────────
            sl_side  = "sell" if pos["direction"] == "long" else "buy"
            qty_s    = ex.amount_to_precision(symbol, float(pos["qty"]))
            sl_str   = ex.price_to_precision(symbol, float(new_sl))

            try:
                new_order = await ex.create_order(
                    symbol, "stop_market", sl_side, qty_s,
                    params={"stopPrice": sl_str, "reduceOnly": True},
                )
            except Exception as e:
                # Old SL cancelled, new one failed — UNPROTECTED POSITION
                log.error("New SL placement failed after cancel — UNPROTECTED",
                          error=str(e), reason=reason)
                await self.redis.publish("bot.status", json.dumps({
                    "status":  "error",
                    "message": f"sl_placement_failed after modify: {symbol} — {e}",
                    "ts":      str(int(time.time() * 1000)),
                }))
                # Last resort: close position entirely
                await self.emergency_close(symbol, pos,
                                           reason="sl_modify_failed", ex=ex)
                return False

            # Update sl_order_id in Redis (pm_stage/sl_price updated by caller)
            raw = await self.redis.get(f"state.position.{symbol}")
            if raw:
                current = json.loads(raw)
                current["sl_order_id"] = new_order["id"]
                await self.redis.set(f"state.position.{symbol}",
                                      json.dumps(current))

            log.info("SL modified", reason=reason, new_sl=sl_str,
                     new_id=new_order["id"])
            return True

        except Exception:
            log.exception("modify_sl unexpected error")
            return False
        finally:
            await ex.close()


async def partial_close(self, symbol: str, pos: dict,
                         close_qty: Decimal,
                         reason: str = "partial_tp") -> bool:
    """
    Market-close a portion of the open position.
    After partial close:
      - Cancels existing TP
      - Places new TP for remaining qty (if original TP was set)
      - Publishes partial fill to stream.fills
    PositionTracker handles the state update from the fill event.
    """
    log = component_logger("order_executor", symbol)

    async with self._lock(symbol):
        ex = await self._make_exchange(pos)
        try:
            side    = "sell" if pos["direction"] == "long" else "buy"
            close_s = ex.amount_to_precision(symbol, float(close_qty))

            # ── Cancel existing TP ────────────────────────────────────
            old_tp_id = pos.get("tp_order_id", "")
            if old_tp_id:
                try:
                    await ex.cancel_order(old_tp_id, symbol)
                except ccxt.OrderNotFound:
                    pass   # already hit (race condition) — fill loop will handle

            # ── Partial market close ──────────────────────────────────
            close_order = await ex.create_order(
                symbol, "market", side, close_s,
                params={"reduceOnly": True},
            )
            await _assert_filled(ex, symbol, close_order, log)

            avg_price = Decimal(str(close_order.get("average") or
                                    close_order.get("price", 0)))
            fee       = Decimal(str(close_order.get("fee", {}).get("cost", 0)))
            remaining = Decimal(pos["qty"]) - close_qty

            # ── Re-place TP for remaining qty ─────────────────────────
            new_tp_id = ""
            if pos.get("tp_price") and remaining > 0:
                rem_s    = ex.amount_to_precision(symbol, float(remaining))
                tp_str   = ex.price_to_precision(symbol, float(pos["tp_price"]))
                try:
                    tp_order  = await ex.create_order(
                        symbol, "take_profit_market", side, rem_s,
                        params={"stopPrice": tp_str, "reduceOnly": True},
                    )
                    new_tp_id = tp_order["id"]
                except Exception as e:
                    log.warning("TP re-placement failed (non-critical)", error=str(e))

            # ── Publish partial fill ──────────────────────────────────
            await self.redis.xadd("stream.fills", {
                "symbol":       symbol,
                "order_id":     close_order["id"],
                "direction":    pos["direction"],
                "qty_filled":   str(close_qty),
                "avg_price":    str(avg_price),
                "fee":          str(fee),
                "outcome":      f"partial_close:{reason}",
                "sl_order_id":  pos.get("sl_order_id", ""),
                "tp_order_id":  new_tp_id,
                "signal_id":    "",
                "ts":           str(int(time.time() * 1000)),
            }, maxlen=100_000, approximate=True)

            log.info("Partial close executed", reason=reason,
                     closed=str(close_qty), remaining=str(remaining),
                     avg_price=str(avg_price))
            return True

        except Exception:
            log.exception("partial_close error")
            return False
        finally:
            await ex.close()
```

---

## PositionTracker extension

Add `partial_close` handling to `_process_fill` in `position-tracker.md`:

```python
# position-tracker.md → PositionTracker._process_fill()
# Replace the existing if/elif block:

async def _process_fill(self, msg_id: str, data: dict) -> None:
    symbol  = data["symbol"]
    outcome = data.get("outcome", "filled")
    log     = component_logger("position_tracker", symbol)

    try:
        if outcome == "filled":
            await self._open_position(data, log)

        elif outcome.startswith("partial_close:"):
            await self._partial_close_position(data, log)   # ← NEW

        elif any(k in outcome for k in
                 ("emergency_close", "sl_hit", "tp_hit", "manual", "time_exit")):
            await self._close_position(data, outcome, log)

    except Exception:
        log.exception("Error processing fill")
    finally:
        await self.redis.xack("stream.fills", "fill-processors", msg_id)


async def _partial_close_position(self, data: dict, log) -> None:
    """
    Partial close: reduce position qty, update tp_order_id, publish updated state.
    Does NOT delete state.position — position is still open with reduced size.
    PositionManager has already updated qty and partial_tp_done in Redis;
    this method publishes the updated state to the dashboard.
    """
    symbol = data["symbol"]
    raw    = await self.redis.get(f"state.position.{symbol}")
    if not raw:
        log.warning("Partial close fill received but no position in Redis")
        return

    pos = json.loads(raw)

    # Sync tp_order_id if re-placed by OrderExecutor
    if data.get("tp_order_id"):
        pos["tp_order_id"] = data["tp_order_id"]
        await self.redis.set(f"state.position.{symbol}", json.dumps(pos))

    # Notify dashboard of updated position (qty reduced)
    await self.redis.publish("position.updates", json.dumps({
        "symbol":    symbol,
        "status":    "open",           # still open
        "position":  pos,
        "event":     "partial_close",
        "closed_qty": data["qty_filled"],
        "avg_price":  data["avg_price"],
        "ts":         str(int(time.time() * 1000)),
    }))

    log.info("Partial close processed",
             closed_qty=data["qty_filled"], remaining=pos["qty"])
```

---

## main.py integration

```python
# main.py — additions only

from components.position_manager import PositionManager

# ── Shared components (add after order_executor definition) ─────────
position_manager = PositionManager(redis, registry, order_executor)

# ── Task list (add one entry) ────────────────────────────────────────
tasks = [
    ...   # existing tasks
    asyncio.create_task(position_manager.run(stop_event), name="position_manager"),
]
```

### config.py addition

```python
# config.py — add to Settings
pm_check_interval_s: int = Field(default=10,
    description="How often PositionManager polls open positions")
```

---

## pm_stage reference

| Stage | Meaning | Next transition |
|---|---|---|
| `"initial"` | Position just opened, no PM applied | → `break_even_set` or `partial_tp_done` or `trailing_active` |
| `"break_even_set"` | SL moved to entry + buffer | → `trailing_active` when activate_r reached |
| `"partial_tp_done"` | 50% closed, remaining position continues | → `break_even_set` or `trailing_active` |
| `"trailing_active"` | Trailing stop active, peak tracked | Terminal — stays until position closes |

Transitions are one-way and monotonically improve the risk position.
A position can skip stages: if price jumps directly to 3R, trailing activates
without passing through break-even first.

## Safety invariant

`modify_sl` cancels the old SL **first**. If the new placement fails:
1. An alert is published to `bot.status` → monitoring fires CRITICAL
2. `emergency_close` is called immediately

There is a brief window between cancel and new placement where the position
has no stop. This is unavoidable with REST-based order modification. To minimize
this window, `modify_sl` does not do any IO between the two calls except the
placement itself. The window is typically < 200 ms.
