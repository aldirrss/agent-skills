# Fase 08 — Integration & Smoke Test

Tujuan: Prompt-prompt untuk memverifikasi semua komponen terhubung dengan benar
sebelum live trading. Jalankan di environment development dengan testnet.

---

## Prompt 8.1 — End-to-end smoke test script

```
Buat scripts/smoke_test.py yang memverifikasi seluruh pipeline berjalan:

Test 1 — Infrastructure:
- Redis: PING, cek consumer groups stream.signals/orders/fills/commands
- PostgreSQL: SELECT 1, cek semua tabel ada
- Print: ✓ Redis OK | ✓ PostgreSQL OK

Test 2 — Bot Engine startup:
- Baca state.bot.status dari Redis
- Cek state.health.heartbeat tidak lebih dari 90s yang lalu
- Print: ✓ Engine running | heartbeat age: Xs

Test 3 — Worker lifecycle:
- Kirim ADD_SYMBOL command via Redis xadd langsung (bypass API)
  payload: {strategy: "trend", leverage: 5, risk_pct: 0.005,
            timeframes: ["1h"], exchange: "binance", is_testnet: true}
- Tunggu 5s, cek state.bot.workers mengandung symbol
- Cek ada task collector.{symbol} dan strategy.{symbol} berjalan
- Print: ✓ Worker spawned

Test 4 — Candle data flow:
- Subscribe ke market.{symbol}.candle.1h pub/sub
- Tunggu max 70s untuk candle (1h candle interval)
- Jika diterima: ✓ DataCollector publishing candles
- Jika timeout: ✗ WARNING — candle belum diterima

Test 5 — Signal flow (manual inject):
- Inject signal ke stream.signals langsung:
  {symbol, direction: "long", confidence: "0.9", entry_price, atr, strategy}
- Tunggu 3s, cek apakah RiskManager xack signal tersebut
- Cek apakah ada entry di stream.orders
- Print: ✓ Signal processed by RiskManager

Test 6 — API server:
- GET /health → cek status bukan "dead"
- POST /auth/login → cek dapat cookie
- GET /bot/status → cek response valid
- GET /ws → cek WebSocket handshake berhasil
- Print: ✓ API OK | ✓ WebSocket OK

Test 7 — Monitoring:
- Cek state.health.snapshot ada di Redis
- Cek metrics.pnl.total ada
- Print: ✓ Monitoring OK

Jalankan: python scripts/smoke_test.py
Output: checklist dengan ✓/✗ dan detail error jika ada.
```

---

## Prompt 8.2 — Testnet trading verification

```
Buat scripts/testnet_verify.py untuk verifikasi end-to-end dengan Binance testnet.
HANYA jalankan dengan is_testnet=True dan akun terpisah.

Langkah:
1. Pastikan .env menggunakan testnet API key
2. Add symbol BTCUSDT dengan strategy "trend", leverage 5, risk_pct=0.001
3. Tunggu sampai signal pertama diterima (max 2 jam, atau inject manual)
4. Jika signal diterima:
   - Verifikasi order terbuka di Binance testnet
   - Verifikasi SL order ada
   - Verifikasi TP order ada
   - Verifikasi state.position.BTCUSDT tersimpan di Redis
   - Verifikasi Trade record dibuat di PostgreSQL
5. Tunggu position close (atau trigger manual emergency_close)
6. Verifikasi state.position.BTCUSDT dihapus
7. Verifikasi Trade.status = "closed" di database
8. Verifikasi DailyPnl di-update

Script ini INTERAKTIF — print setiap langkah dan tunggu konfirmasi user
sebelum lanjut ke langkah berikutnya.

PERINGATAN: Script ini menempatkan order nyata di testnet. Review setiap
langkah sebelum confirm.
```

---

## Prompt 8.3 — Load test Redis streams

```
Buat scripts/load_test_streams.py untuk memverifikasi Redis stream tidak
menjadi bottleneck saat volume tinggi.

Test:
1. Publish 1000 signal palsu ke stream.signals dalam 10 detik
   (100 signal/detik — simulasi high-frequency scenario)
2. Ukur berapa yang di-consume oleh RiskManager dalam 30s berikutnya
3. Cek apakah ada lag: xpending untuk semua groups
4. Print throughput: signals/detik yang berhasil diproses

Batas yang diterima:
- Lag < 100 messages setelah 30s
- Throughput > 50 signals/detik

Jika gagal: print rekomendasi (increase consumer count, tune maxlen, dll)

Catatan: Jalankan saat bot_engine sedang running tapi dalam mode paused
(agar signal tidak menghasilkan order nyata).
```

---

## Prompt 8.4 — Checklist sebelum live trading

```
Buat docs/LIVE_CHECKLIST.md dengan checklist wajib sebelum switch dari
testnet ke production:

[ ] .env sudah diupdate dengan production API keys
[ ] ADMIN_PASSWORD_HASH sudah di-generate ulang (bukan default)
[ ] SESSION_SECRET sudah di-generate baru (secrets.token_hex(32))
[ ] COOKIE_SECURE=true di production
[ ] CORS_ORIGINS hanya include domain production
[ ] Redis requirepass aktif
[ ] PostgreSQL tidak expose port ke public
[ ] Smoke test (scripts/smoke_test.py) semua ✓
[ ] Testnet trading verify (scripts/testnet_verify.py) semua ✓
[ ] Telegram notifications working (kirim test alert manual)
[ ] Dashboard accessible via HTTPS
[ ] Log rotation aktif (loguru)
[ ] Backup PostgreSQL scheduled
[ ] Monitoring running dan mengirim heartbeat alert
[ ] Emergency stop button sudah ditest (di testnet)
[ ] Maximum concurrent positions sudah dikonfigurasi sesuai modal
[ ] Risk per trade <= 1% dari equity

JANGAN mulai live trading sampai semua item ✓.
```

---

## Roadmap

Selesai? Tandai di `docs/ROADMAP.md` → Phase 1 › Infrastructure:

- [ ] Smoke test script
