# CommandListener & Monitor

## CommandListener

Reads `stream.commands` and controls bot state at runtime.

```python
# components/command_listener.py
import asyncio, json, time
from loguru import logger

class CommandListener:
    CONSUMER = "command-listener-1"
    GROUP    = "cmd-group"

    def __init__(self, redis, stop_event: asyncio.Event):
        self.redis      = redis
        self.stop_event = stop_event
        self._start_event = asyncio.Event()
        self.log = logger.bind(component="command_listener")

    async def wait_for_start(self):
        """Block main.py until START command received."""
        self.log.info("Waiting for START command (send via Redis or CLI)")
        await self._start_event.wait()

    async def run(self):
        self.log.info("CommandListener started")
        while True:
            try:
                messages = await self.redis.xreadgroup(
                    self.GROUP, self.CONSUMER,
                    {"stream.commands": ">"},
                    count=1, block=1000,
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                self.log.warning(f"XREADGROUP error: {e}")
                await asyncio.sleep(1)
                continue

            for _, entries in (messages or []):
                for msg_id, data in entries:
                    await self._handle(data)
                    await self.redis.xack("stream.commands", self.GROUP, msg_id)

    async def _handle(self, data: dict):
        cmd = data.get("cmd", "").upper()
        self.log.info(f"Command received: {cmd}")

        if cmd == "START":
            status = await self.redis.get("state.bot.status")
            if status == "stopped":
                self._start_event.set()

        elif cmd == "STOP":
            await self.redis.set("state.bot.status", "stopped")
            self.stop_event.set()

        elif cmd == "PAUSE":
            await self.redis.set("state.bot.status", "paused")

        elif cmd == "RESUME":
            await self.redis.set("state.bot.status", "running")

        elif cmd == "EMERGENCY_STOP":
            await self._emergency_stop()

        elif cmd == "ADD_TOKEN":
            payload = json.loads(data.get("payload", "{}"))
            mint   = payload.get("mint", "")
            symbol = payload.get("symbol", "")
            if mint:
                await self.redis.sadd("state.bot.tokens", mint)
                await self.redis.set(f"token.symbol.{mint}", symbol)
                self.log.info(f"Token added: {symbol} {mint[:8]}")

        elif cmd == "REMOVE_TOKEN":
            payload = json.loads(data.get("payload", "{}"))
            mint = payload.get("mint", "")
            if mint:
                await self.redis.srem("state.bot.tokens", mint)
                # if open position exists, trigger SELL via signal
                if await self.redis.get(f"state.position.{mint}"):
                    await self.redis.xadd("stream.signals", {
                        "action": "SELL", "mint": mint, "reason": "remove_token",
                        "ts": str(int(time.time() * 1000)),
                    })
                self.log.info(f"Token removed: {mint[:8]}")

        elif cmd == "UPDATE_CONFIG":
            payload = json.loads(data.get("payload", "{}"))
            key   = payload.get("key", "")
            value = payload.get("value", {})
            if key and value:
                await self.redis.set(key, json.dumps(value))
                self.log.info(f"Config updated: {key}")

    async def _emergency_stop(self):
        self.log.critical("EMERGENCY STOP initiated")
        await self.redis.set("state.bot.status", "stopped")

        # sell all open positions
        pos_keys = await self.redis.keys("state.position.*")
        for key in pos_keys:
            mint = key.replace("state.position.", "")
            await self.redis.xadd("stream.signals", {
                "action": "SELL", "mint": mint,
                "reason": "emergency_stop",
                "ts": str(int(time.time() * 1000)),
            })
        self.log.critical(f"EMERGENCY STOP: queued {len(pos_keys)} sell orders")
        self.stop_event.set()
```

## Monitor (Health Heartbeat + Alerts)

```python
# components/monitor.py
import asyncio, json, time
import aiohttp
from loguru import logger

class Monitor:
    def __init__(self, redis, settings):
        self.redis    = redis
        self.settings = settings
        self.log      = logger.bind(component="monitor")

    async def run(self, stop_event: asyncio.Event):
        self.log.info("Monitor started")
        pubsub = self.redis.pubsub()
        await pubsub.subscribe("position.updates")

        heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(stop_event), name="monitor.heartbeat"
        )
        daily_reset_task = asyncio.create_task(
            self._daily_reset_loop(stop_event), name="monitor.daily_reset"
        )

        try:
            async for message in pubsub.listen():
                if stop_event.is_set():
                    break
                if message["type"] != "message":
                    continue
                await self._handle_position_update(message["data"])
        finally:
            await pubsub.unsubscribe()
            heartbeat_task.cancel()
            daily_reset_task.cancel()

    async def _heartbeat_loop(self, stop_event: asyncio.Event):
        while not stop_event.is_set():
            await self.redis.set("state.bot.heartbeat", int(time.time()), ex=60)
            await asyncio.sleep(30)

    async def _daily_reset_loop(self, stop_event: asyncio.Event):
        """Reset daily PnL counter at midnight UTC."""
        while not stop_event.is_set():
            now = time.gmtime()
            seconds_to_midnight = 86400 - (now.tm_hour * 3600 + now.tm_min * 60 + now.tm_sec)
            await asyncio.sleep(seconds_to_midnight)
            await self.redis.set("stats.daily_pnl", "0")
            self.log.info("Daily PnL counter reset")

    async def _handle_position_update(self, data_raw: str):
        try:
            data = json.loads(data_raw)
        except Exception:
            return

        event  = data.get("event", "")
        symbol = data.get("symbol", "")
        mint   = data.get("mint", "")

        if event == "opened":
            entry = data.get("entry_price", "?")
            msg = f"✅ BUY {symbol} | entry ${entry} | {mint[:8]}"
            self.log.info(msg)
            await self._send_telegram(msg)

        elif event == "closed":
            pnl_usdc = float(data.get("pnl_usdc", 0))
            pnl_pct  = float(data.get("pnl_pct", 0))
            reason   = data.get("reason", "")
            emoji    = "🟢" if pnl_usdc >= 0 else "🔴"
            msg = (
                f"{emoji} SELL {symbol} | "
                f"PnL: {pnl_usdc:+.2f} USDC ({pnl_pct:+.1f}%) | "
                f"reason: {reason}"
            )
            self.log.info(msg)
            await self._send_telegram(msg)

        elif event == "reconcile_mismatch":
            msg = f"⚠️ Position mismatch: {mint[:8]} — manual review needed"
            self.log.warning(msg)
            await self._send_telegram(msg)

    async def _send_telegram(self, text: str):
        bot_token = getattr(self.settings, "telegram_bot_token", "")
        chat_id   = getattr(self.settings, "telegram_chat_id", "")
        if not bot_token or not chat_id:
            return
        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(url, json={"chat_id": chat_id, "text": text}, timeout=aiohttp.ClientTimeout(total=5))
        except Exception as e:
            self.log.debug(f"Telegram alert failed: {e}")
```

## Sending Commands (CLI / Redis)

```bash
# Start bot
redis-cli XADD stream.commands '*' cmd START payload '{}'

# Emergency stop
redis-cli XADD stream.commands '*' cmd EMERGENCY_STOP payload '{}'

# Add a token to watchlist
redis-cli XADD stream.commands '*' cmd ADD_TOKEN payload '{"mint":"ABC...123","symbol":"BONK"}'

# Pause without closing positions
redis-cli XADD stream.commands '*' cmd PAUSE payload '{}'
```
