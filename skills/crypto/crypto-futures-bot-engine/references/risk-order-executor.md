# RiskManager + OrderExecutor

Two sides of the same safety story. RiskManager validates and sizes; OrderExecutor executes and verifies. Read together.

## Table of contents
- RiskManager implementation
- OrderExecutor implementation
- Emergency close
- Lock pattern

---

## RiskManager

```python
# components/risk_manager.py
import asyncio
import json
import time
from decimal import Decimal

import ccxt.async_support as ccxt
from loguru import logger

from config import settings
from logger_setup import component_logger


class RiskManager:
    """
    Consumes stream.signals, validates against all risk rules,
    sizes position, publishes to stream.orders.
    Single instance shared across all symbols.
    """

    def __init__(self, redis, session_factory, cfg):
        self.redis   = redis
        self.db      = session_factory
        self.cfg     = cfg
        self.log     = component_logger("risk_manager")
        self._circuit_breakers: dict[str, "CircuitBreaker"] = {}

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        await self._drain_pending()
        while not stop_event.is_set():
            try:
                entries = await self.redis.xreadgroup(
                    groupname="risk-manager", consumername="risk-1",
                    streams={"stream.signals": ">"},
                    count=5, block=200,
                )
                for _, messages in (entries or []):
                    for msg_id, data in messages:
                        await self._process(msg_id, data)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.log.exception("Error in RiskManager loop")
        self.log.info("Stopped")

    async def _process(self, msg_id: str, data: dict) -> None:
        symbol    = data["symbol"]
        direction = data["direction"]
        log       = component_logger("risk_manager", symbol)

        # ── Gate 1: bot must be running ──────────────────────────────
        status = await self.redis.get("state.bot.status")
        if status != "running":
            return await self._discard(msg_id, "bot_not_running", log)

        # ── Gate 2: no existing position for this symbol ─────────────
        existing = await self.redis.get(f"state.position.{symbol}")
        if existing:
            return await self._discard(msg_id, "position_exists", log)

        # ── Gate 3: open position count limit ────────────────────────
        workers  = await self.redis.smembers("state.bot.workers")
        pos_count = sum(
            1 for s in workers
            if await self.redis.exists(f"state.position.{s}")
        )
        if pos_count >= self.cfg.max_open_positions:
            return await self._discard(msg_id, "max_positions_reached", log)

        # ── Gate 4: pre-entry filters (funding window, extreme funding)
        config    = json.loads(await self.redis.get(f"config.worker.{symbol}") or "{}")
        passed, failed = await _pre_entry_filters(self.redis, symbol, direction, config)
        if not passed:
            return await self._discard(msg_id, f"filter:{','.join(failed)}", log)

        # ── Gate 5: circuit breaker ───────────────────────────────────
        cb = self._get_circuit_breaker(symbol, config)
        equity = await self._fetch_equity(config)
        if not cb.check(equity):
            return await self._discard(msg_id, "circuit_breaker_tripped", log)

        # ── Sizing ───────────────────────────────────────────────────
        entry     = Decimal(data["entry_price"])
        atr       = Decimal(data["atr"])
        risk_pct  = Decimal(str(config.get("risk_pct", self.cfg.max_risk_pct)))
        leverage  = min(int(config.get("leverage", 5)), self.cfg.max_leverage)

        sl_dist   = atr * Decimal("1.5")
        sl_price  = entry - sl_dist if direction == "long" else entry + sl_dist
        qty       = _position_size(equity, risk_pct, entry, sl_price)

        if qty <= 0:
            return await self._discard(msg_id, "qty_zero", log)

        # ── ACK before publishing order (idempotency) ────────────────
        # A missed entry is safer than a double entry.
        await self.redis.xack("stream.signals", "risk-manager", msg_id)

        await self.redis.xadd("stream.orders", {
            "symbol":     symbol,
            "direction":  direction,
            "qty":        str(qty),
            "order_type": "market",
            "limit_price": "",
            "sl_price":   str(sl_price),
            "tp_price":   str(entry + atr * Decimal("3") if direction == "long"
                              else entry - atr * Decimal("3")),
            "strategy":   data["strategy"],
            "signal_id":  msg_id,
            "confidence": data.get("confidence", ""),
            "leverage":   str(leverage),
            "ts":         str(int(time.time() * 1000)),
        }, maxlen=100_000, approximate=True)

        log.info("Order published",
                 direction=direction, qty=str(qty),
                 sl=str(sl_price), leverage=leverage)

    async def _discard(self, msg_id: str, reason: str, log) -> None:
        log.debug("Signal discarded", reason=reason)
        await self.redis.xack("stream.signals", "risk-manager", msg_id)

    def _get_circuit_breaker(self, symbol: str, config: dict) -> "CircuitBreaker":
        if symbol not in self._circuit_breakers:
            self._circuit_breakers[symbol] = CircuitBreaker(
                max_daily_loss_pct=self.cfg.circuit_breaker_daily_loss_pct,
                max_drawdown_pct=self.cfg.circuit_breaker_drawdown_pct,
            )
        return self._circuit_breakers[symbol]

    async def _fetch_equity(self, config: dict) -> Decimal:
        import os
        ex_name  = config.get("exchange", "binance")
        key_ref  = config.get("api_key_ref", "")
        ExClass  = getattr(ccxt, ex_name)
        ex = ExClass({
            "apiKey": os.getenv(key_ref, ""),
            "secret": os.getenv(key_ref.replace("KEY", "SECRET"), ""),
            "options": {"defaultType": "future"},
        })
        balance = await ex.fetch_balance()
        await ex.close()
        return Decimal(str(balance["total"].get("USDT", 0)))

    async def _drain_pending(self) -> None:
        while True:
            entries = await self.redis.xreadgroup(
                groupname="risk-manager", consumername="risk-1",
                streams={"stream.signals": "0"}, count=50,
            )
            if not entries or not entries[0][1]:
                break
            for _, messages in entries:
                for msg_id, data in messages:
                    await self._process(msg_id, data)


def _position_size(equity: Decimal, risk_pct: Decimal,
                    entry: Decimal, stop: Decimal) -> Decimal:
    risk_amount  = equity * risk_pct
    stop_dist    = abs(entry - stop)
    if stop_dist == 0:
        return Decimal("0")
    return risk_amount / stop_dist


class CircuitBreaker:
    def __init__(self, max_daily_loss_pct: Decimal, max_drawdown_pct: Decimal):
        self.max_daily_loss_pct = max_daily_loss_pct
        self.max_drawdown_pct   = max_drawdown_pct
        self.day_start_equity: Decimal | None = None
        self.peak_equity:      Decimal | None = None
        self.halted = False

    def check(self, equity: Decimal) -> bool:
        if self.day_start_equity is None:
            self.day_start_equity = self.peak_equity = equity
        self.peak_equity = max(self.peak_equity, equity)
        daily_loss = (self.day_start_equity - equity) / self.day_start_equity
        drawdown   = (self.peak_equity - equity) / self.peak_equity
        if daily_loss >= self.max_daily_loss_pct or drawdown >= self.max_drawdown_pct:
            self.halted = True
        return not self.halted


async def _pre_entry_filters(redis, symbol: str, direction: str,
                               config: dict) -> tuple[bool, list[str]]:
    import time as _time
    failed = []
    ts_now = int(_time.time())
    next_funding_in = 28800 - (ts_now % 28800)
    if next_funding_in < 900 or next_funding_in > 28800 - 900:
        failed.append("near_funding_window")
    try:
        import ccxt.async_support as ccxt_async, os
        ex_name = config.get("exchange", "binance")
        ExClass = getattr(ccxt_async, ex_name)
        ex = ExClass({"options": {"defaultType": "future"}})
        fr_data = await ex.fetch_funding_rate(symbol)
        await ex.close()
        fr = abs(float(fr_data.get("fundingRate", 0)))
        if fr > 0.001:
            failed.append(f"extreme_funding_{fr:.4f}")
    except Exception:
        pass   # funding check failure is non-fatal
    return len(failed) == 0, failed
```

---

## OrderExecutor

```python
# components/order_executor.py
import asyncio
import json
import time
import os
from decimal import Decimal

import ccxt.async_support as ccxt
from loguru import logger

from logger_setup import component_logger


class OrderExecutor:
    def __init__(self, redis, session_factory, cfg):
        self.redis  = redis
        self.db     = session_factory
        self.cfg    = cfg
        self.log    = component_logger("order_executor")
        self._locks: dict[str, asyncio.Lock] = {}   # one lock per symbol

    def _lock(self, symbol: str) -> asyncio.Lock:
        if symbol not in self._locks:
            self._locks[symbol] = asyncio.Lock()
        return self._locks[symbol]

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        await self._drain_pending()
        while not stop_event.is_set():
            try:
                entries = await self.redis.xreadgroup(
                    groupname="order-executor", consumername="executor-1",
                    streams={"stream.orders": ">"},
                    count=1, block=200,
                )
                for _, messages in (entries or []):
                    for msg_id, data in messages:
                        await self._process(msg_id, data)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.log.exception("Error in OrderExecutor loop")
        self.log.info("Stopped")

    async def _process(self, msg_id: str, data: dict) -> None:
        symbol = data["symbol"]
        log    = component_logger("order_executor", symbol)

        async with self._lock(symbol):   # ← one order at a time per symbol
            ex = await self._make_exchange(data)
            try:
                await self._execute(msg_id, data, ex, log)
            except Exception:
                log.exception("Order execution failed")
                # ACK anyway — do not retry a potentially-placed order
                await self.redis.xack("stream.orders", "order-executor", msg_id)
            finally:
                await ex.close()

    async def _execute(self, msg_id: str, data: dict, ex, log) -> None:
        symbol    = data["symbol"]
        direction = data["direction"]
        side      = "buy" if direction == "long" else "sell"
        qty_s     = ex.amount_to_precision(symbol, float(data["qty"]))
        leverage  = int(data.get("leverage", 5))

        # Set leverage (hard-capped in settings)
        safe_lev = min(leverage, self.cfg.max_leverage)
        await ex.set_leverage(safe_lev, symbol)

        # ── Entry order ──────────────────────────────────────────────
        entry = await ex.create_order(symbol, "market", side, qty_s)
        await _assert_filled(ex, symbol, entry, log)
        avg_price = Decimal(str(entry.get("average") or entry.get("price", 0)))
        fee       = Decimal(str(entry.get("fee", {}).get("cost", 0)))

        log.info("Entry filled",
                 direction=direction, qty=qty_s, avg_price=str(avg_price))

        # ── Stop loss — MUST be placed immediately after entry ───────
        sl_price = ex.price_to_precision(symbol, float(data["sl_price"]))
        sl_side  = "sell" if direction == "long" else "buy"
        try:
            sl_order = await ex.create_order(
                symbol, "stop_market", sl_side, qty_s,
                params={"stopPrice": sl_price, "reduceOnly": True},
            )
        except Exception as e:
            log.error("SL placement FAILED after entry — emergency closing", error=str(e))
            await self.emergency_close(symbol, {
                "direction": direction, "qty": data["qty"]
            }, reason="sl_placement_failed", ex=ex)
            await self.redis.xack("stream.orders", "order-executor", msg_id)
            return

        # ── Take profit (optional) ────────────────────────────────────
        tp_order = None
        if data.get("tp_price"):
            tp_price = ex.price_to_precision(symbol, float(data["tp_price"]))
            try:
                tp_order = await ex.create_order(
                    symbol, "take_profit_market", sl_side, qty_s,
                    params={"stopPrice": tp_price, "reduceOnly": True},
                )
            except Exception as e:
                log.warning("TP placement failed (non-critical)", error=str(e))

        await self.redis.xack("stream.orders", "order-executor", msg_id)

        # ── Publish fill event ────────────────────────────────────────
        await self.redis.xadd("stream.fills", {
            "symbol":       symbol,
            "order_id":     entry["id"],
            "direction":    direction,
            "qty_filled":   str(entry.get("filled", data["qty"])),
            "avg_price":    str(avg_price),
            "fee":          str(fee),
            "outcome":      "filled",
            "sl_order_id":  sl_order["id"],
            "tp_order_id":  tp_order["id"] if tp_order else "",
            "sl_price":     str(data["sl_price"]),
            "tp_price":     str(data.get("tp_price", "")),
            "signal_id":    data.get("signal_id", ""),
            "leverage":     str(safe_lev),
            "risk_pct":     str(data.get("confidence", "")),
            "ts":           str(int(time.time() * 1000)),
        }, maxlen=100_000, approximate=True)

    async def emergency_close(self, symbol: str, pos: dict,
                               reason: str = "manual", ex=None) -> None:
        """Market close a position. Used by CommandListener and SL failure handler."""
        log  = component_logger("order_executor", symbol)
        owns = ex is None
        if owns:
            config_raw = await self.redis.get(f"config.worker.{symbol}")
            config = json.loads(config_raw) if config_raw else {}
            ex = await self._make_exchange(config)
        try:
            direction = pos.get("direction", "long")
            side      = "sell" if direction == "long" else "buy"
            qty       = ex.amount_to_precision(symbol, float(pos.get("qty", 0)))
            close_order = await ex.create_order(
                symbol, "market", side, qty,
                params={"reduceOnly": True},
            )
            log.warning("Emergency close executed", reason=reason,
                        order_id=close_order["id"])
            await self.redis.xadd("stream.fills", {
                "symbol":      symbol,
                "order_id":    close_order["id"],
                "direction":   direction,
                "qty_filled":  qty,
                "avg_price":   str(close_order.get("average", 0)),
                "fee":         str(close_order.get("fee", {}).get("cost", 0)),
                "outcome":     f"emergency_close:{reason}",
                "sl_order_id": "", "tp_order_id": "", "signal_id": "",
                "ts":          str(int(time.time() * 1000)),
            }, maxlen=100_000, approximate=True)
        finally:
            if owns:
                await ex.close()

    async def _make_exchange(self, config_or_data: dict):
        ex_name = config_or_data.get("exchange", "binance")
        key_ref = config_or_data.get("api_key_ref", "")
        ExClass = getattr(ccxt, ex_name)
        ex = ExClass({
            "apiKey":          os.getenv(key_ref, ""),
            "secret":          os.getenv(key_ref.replace("KEY", "SECRET"), ""),
            "enableRateLimit": True,
            "options":         {"defaultType": "future"},
        })
        await ex.load_markets()
        return ex

    async def _drain_pending(self) -> None:
        while True:
            entries = await self.redis.xreadgroup(
                groupname="order-executor", consumername="executor-1",
                streams={"stream.orders": "0"}, count=10,
            )
            if not entries or not entries[0][1]:
                break
            for _, messages in entries:
                for msg_id, data in messages:
                    await self._process(msg_id, data)


async def _assert_filled(ex, symbol: str, order: dict, log,
                          timeout: float = 15.0, poll: float = 0.5) -> dict:
    import asyncio as _asyncio, time as _time
    oid      = order["id"]
    deadline = _time.time() + timeout
    while _time.time() < deadline:
        o = await ex.fetch_order(oid, symbol)
        if o["status"] == "closed":
            return o
        if o["status"] in ("canceled", "rejected", "expired"):
            raise RuntimeError(f"Order {oid} ended with status {o['status']}")
        await _asyncio.sleep(poll)
    raise TimeoutError(f"Order {oid} not filled within {timeout}s")
```
