# Fase 06 — Monitoring

Tujuan: Metrics collector, health checker, alert rules, dan Telegram/email notifier.
Prasyarat: Fase 02-03 selesai (database dan Redis tersedia).

---

## Prompt 6.1 — Monitoring config dan entry point

```
Gunakan @crypto-futures-bot-monitoring untuk konteks lengkap monitoring system.

Buat monitoring/config.py:
- Pydantic BaseSettings mirip bot_engine/config.py
- Tambahan: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERT_EMAIL (optional)
- METRICS_INTERVAL_S (default 60), HEALTH_CHECK_INTERVAL_S (default 30)
- ALERT_COOLDOWN_S (default 300 — throttle per alert type)

Buat monitoring/main.py:
- Connect Redis dan PostgreSQL
- Instansiasi: MetricsCollector, HealthChecker, AlertManager, Notifier
- Launch 3 asyncio tasks:
  1. metrics_collector.run(stop_event)
  2. health_checker.run(stop_event)
  3. alert_manager.run(stop_event)
- Handle SIGTERM/SIGINT dengan graceful stop
```

---

## Prompt 6.2 — MetricsCollector

```
Gunakan @crypto-futures-bot-monitoring references/metrics-collector.md.

Buat monitoring/metrics_collector.py dengan class MetricsCollector:

async def run(self, stop_event):
  - 3 concurrent loops via asyncio.gather:
    1. _pnl_snapshot_loop: setiap 60s
    2. _daily_summary_loop: setiap hari jam 00:05 UTC
    3. _stream_lag_loop: setiap 30s

async def _pnl_snapshot_loop(self):
  - Setiap interval: fetch open positions dari Redis (state.position.*)
  - Untuk setiap posisi: hitung unrealized PnL (fetch current price dari state.price.{symbol})
  - Simpan ke Redis: metrics.pnl.{symbol} JSON (TTL 300s)
  - Simpan juga aggregate: metrics.pnl.total (sum semua unrealized)

async def _daily_summary_loop(self):
  - Hitung waktu hingga 00:05 UTC berikutnya
  - Setelah tidur: jalankan _write_daily_summary()
  - _write_daily_summary(): upsert DailyPnl berdasarkan trades hari ini

async def _stream_lag_loop(self):
  - Cek lag semua Redis Streams (berapa message pending)
  - Simpan ke Redis: metrics.stream_lag.{stream_name}
  - Jika lag > threshold: publish alert ke state.alert.{id}
```

---

## Prompt 6.3 — HealthChecker dan AlertManager

```
Gunakan @crypto-futures-bot-monitoring references/health-checker.md dan
references/alert-rules.md.

Buat monitoring/health_checker.py dengan class HealthChecker:

async def run(self, stop_event):
  - Loop setiap 30s: panggil _check_all()

async def _check_all(self):
  - Jalankan semua checks concurrently:
    * _check_heartbeat(): age > 90s = CRITICAL, > 45s = WARNING
    * _check_position_sync(): bandingkan Redis vs exchange (sample 1 symbol)
    * _check_stream_lag(): xpending untuk semua streams
    * _check_db_fallback(): hitung baris di logs/db_fallback.jsonl
    * _check_open_position_sl(): tiap posisi harus punya SL order aktif
  - Simpan snapshot ke Redis: state.health.snapshot JSON (TTL 120s)
  - Untuk setiap issue: publish ke channel "health.alerts" pub/sub

Buat monitoring/alert_manager.py dengan class AlertManager:

async def run(self, stop_event):
  - Subscribe ke "health.alerts" pub/sub
  - Untuk setiap alert: cek throttle sebelum notify
  - Throttle: SET alert.throttle.{alert_id} (TTL = cooldown_s)
    Jika key sudah ada: skip (sudah dikirim dalam cooldown window)

Alert levels dari @crypto-futures-bot-monitoring:
  CRITICAL: position unprotected, engine dead, DB write failing
  WARNING:  stream lag > 500, equity drop > 5% in 1h, reconcile mismatch
  INFO:     position opened/closed, strategy changed

Setiap alert: {level, alert_id, message, symbol?, triggered_at}
```

---

## Prompt 6.4 — Telegram dan Email notifier

```
Gunakan @crypto-futures-bot-monitoring references/telegram-email.md.

Buat monitoring/alerts/notifier.py dengan class Notifier dan dua sub-class:

1. class TelegramNotifier:
   - Gunakan httpx.AsyncClient untuk Telegram Bot API
   - send(chat_id, text) → POST /sendMessage dengan parse_mode=HTML
   - Format pesan per level:
     CRITICAL: "🚨 <b>CRITICAL</b>\n{message}\n{symbol}\n{time}"
     WARNING:  "⚠️ <b>WARNING</b>\n{message}"
     INFO:     "ℹ️ {message}"
   - Retry 3x dengan backoff jika Telegram API error
   - Rate limit: max 1 message per 3 detik (per chat_id)

2. class EmailNotifier (optional, kirim jika TELEGRAM_CHAT_ID kosong):
   - SMTP via smtplib (sync, jalankan di executor)
   - Template HTML sederhana per level

3. class Notifier (unified):
   - send_critical(message, symbol=None)
   - send_warning(message, symbol=None)
   - send_info(message, symbol=None)
   - Route ke channel yang sesuai berdasarkan settings

Buat monitoring/alerts/rules.py:
- @dataclass AlertRule (alert_id, level, condition_fn, message_template)
- CRITICAL_RULES, WARNING_RULES, INFO_RULES lists
- Sesuaikan dengan rules di @crypto-futures-bot-monitoring references/alert-rules.md
```

---

## Roadmap

Selesai? Tandai di `docs/ROADMAP.md` → Phase 1 › Monitoring:

- [ ] Health heartbeat check
- [ ] CRITICAL alert: position without SL coverage
- [ ] Telegram notifications
