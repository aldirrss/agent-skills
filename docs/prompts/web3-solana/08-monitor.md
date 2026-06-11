# Fase 08 — Monitor (Observability Layer)

Tujuan: Heartbeat liveness, Telegram/Discord alerts, win rate metrics,
daily PnL tracking, dan daily report.
Prasyarat: Fase 06 selesai — position.updates pub/sub sudah aktif.

---

## Prompt 8.1 — TelegramAlerter

```
Gunakan @web3-solana-monitor references/telegram-alerts.md secara lengkap.

Buat components/monitor/telegram_alerter.py:

class TelegramAlerter:
  - Queue-backed, non-blocking — semua sends melalui asyncio.Queue(maxsize=100)
  - Rate limit: ≥3s antar pesan (Telegram flood protection)
  - Jika queue penuh: drop pesan terlama, log warning — JANGAN block caller

  def enqueue(self, text: str) -> None:
    - put_nowait ke queue
    - Tangani QueueFull: log warning "Telegram queue full — message dropped"

  async def run(self, stop_event: asyncio.Event) -> None:
    - Background worker yang drain queue
    - Enforce rate limit: hitung elapsed sejak last_sent, sleep sisanya
    - Send ke Telegram (parse_mode="HTML") DAN Discord (jika DISCORD_WEBHOOK_URL ada)
    - Discord: strip HTML tags sebelum send

Alert templates (semua return string, di-enqueue bukan di-await):
  fmt_buy_opened(symbol, entry_price, size_usdc, strategy, mint) → str
  fmt_sell_closed(symbol, pnl_usdc, pnl_pct, reason, mint) → str
  fmt_circuit_breaker(daily_loss_usdc) → str
  fmt_emergency_stop(open_positions) → str
  fmt_scanner_dead(task_name) → str
  fmt_position_age_warning(symbol, age_min, max_min, mint) → str
  fmt_daily_summary(date, total_trades, wins, losses, win_rate, total_pnl,
                    best_symbol, best_pnl, worst_symbol, worst_pnl) → str

Format pesan: gunakan emoji dan HTML bold/code sesuai contoh di skill.
```

---

## Prompt 8.2 — Heartbeat dan scanner health

```
Gunakan @web3-solana-monitor references/health-metrics.md bagian
"Heartbeat Loop" dan "Scanner Health Check".

Buat components/monitor/health.py:

async def heartbeat_loop(redis, stop_event: asyncio.Event) -> None:
  - Setiap 30s: SET state.bot.heartbeat = int(time.time()) dengan EX=60
  - Loop berhenti saat stop_event.is_set()
  - Jika Redis unavailable: log warning, retry di iterasi berikutnya — JANGAN crash

EXPECTED_SCANNER_TASKS = [
  "scanner.dexscreener.new", "scanner.dexscreener.trending",
  "scanner.gmgn", "scanner.pumpfun", "scanner.birdeye",
  "scanner.helius", "scanner.kol_wallet", "scanner.cielo",
]

async def scanner_health_loop(alerter, stop_event: asyncio.Event) -> None:
  - Setiap 2 menit: bandingkan asyncio.all_tasks() names vs EXPECTED_SCANNER_TASKS
  - Untuk setiap task yang hilang: alerter.enqueue(fmt_scanner_dead(task_name))
  - Log level ERROR untuk setiap task yang tidak ditemukan

async def position_age_loop(redis, alerter, stop_event: asyncio.Event) -> None:
  - Setiap 5 menit: scan KEYS state.position.*
  - Untuk tiap posisi: hitung age = now - opened_at
  - Alert jika age >= max_hold_time * 0.75
  - Ambil max_hold_time dari Redis key config.risk (default 3600s)

Semua loop menggunakan asyncio.wait_for(stop_event.wait(), timeout=N) untuk timing.
```

---

## Prompt 8.3 — Stats tracking dan daily report

```
Gunakan @web3-solana-monitor references/health-metrics.md bagian "Stats".
Gunakan @web3-solana-monitor references/daily-report.md secara lengkap.

Buat components/monitor/stats.py:

async def record_signal(redis, strategy: str) -> None:
  - INCR stats.signals.{strategy}

async def record_trade_outcome(redis, strategy, pnl_usdc, mint, symbol) -> None:
  - INCR stats.wins.{strategy} jika pnl >= 0, else INCR stats.losses.{strategy}
  - INCRBYFLOAT stats.daily_pnl, pnl_usdc
  - INCR stats.daily_trades
  - Update stats.best_trade dan stats.worst_trade (JSON compare)

async def get_win_rate(redis, strategy: str = None) -> float:
  - Hitung wins/(wins+losses)*100 untuk strategy tertentu atau semua strategy

async def build_daily_report(redis, pool) -> dict:
  - Query PostgreSQL untuk trades hari ini (JOIN win/loss per strategy)
  - Baca stats.daily_* dari Redis
  - Return dict sesuai format report_json di daily_reports table

async def midnight_reset(redis, pool, alerter) -> None:
  - Generate daily report: build_daily_report()
  - Simpan ke stats.report.{YYYY-MM-DD} (TTL 30 hari)
  - INSERT ke daily_reports PostgreSQL
  - Kirim fmt_daily_summary ke Telegram
  - Reset semua stats.daily_* ke 0
  - Jalankan rebuild_strategy_stats(pool)

async def midnight_loop(redis, pool, alerter, stop_event) -> None:
  - Hitung seconds sampai midnight UTC berikutnya
  - sleep sampai midnight, jalankan midnight_reset, ulangi
```

---

## Prompt 8.4 — Monitor class utama

```
Gunakan @web3-solana-monitor SKILL.md bagian "Full Monitor.run() Skeleton".

Buat components/monitor/monitor.py:

class Monitor:
  - __init__(self, redis, pool, settings, alerter: TelegramAlerter)

  async def run(self, stop_event: asyncio.Event) -> None:
    - Subscribe ke position.updates pub/sub
    - Spawn internal tasks sebagai named asyncio tasks:
      asyncio.create_task(heartbeat_loop(redis, stop_event),          name="monitor.heartbeat")
      asyncio.create_task(scanner_health_loop(alerter, stop_event),   name="monitor.scanner_health")
      asyncio.create_task(position_age_loop(redis, alerter, stop_event), name="monitor.position_age")
      asyncio.create_task(midnight_loop(redis, pool, alerter, stop_event), name="monitor.midnight")
    - Listen loop untuk position.updates:
      event="opened" → fmt_buy_opened + alerter.enqueue
      event="closed" → fmt_sell_closed + alerter.enqueue + record_trade_outcome
      event="fill_failed" → log warning (tidak alert kecuali status=failed berulang)
      event="emergency_stop" → fmt_emergency_stop + alerter.enqueue
      event="circuit_breaker" → fmt_circuit_breaker + alerter.enqueue
    - Monitor TIDAK menulis ke stream.signals, stream.swaps, atau stream.fills
    - Semua log menggunakan logger.bind(component="monitor")

Wiring di main.py:
  alerter = TelegramAlerter(settings)
  monitor = Monitor(redis, pool, settings, alerter)
  # Spawn keduanya sebagai tasks — alerter HARUS start sebelum monitor
  asyncio.create_task(alerter.run(stop_event), name="monitor.alerter")
  asyncio.create_task(monitor.run(stop_event), name="monitor.main")
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/monitor/telegram_alerter.py — queue, rate limit, Discord support
- [ ] components/monitor/health.py — heartbeat, scanner health, position age
- [ ] components/monitor/stats.py — record signals, outcomes, build_daily_report
- [ ] components/monitor/monitor.py — main class, position.updates listener
- [ ] main.py diupdate — spawn alerter sebelum monitor
- [ ] Test: kirim manual ke position.updates → alert muncul di Telegram
- [ ] Test: matikan salah satu scanner task → alert scanner dead muncul dalam 2 menit
