# PositionTracker + DBWriter

Fill processing from stream.fills, 30s reconciliation loop, and async DB persistence.

## Table of contents
- PositionTracker
- DBWriter
- Reconciliation loop

---

## PositionTracker

```python
# components/position_tracker.py
import asyncio
import json
import time
from decimal import Decimal

from logger_setup import component_logger
from config import settings


class PositionTracker:
    """
    Consumes stream.fills (consumer group fill-processors, consumer tracker-1).
    Updates Redis position state and publishes to position.updates pub/sub.
    Also runs the 30s reconciliation loop.
    """

    def __init__(self, redis, db_writer):
        self.redis  = redis
        self.db     = db_writer
        self.log    = component_logger("position_tracker")

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        reconcile_task = asyncio.create_task(
            self._reconcile_loop(stop_event), name="reconcile_loop"
        )
        try:
            await asyncio.gather(
                self._fill_loop(stop_event),
                reconcile_task,
            )
        finally:
            reconcile_task.cancel()
            self.log.info("Stopped")

    async def drain_pending(self) -> None:
        while True:
            entries = await self.redis.xreadgroup(
                groupname="fill-processors", consumername="tracker-1",
                streams={"stream.fills": "0"}, count=50,
            )
            if not entries or not entries[0][1]:
                break
            for _, messages in entries:
                for msg_id, data in messages:
                    await self._process_fill(msg_id, data)

    async def _fill_loop(self, stop_event: asyncio.Event) -> None:
        while not stop_event.is_set():
            try:
                entries = await self.redis.xreadgroup(
                    groupname="fill-processors", consumername="tracker-1",
                    streams={"stream.fills": ">"},
                    count=10, block=200,
                )
                for _, messages in (entries or []):
                    for msg_id, data in messages:
                        await self._process_fill(msg_id, data)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.log.exception("Error in fill loop")

    async def _process_fill(self, msg_id: str, data: dict) -> None:
        symbol  = data["symbol"]
        outcome = data.get("outcome", "filled")
        log     = component_logger("position_tracker", symbol)

        try:
            if outcome == "filled":
                await self._open_position(data, log)
            elif "emergency_close" in outcome or "sl_hit" in outcome or "tp_hit" in outcome:
                await self._close_position(data, outcome, log)
        except Exception:
            log.exception("Error processing fill")
        finally:
            await self.redis.xack("stream.fills", "fill-processors", msg_id)

    async def _open_position(self, data: dict, log) -> None:
        symbol = data["symbol"]
        pos = {
            "symbol":      symbol,
            "direction":   data["direction"],
            "qty":         data["qty_filled"],
            "entry_price": data["avg_price"],
            "sl_price":    data["sl_price"],
            "tp_price":    data.get("tp_price", ""),
            "sl_order_id": data["sl_order_id"],
            "tp_order_id": data.get("tp_order_id", ""),
            "leverage":    data.get("leverage", "5"),
            "opened_at":   data["ts"],
        }
        await self.redis.set(f"state.position.{symbol}", json.dumps(pos))
        await self.redis.publish("position.updates", json.dumps({
            "symbol":  symbol,
            "status":  "open",
            "position": pos,
            "ts":      str(int(time.time() * 1000)),
        }))
        log.info("Position opened",
                 direction=pos["direction"], entry=pos["entry_price"])

    async def _close_position(self, data: dict, outcome: str, log) -> None:
        symbol   = data["symbol"]
        pos_raw  = await self.redis.get(f"state.position.{symbol}")
        if not pos_raw:
            log.warning("Close fill received but no position in Redis")
            return

        pos      = json.loads(pos_raw)
        entry    = Decimal(pos["entry_price"])
        exit_p   = Decimal(data["avg_price"])
        qty      = Decimal(data["qty_filled"])
        direction = pos["direction"]

        sign     = Decimal("1") if direction == "long" else Decimal("-1")
        gross    = sign * (exit_p - entry) * qty
        fee      = Decimal(data.get("fee", "0"))
        net      = gross - fee

        await self.redis.delete(f"state.position.{symbol}")
        await self.redis.publish("position.updates", json.dumps({
            "symbol":   symbol,
            "status":   "closed",
            "outcome":  outcome,
            "net_pnl":  str(net),
            "ts":       str(int(time.time() * 1000)),
        }))
        log.info("Position closed",
                 outcome=outcome, net_pnl=str(net), exit_price=str(exit_p))
```

---

## DBWriter

```python
# components/db_writer.py
import asyncio
import json
import time
from decimal import Decimal
from pathlib import Path

from sqlmodel import select
from sqlalchemy.ext.asyncio import AsyncSession
from logger_setup import component_logger


FALLBACK_LOG = Path("logs/db_fallback.jsonl")


class DBWriter:
    """
    Consumes stream.fills (consumer group fill-processors, consumer db-writer-1).
    Writes to PostgreSQL. On DB failure: logs to fallback file, retries on restart.
    """

    def __init__(self, session_factory):
        self.db  = session_factory
        self.log = component_logger("db_writer")

    async def run(self, stop_event: asyncio.Event) -> None:
        self.log.info("Starting")
        await self._replay_fallback()
        while not stop_event.is_set():
            try:
                entries = await self._get_redis().xreadgroup(
                    groupname="fill-processors", consumername="db-writer-1",
                    streams={"stream.fills": ">"},
                    count=10, block=200,
                )
                for _, messages in (entries or []):
                    for msg_id, data in messages:
                        await self._persist(msg_id, data)
            except asyncio.CancelledError:
                raise
            except Exception:
                self.log.exception("Error in DBWriter loop")
        self.log.info("Stopped")

    async def drain_pending(self) -> None:
        while True:
            entries = await self._get_redis().xreadgroup(
                groupname="fill-processors", consumername="db-writer-1",
                streams={"stream.fills": "0"}, count=50,
            )
            if not entries or not entries[0][1]:
                break
            for _, messages in entries:
                for msg_id, data in messages:
                    await self._persist(msg_id, data)

    async def _persist(self, msg_id: str, data: dict) -> None:
        try:
            async with self.db() as session:
                await self._write_fill(session, data)
                await session.commit()
            await self._get_redis().xack("stream.fills", "fill-processors", msg_id)
        except Exception as e:
            self.log.error("DB write failed, saving to fallback", error=str(e))
            self._write_fallback(msg_id, data)
            # Still ACK — we'll replay from fallback on next start
            try:
                await self._get_redis().xack("stream.fills", "fill-processors", msg_id)
            except Exception:
                pass

    async def _write_fill(self, session: AsyncSession, data: dict) -> None:
        from db.models.trade import Trade, TradeDirection, TradeOutcome
        from db.models.order import Order, OrderRole, OrderStatus, OrderType
        from db.models.snapshot import FundingPayment
        from datetime import datetime, timezone

        outcome = data.get("outcome", "filled")

        if outcome == "filled":
            # Create Trade record (open)
            trade = Trade(
                account_id=int(data.get("account_id", 1)),
                symbol=data["symbol"],
                strategy=data.get("strategy", "unknown"),
                direction=TradeDirection(data["direction"]),
                qty=Decimal(data["qty_filled"]),
                entry_price=Decimal(data["avg_price"]),
                sl_price=Decimal(data["sl_price"]),
                tp_price=Decimal(data["tp_price"]) if data.get("tp_price") else None,
                fee_total=Decimal(data.get("fee", "0")),
                leverage=int(data.get("leverage", 5)),
                risk_pct=Decimal(data.get("risk_pct", "0.01")),
                initial_risk=Decimal("0"),   # computed by RiskManager — store separately
                opened_at=datetime.now(timezone.utc),
            )
            session.add(trade)

        elif any(k in outcome for k in ("sl_hit", "tp_hit", "emergency_close", "manual")):
            # Close existing Trade
            result = await session.exec(
                select(Trade).where(
                    Trade.symbol == data["symbol"],
                    Trade.closed_at.is_(None),
                ).order_by(Trade.opened_at.desc()).limit(1)
            )
            trade = result.first()
            if trade:
                from db.crud.trades import close_trade
                # Build a minimal Order object for the close
                close_order = Order(
                    account_id=trade.account_id,
                    trade_id=trade.id,
                    exchange_order_id=data["order_id"],
                    symbol=data["symbol"],
                    direction=trade.direction,
                    order_type=OrderType.MARKET,
                    role=OrderRole.EMERGENCY_CLOSE if "emergency" in outcome else OrderRole.SL,
                    side="sell" if trade.direction == TradeDirection.LONG else "buy",
                    qty_requested=trade.qty,
                    qty_filled=Decimal(data["qty_filled"]),
                    avg_fill_price=Decimal(data["avg_price"]),
                    fee=Decimal(data.get("fee", "0")),
                    reduce_only=True,
                    status=OrderStatus.FILLED,
                )
                session.add(close_order)
                await session.flush()   # get close_order.id

                outcome_map = {
                    "sl_hit":        TradeOutcome.SL_HIT,
                    "tp_hit":        TradeOutcome.TP_HIT,
                    "emergency_close": TradeOutcome.EMERGENCY_CLOSE,
                    "manual":        TradeOutcome.MANUAL_CLOSE,
                }
                trade_outcome = next(
                    (v for k, v in outcome_map.items() if k in outcome),
                    TradeOutcome.UNKNOWN,
                )
                await close_trade(session, trade.id, close_order, trade_outcome)

    def _write_fallback(self, msg_id: str, data: dict) -> None:
        FALLBACK_LOG.parent.mkdir(parents=True, exist_ok=True)
        with FALLBACK_LOG.open("a") as f:
            f.write(json.dumps({"msg_id": msg_id, "data": data,
                                 "ts": int(time.time())}) + "\n")

    async def _replay_fallback(self) -> None:
        """On startup, retry any fills that failed to write on last run."""
        if not FALLBACK_LOG.exists():
            return
        lines = FALLBACK_LOG.read_text().strip().splitlines()
        if not lines:
            return
        self.log.info("Replaying fallback writes", count=len(lines))
        success = []
        for line in lines:
            entry = json.loads(line)
            try:
                async with self.db() as session:
                    await self._write_fill(session, entry["data"])
                    await session.commit()
                success.append(line)
            except Exception as e:
                self.log.error("Fallback replay failed", error=str(e))
        # Remove successfully replayed lines
        remaining = [l for l in lines if l not in success]
        FALLBACK_LOG.write_text("\n".join(remaining) + ("\n" if remaining else ""))

    def _get_redis(self):
        # Injected at runtime — set by main.py after Redis pool is ready
        return self._redis

    def set_redis(self, redis) -> None:
        self._redis = redis
```

---

## Reconciliation loop

Runs inside PositionTracker every 30 seconds. Detects positions closed by exchange SL/TP without a fill event from the bot.

```python
# Inside PositionTracker class
async def _reconcile_loop(self, stop_event: asyncio.Event) -> None:
    """Detect positions closed by exchange SL/TP (no bot fill event)."""
    import ccxt.async_support as ccxt, os

    while not stop_event.is_set():
        await asyncio.sleep(settings.reconciliation_interval_s)
        try:
            workers = await self.redis.smembers("state.bot.workers")
            for symbol in workers:
                pos_raw = await self.redis.get(f"state.position.{symbol}")
                if not pos_raw:
                    continue    # no tracked position — nothing to check

                pos      = json.loads(pos_raw)
                config   = json.loads(
                    await self.redis.get(f"config.worker.{symbol}") or "{}"
                )

                # Fetch live position from exchange
                ex_name  = config.get("exchange", "binance")
                key_ref  = config.get("api_key_ref", "")
                ExClass  = getattr(ccxt, ex_name)
                ex = ExClass({
                    "apiKey":  os.getenv(key_ref, ""),
                    "secret":  os.getenv(key_ref.replace("KEY","SECRET"), ""),
                    "options": {"defaultType": "future"},
                })
                try:
                    live_positions = await ex.fetch_positions([symbol])
                    live = next(
                        (p for p in live_positions
                         if p["symbol"] == symbol and abs(p["contracts"] or 0) > 0),
                        None,
                    )
                    if live is None:
                        # Exchange shows no position — was closed by SL/TP
                        self.log.info("SL/TP detected via reconciliation", symbol=symbol)
                        await self.redis.xadd("stream.fills", {
                            "symbol":       symbol,
                            "order_id":     "reconciled",
                            "direction":    pos["direction"],
                            "qty_filled":   pos["qty"],
                            "avg_price":    await self.redis.get(f"state.price.{symbol}") or "0",
                            "fee":          "0",
                            "outcome":      "sl_hit",    # best guess; DB can correct
                            "sl_order_id":  "", "tp_order_id": "", "signal_id": "",
                            "ts":           str(int(time.time() * 1000)),
                        }, maxlen=100_000, approximate=True)
                finally:
                    await ex.close()

        except asyncio.CancelledError:
            raise
        except Exception:
            self.log.exception("Error in reconciliation loop")
```
