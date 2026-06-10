# Telegram + Email

Setup and implementation for both notification channels.

## Table of contents
- Notifier class (unified interface)
- Telegram setup
- Email setup (SMTP + SendGrid)
- Rate limiting
- Notifier wiring

---

## Notifier class

```python
# alerts/notifier.py
import asyncio
from logger_setup import component_logger

log = component_logger("notifier")


class Notifier:
    """
    Unified notification interface. send_critical/warning/info
    routes to correct channels per severity.
    """

    def __init__(self, telegram: "TelegramNotifier",
                 email: "EmailNotifier"):
        self.telegram = telegram
        self.email    = email

    async def send_critical(self, message: str, title: str) -> None:
        """CRITICAL: both Telegram and Email, immediately."""
        await asyncio.gather(
            self._safe(self.telegram.send(message)),
            self._safe(self.email.send(title, message, priority="high")),
            return_exceptions=True,
        )

    async def send_warning(self, message: str, title: str) -> None:
        """WARNING: Telegram + Email."""
        await asyncio.gather(
            self._safe(self.telegram.send(message)),
            self._safe(self.email.send(title, message)),
            return_exceptions=True,
        )

    async def send_info(self, message: str) -> None:
        """INFO: Telegram only."""
        await self._safe(self.telegram.send(message))

    @staticmethod
    async def _safe(coro):
        try:
            return await coro
        except Exception as e:
            log.error("Notification delivery error", error=str(e))
```

---

## Telegram setup

```python
# alerts/telegram.py
import asyncio
import httpx
from logger_setup import component_logger

log = component_logger("telegram")


class TelegramNotifier:
    """
    Uses Telegram Bot API directly via HTTP (no library dependency).
    Bot token from @BotFather. Chat ID from @userinfobot or getUpdates.
    """

    BASE = "https://api.telegram.org"

    def __init__(self, bot_token: str, chat_id: str,
                 rate_limit_s: float = 1.0):
        self.token      = bot_token
        self.chat_id    = chat_id
        self._min_delay = rate_limit_s   # Telegram: 30 msg/s global, 1 msg/s per chat
        self._last_sent = 0.0
        self._lock      = asyncio.Lock()

    async def send(self, message: str,
                   parse_mode: str = "Markdown") -> bool:
        async with self._lock:
            # Rate limit: min 1s between messages to same chat
            now   = asyncio.get_event_loop().time()
            delay = self._min_delay - (now - self._last_sent)
            if delay > 0:
                await asyncio.sleep(delay)

            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.post(
                        f"{self.BASE}/bot{self.token}/sendMessage",
                        json={
                            "chat_id":    self.chat_id,
                            "text":       message[:4096],  # Telegram limit
                            "parse_mode": parse_mode,
                            "disable_web_page_preview": True,
                        },
                    )
                    resp.raise_for_status()
                    self._last_sent = asyncio.get_event_loop().time()
                    return True
            except httpx.HTTPStatusError as e:
                log.error("Telegram API error", status=e.response.status_code,
                          response=e.response.text[:200])
                return False
            except Exception:
                log.exception("Telegram send failed")
                return False

    async def send_photo(self, caption: str, image_bytes: bytes) -> bool:
        """Send chart image — useful for daily summary."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                resp = await client.post(
                    f"{self.BASE}/bot{self.token}/sendPhoto",
                    data={"chat_id": self.chat_id, "caption": caption[:1024]},
                    files={"photo": ("chart.png", image_bytes, "image/png")},
                )
                resp.raise_for_status()
                return True
            except Exception:
                log.exception("Telegram photo send failed")
                return False
```

**Setup steps:**
1. Message @BotFather on Telegram → `/newbot` → get `BOT_TOKEN`
2. Start your bot (send it any message)
3. `GET https://api.telegram.org/bot{TOKEN}/getUpdates` → find your `chat.id`
4. Add to `.env`: `TELEGRAM_BOT_TOKEN=...` and `TELEGRAM_CHAT_ID=...`

For **topic-based routing** (different alert levels to different topics in a group):
```python
# Use message_thread_id for topics in a supergroup
await client.post(..., json={
    "chat_id":           self.chat_id,
    "message_thread_id": self.critical_topic_id,  # only for CRITICAL
    "text":              message,
})
```

---

## Email setup

```python
# alerts/email.py
import smtplib, ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import asyncio
from logger_setup import component_logger

log = component_logger("email_notifier")


class EmailNotifier:
    """
    SMTP-based email. Works with Gmail, SendGrid, Mailgun, Postmark.
    Run in executor (smtplib is blocking) to avoid blocking event loop.
    """

    def __init__(self, smtp_host: str, smtp_port: int,
                 username: str, password: str,
                 from_addr: str, to_addr: str):
        self.smtp_host = smtp_host
        self.smtp_port = smtp_port
        self.username  = username
        self.password  = password
        self.from_addr = from_addr
        self.to_addr   = to_addr

    async def send(self, subject: str, body: str,
                   priority: str = "normal") -> bool:
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None, self._send_sync, subject, body, priority
        )

    def _send_sync(self, subject: str, body: str, priority: str) -> bool:
        try:
            msg = MIMEMultipart("alternative")
            msg["From"]    = self.from_addr
            msg["To"]      = self.to_addr
            msg["Subject"] = f"[BOT] {subject}"
            if priority == "high":
                msg["X-Priority"] = "1"
                msg["Importance"] = "high"

            # Plain text + HTML
            msg.attach(MIMEText(body, "plain"))
            msg.attach(MIMEText(self._html_wrap(body), "html"))

            ctx = ssl.create_default_context()
            with smtplib.SMTP_SSL(self.smtp_host, self.smtp_port, context=ctx) as s:
                s.login(self.username, self.password)
                s.sendmail(self.from_addr, self.to_addr, msg.as_string())
            return True
        except Exception:
            log.exception("Email send failed")
            return False

    @staticmethod
    def _html_wrap(text: str) -> str:
        lines = text.replace("*", "<b>").replace("*", "</b>")
        body  = "<br>".join(lines.split("\n"))
        return f"""<html><body style="font-family:monospace;font-size:14px">
        {body}</body></html>"""
```

**Gmail SMTP config** (use App Password, not account password):
```ini
# .env
EMAIL_SMTP_HOST=smtp.gmail.com
EMAIL_SMTP_PORT=465
EMAIL_USERNAME=youremail@gmail.com
EMAIL_PASSWORD=your_app_password_16chars
EMAIL_FROM=youremail@gmail.com
EMAIL_TO=youremail@gmail.com
```

**SendGrid config** (higher deliverability for production):
```ini
EMAIL_SMTP_HOST=smtp.sendgrid.net
EMAIL_SMTP_PORT=465
EMAIL_USERNAME=apikey
EMAIL_PASSWORD=SG.your_sendgrid_api_key
```

---

## Notifier wiring (in main.py)

```python
# In config.py — add these fields to BotSettings:
telegram_bot_token: str | None = None
telegram_chat_id:   str | None = None
email_smtp_host:    str | None = None
email_smtp_port:    int        = 465
email_username:     str | None = None
email_password:     str | None = None
email_from:         str | None = None
email_to:           str | None = None

# In main.py — build Notifier and AlertManager:
from alerts.telegram import TelegramNotifier
from alerts.email    import EmailNotifier
from alerts.notifier import Notifier
from alerts.manager  import AlertManager

telegram = TelegramNotifier(settings.telegram_bot_token, settings.telegram_chat_id)
email    = EmailNotifier(
    settings.email_smtp_host, settings.email_smtp_port,
    settings.email_username,  settings.email_password,
    settings.email_from,      settings.email_to,
)
notifier      = Notifier(telegram, email)
alert_manager = AlertManager(redis, notifier)

# Pass alert_manager into components that need it:
order_executor   = OrderExecutor(redis, session_factory, settings, alert_manager)
position_tracker = PositionTracker(redis, db_writer, alert_manager)
```
