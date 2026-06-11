# Telegram Alerts

## Required Settings

```python
# config/settings.py (pydantic BaseSettings)
class Settings(BaseSettings):
    telegram_bot_token: str = ""   # from env: TELEGRAM_BOT_TOKEN
    telegram_chat_id: str = ""     # from env: TELEGRAM_CHAT_ID — numeric chat ID or @username
    discord_webhook_url: str = ""  # from env: DISCORD_WEBHOOK_URL (optional)

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")
```

Get a bot token from @BotFather on Telegram. Get `chat_id` by sending a message to the bot and calling `https://api.telegram.org/bot{TOKEN}/getUpdates`.

---

## TelegramAlerter Class

```python
# components/telegram_alerter.py
import asyncio
import time
from typing import Optional
import aiohttp
from loguru import logger


class TelegramAlerter:
    """
    Rate-limited, queue-backed Telegram alert sender.

    All alert methods enqueue messages — never block the caller.
    A background worker drains the queue at ≤1 msg per 3 seconds.
    """

    RATE_LIMIT_SECONDS = 3.0   # Telegram flood limit: 30 msg/s per group, 1/s per user
    MAX_QUEUE_SIZE     = 100   # drop oldest if queue overflows

    def __init__(self, settings):
        self.bot_token = settings.telegram_bot_token
        self.chat_id   = settings.telegram_chat_id
        self.discord_url = getattr(settings, "discord_webhook_url", "")
        self._queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self.MAX_QUEUE_SIZE)
        self._last_sent: float = 0.0
        self.log = logger.bind(component="monitor")

    def enqueue(self, text: str) -> None:
        """Non-blocking enqueue. Drops message if queue is full (avoids backpressure)."""
        try:
            self._queue.put_nowait(text)
        except asyncio.QueueFull:
            self.log.warning("Telegram queue full — message dropped")

    async def run(self, stop_event: asyncio.Event) -> None:
        """Background worker: drain queue, respect rate limit."""
        self.log.info("TelegramAlerter worker started")
        while not stop_event.is_set():
            try:
                text = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            # Enforce rate limit
            elapsed = time.monotonic() - self._last_sent
            if elapsed < self.RATE_LIMIT_SECONDS:
                await asyncio.sleep(self.RATE_LIMIT_SECONDS - elapsed)

            await self._send_telegram(text)
            if self.discord_url:
                await self._send_discord(text)
            self._last_sent = time.monotonic()
            self._queue.task_done()

    async def _send_telegram(self, text: str) -> None:
        if not self.bot_token or not self.chat_id:
            self.log.debug("Telegram not configured — skipping alert")
            return
        url = f"https://api.telegram.org/bot{self.bot_token}/sendMessage"
        payload = {
            "chat_id": self.chat_id,
            "text": text,
            "parse_mode": "HTML",   # use <b>, <code> tags in messages
        }
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    url,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=8),
                ) as resp:
                    if resp.status != 200:
                        body = await resp.text()
                        self.log.warning(f"Telegram API error {resp.status}: {body[:120]}")
        except Exception as e:
            self.log.debug(f"Telegram send failed: {e}")

    async def _send_discord(self, text: str) -> None:
        """Strip HTML tags before sending to Discord (no parse_mode)."""
        import re
        clean = re.sub(r"<[^>]+>", "", text)
        payload = {"content": clean}
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(
                    self.discord_url,
                    json=payload,
                    timeout=aiohttp.ClientTimeout(total=8),
                ) as resp:
                    if resp.status not in (200, 204):
                        self.log.warning(f"Discord webhook error {resp.status}")
        except Exception as e:
            self.log.debug(f"Discord send failed: {e}")
```

---

## Alert Templates

Call `alerter.enqueue(...)` from the Monitor's event handlers. Never `await` alert sends directly from the hot path.

### BUY Opened

```python
def fmt_buy_opened(
    symbol: str,
    entry_price: float,
    size_usdc: float,
    strategy: str,
    mint: str,
) -> str:
    return (
        f"✅ <b>BUY {symbol}</b>\n"
        f"Entry: <code>${entry_price:.6f}</code>\n"
        f"Size:  <code>${size_usdc:.2f} USDC</code>\n"
        f"Strategy: {strategy}\n"
        f"Mint: <code>{mint[:8]}…</code>"
    )

# usage
alerter.enqueue(fmt_buy_opened("BONK", 0.00001233, 50.0, "kol_momentum", mint))
```

### SELL Closed

```python
def fmt_sell_closed(
    symbol: str,
    pnl_usdc: float,
    pnl_pct: float,
    reason: str,   # "take_profit" | "stop_loss" | "max_hold_time"
    mint: str,
) -> str:
    emoji = "🟢" if pnl_usdc >= 0 else "🔴"
    reason_label = {
        "take_profit":   "Take Profit",
        "stop_loss":     "Stop Loss",
        "max_hold_time": "Max Hold Time",
        "remove_token":  "Token Removed",
        "emergency_stop":"Emergency Stop",
    }.get(reason, reason)
    return (
        f"{emoji} <b>SELL {symbol}</b>\n"
        f"PnL:    <code>{pnl_usdc:+.2f} USDC ({pnl_pct:+.1f}%)</code>\n"
        f"Reason: {reason_label}\n"
        f"Mint: <code>{mint[:8]}…</code>"
    )
```

### Safety Reject (RiskManager blocked a trade)

```python
def fmt_safety_reject(symbol: str, reason: str) -> str:
    return (
        f"⚠️ <b>SAFETY REJECT: {symbol}</b>\n"
        f"Reason: {reason}"
    )

# Examples of reason strings:
#   "rugpull_detected: top10_holders=67%"
#   "liquidity_too_low: $8200 < $10000 min"
#   "daily_loss_limit_reached"
#   "position_already_open"
```

### Emergency Stop

```python
def fmt_emergency_stop(open_positions: int) -> str:
    return (
        f"🚨 <b>EMERGENCY STOP TRIGGERED</b>\n"
        f"Queued {open_positions} sell order(s).\n"
        f"Bot status: STOPPED"
    )
```

### Circuit Breaker Activated

```python
def fmt_circuit_breaker(daily_loss_usdc: float) -> str:
    return (
        f"💀 <b>CIRCUIT BREAKER ACTIVATED</b>\n"
        f"Daily loss: <code>-${abs(daily_loss_usdc):.2f} USDC</code>\n"
        f"No new positions until midnight UTC."
    )
```

### Position Reconcile Mismatch

```python
def fmt_reconcile_mismatch(mint: str, state_tokens: int, onchain_tokens: int) -> str:
    return (
        f"⚠️ <b>POSITION MISMATCH DETECTED</b>\n"
        f"Mint: <code>{mint[:8]}…</code>\n"
        f"State says: <code>{state_tokens}</code> tokens\n"
        f"On-chain:   <code>{onchain_tokens}</code> tokens\n"
        f"Manual review required."
    )
```

### Daily Summary (see `daily-report.md` for full generation logic)

```python
def fmt_daily_summary(
    date: str,
    total_trades: int,
    wins: int,
    losses: int,
    win_rate: float,
    total_pnl: float,
    best_trade_symbol: str,
    best_trade_pnl: float,
    worst_trade_symbol: str,
    worst_trade_pnl: float,
) -> str:
    pnl_emoji = "🟢" if total_pnl >= 0 else "🔴"
    return (
        f"📊 <b>Daily Summary — {date}</b>\n\n"
        f"Trades:   {total_trades} ({wins}W / {losses}L)\n"
        f"Win Rate: <code>{win_rate:.1f}%</code>\n"
        f"Total PnL: {pnl_emoji} <code>{total_pnl:+.2f} USDC</code>\n\n"
        f"Best:  {best_trade_symbol} <code>{best_trade_pnl:+.2f} USDC</code>\n"
        f"Worst: {worst_trade_symbol} <code>{worst_trade_pnl:+.2f} USDC</code>"
    )
```

---

## Integration in Monitor

```python
# components/monitor.py (excerpt)
class Monitor:
    def __init__(self, redis, settings, alerter: TelegramAlerter):
        self.redis   = redis
        self.settings = settings
        self.alerter = alerter   # injected — alerter.run() is a separate task
        self.log     = logger.bind(component="monitor")

    async def _handle_position_update(self, data_raw: str) -> None:
        try:
            data = json.loads(data_raw)
        except Exception:
            return

        event  = data.get("event", "")
        symbol = data.get("symbol", "")
        mint   = data.get("mint", "")

        if event == "opened":
            msg = fmt_buy_opened(
                symbol,
                float(data.get("entry_price", 0)),
                float(data.get("size_usdc", 0)),
                data.get("strategy", "unknown"),
                mint,
            )
            self.alerter.enqueue(msg)

        elif event == "closed":
            msg = fmt_sell_closed(
                symbol,
                float(data.get("pnl_usdc", 0)),
                float(data.get("pnl_pct", 0)),
                data.get("reason", "unknown"),
                mint,
            )
            self.alerter.enqueue(msg)

        elif event == "reconcile_mismatch":
            msg = fmt_reconcile_mismatch(
                mint,
                int(data.get("state_tokens", 0)),
                int(data.get("onchain_tokens", 0)),
            )
            self.alerter.enqueue(msg)

        elif event == "safety_reject":
            msg = fmt_safety_reject(symbol, data.get("reason", "unknown"))
            self.alerter.enqueue(msg)

        elif event == "emergency_stop":
            msg = fmt_emergency_stop(int(data.get("open_positions", 0)))
            self.alerter.enqueue(msg)

        elif event == "circuit_breaker":
            msg = fmt_circuit_breaker(float(data.get("daily_loss_usdc", 0)))
            self.alerter.enqueue(msg)
```

---

## Wiring in main.py

```python
# main.py (excerpt)
alerter = TelegramAlerter(settings)
monitor = Monitor(redis, settings, alerter)
stop_event = asyncio.Event()

# Both run as named asyncio tasks
tasks = [
    asyncio.create_task(alerter.run(stop_event),  name="monitor.alerter"),
    asyncio.create_task(monitor.run(stop_event),  name="monitor.main"),
    # ... other components
]
```

The `alerter.run()` task must start before `monitor.run()` so the queue is consuming when first alerts arrive. Both are cancelled together when `stop_event` is set.
