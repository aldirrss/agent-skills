# PositionTracker & DBWriter

Track open positions and write trade history to PostgreSQL.

## PositionTracker

Consumes `stream.fills`, updates `state.position.*`, reconciles on-chain balances at startup.

```python
# components/position_tracker.py
import asyncio, json, time
from decimal import Decimal
from loguru import logger

class PositionTracker:
    CONSUMER_T = "position-tracker-1"
    GROUP_T    = "tracker-group"

    def __init__(self, redis, db_writer, rpc):
        self.redis  = redis
        self.db     = db_writer
        self.rpc    = rpc
        self.log    = logger.bind(component="position_tracker")

    async def run(self, stop_event: asyncio.Event):
        self.log.info("PositionTracker started")
        while not stop_event.is_set():
            try:
                messages = await self.redis.xreadgroup(
                    self.GROUP_T, self.CONSUMER_T,
                    {"stream.fills": ">"},
                    count=5, block=1000,
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log.warning(f"XREADGROUP error: {e}")
                await asyncio.sleep(1)
                continue

            for _, entries in (messages or []):
                for msg_id, fill in entries:
                    await self._process_fill(fill)
                    await self.redis.xack("stream.fills", self.GROUP_T, msg_id)

    async def _process_fill(self, fill: dict):
        status = fill.get("status", "")
        side   = fill.get("side", "")
        mint   = fill.get("mint", "")

        if status != "confirmed":
            self.log.debug(f"Fill ignored (status={status}): {mint[:8]}")
            return

        if side == "BUY":
            await self._open_position(fill)
        elif side == "SELL":
            await self._close_position(fill)

    async def _open_position(self, fill: dict):
        from utils.risk import calculate_stop_loss_price, calculate_take_profit_price
        risk_cfg = json.loads(await self.redis.get("config.risk") or "{}")

        mint         = fill["mint"]
        price_usdc   = Decimal(fill.get("price_usdc", "0"))
        amount_tokens = fill.get("amount_tokens", "0")

        sl_pct = Decimal(str(risk_cfg.get("stop_loss_pct",  0.15)))
        tp_pct = Decimal(str(risk_cfg.get("take_profit_pct", 0.50)))

        position = {
            "mint":             mint,
            "symbol":           fill.get("symbol", ""),
            "entry_price":      str(price_usdc),
            "stop_loss_price":  str(calculate_stop_loss_price(price_usdc, sl_pct)),
            "take_profit_price":str(calculate_take_profit_price(price_usdc, tp_pct)),
            "amount_tokens":    amount_tokens,
            "amount_usdc_in":   fill.get("amount_usdc", "0"),
            "entry_ts":         fill.get("ts", str(int(time.time() * 1000))),
            "fill_id":          fill.get("fill_id", ""),
        }
        await self.redis.set(f"state.position.{mint}", json.dumps(position))
        await self.redis.sadd("state.bot.tokens", mint)

        await self.redis.publish("position.updates", json.dumps({
            **position,
            "pnl_usdc": "0.00",
            "pnl_pct":  "0.00",
            "event":    "opened",
        }))
        self.log.info(f"Position opened: {fill.get('symbol')} entry={price_usdc}")

    async def _close_position(self, fill: dict):
        mint = fill["mint"]
        pos_raw = await self.redis.get(f"state.position.{mint}")
        if not pos_raw:
            return

        pos = json.loads(pos_raw)
        entry_price  = Decimal(pos["entry_price"])
        exit_price   = Decimal(fill.get("price_usdc", "0"))
        amount_usdc_in = Decimal(pos.get("amount_usdc_in", "0"))

        pnl_pct  = ((exit_price - entry_price) / entry_price * 100) if entry_price > 0 else Decimal("0")
        pnl_usdc = amount_usdc_in * (pnl_pct / 100)

        await self.redis.delete(f"state.position.{mint}")
        await self.redis.srem("state.bot.tokens", mint)

        # update daily PnL stats
        await self.redis.incrbyfloat("stats.daily_pnl", float(pnl_usdc))

        await self.redis.publish("position.updates", json.dumps({
            "mint":      mint,
            "symbol":    pos.get("symbol", ""),
            "pnl_usdc":  str(pnl_usdc.quantize(Decimal("0.01"))),
            "pnl_pct":   str(pnl_pct.quantize(Decimal("0.01"))),
            "event":     "closed",
            "reason":    fill.get("reason", "strategy"),
        }))
        self.log.info(
            f"Position closed: {pos.get('symbol')} "
            f"pnl={pnl_usdc:.2f} USDC ({pnl_pct:.1f}%) "
            f"reason={fill.get('reason')}"
        )

    async def reconcile_on_startup(self, wallet_pubkey: str):
        """Verify state.position.* matches on-chain token balances."""
        self.log.info("Reconciling positions on startup...")
        pos_keys = await self.redis.keys("state.position.*")
        for key in pos_keys:
            mint = key.replace("state.position.", "")
            pos  = json.loads(await self.redis.get(key))
            expected_tokens = int(pos.get("amount_tokens", 0))
            # check on-chain balance
            on_chain = await self._get_token_balance(wallet_pubkey, mint)
            if abs(on_chain - expected_tokens) / max(expected_tokens, 1) > 0.05:
                self.log.warning(
                    f"Position mismatch for {mint[:8]}: "
                    f"state={expected_tokens} on-chain={on_chain} — manual review needed"
                )
                await self.redis.publish("position.updates", json.dumps({
                    "mint": mint, "event": "reconcile_mismatch",
                    "state_tokens": expected_tokens, "onchain_tokens": on_chain,
                }))

    async def _get_token_balance(self, wallet: str, mint: str) -> int:
        from solders.pubkey import Pubkey
        try:
            resp = await self.rpc.get_token_accounts_by_owner(
                Pubkey.from_string(wallet),
                {"mint": Pubkey.from_string(mint)},
            )
            if resp.value:
                return int(resp.value[0].account.data.parsed["info"]["tokenAmount"]["amount"])
        except Exception:
            pass
        return 0
```

## DBWriter

Consumes `stream.fills` (separate consumer group) and writes to PostgreSQL.

```python
# components/db_writer.py
import asyncio, json
from loguru import logger
import asyncpg

class DBWriter:
    CONSUMER = "db-writer-1"
    GROUP    = "db-group"

    def __init__(self, database_url: str):
        self.database_url = database_url
        self.pool = None
        self.log  = logger.bind(component="db_writer")

    async def run(self, stop_event: asyncio.Event):
        self.pool = await asyncpg.create_pool(
            self.database_url.replace("postgresql+asyncpg://", "postgresql://"),
            min_size=1, max_size=5,
        )
        self.log.info("DBWriter started")

        while not stop_event.is_set():
            try:
                messages = await self.redis.xreadgroup(
                    self.GROUP, self.CONSUMER,
                    {"stream.fills": ">"},
                    count=10, block=1000,
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log.warning(f"XREADGROUP error: {e}")
                await asyncio.sleep(1)
                continue

            for _, entries in (messages or []):
                for msg_id, fill in entries:
                    await self._write_fill(fill)
                    await self.redis.xack("stream.fills", self.GROUP, msg_id)

    async def _write_fill(self, fill: dict):
        if not self.pool:
            return
        try:
            async with self.pool.acquire() as conn:
                await conn.execute("""
                    INSERT INTO trades
                        (fill_id, swap_id, mint, symbol, side, status,
                         tx_signature, amount_usdc, amount_tokens, price_usdc,
                         reason, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
                    ON CONFLICT (fill_id) DO NOTHING
                """,
                    fill.get("fill_id"), fill.get("swap_id"),
                    fill.get("mint"), fill.get("symbol"),
                    fill.get("side"), fill.get("status"),
                    fill.get("tx_signature"), float(fill.get("amount_usdc", 0)),
                    int(fill.get("amount_tokens", 0)), float(fill.get("price_usdc", 0)),
                    fill.get("reason"),
                )
        except Exception as e:
            self.log.error(f"DB write failed: {e} | fill_id={fill.get('fill_id')}")
```
