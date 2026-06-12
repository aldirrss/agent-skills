# Fase 03 — Bot Engine Core

Tujuan: Entry point, config, logging, dan startup/shutdown sequence lengkap.
Prasyarat: Fase 01-02 selesai.

---

## Prompt 3.1 — Config dan Logging

```
Gunakan @web3-solana-engine references/config-logging.md.
Gunakan @web3-solana safety rules sebagai referensi variabel wajib.

Buat dua file berikut di root solana-bot/:

1. config.py
   - Pydantic BaseSettings dengan semua env vars:
     WALLET_KEYPAIR_B64, RPC_PRIMARY_URL, RPC_FALLBACK_URL, DRY_RUN (bool, default True)
     REDIS_URL, REDIS_PASSWORD
     DATABASE_URL
     HELIUS_API_KEY, HELIUS_WEBHOOK_SECRET
     BIRDEYE_API_KEY, CIELO_API_KEY
     TWITTER_BEARER_TOKEN
     TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_PHONE
     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
     DISCORD_WEBHOOK_URL (optional, default "")
     GROQ_API_KEYS (comma-separated, min 3)
     GEMINI_API_KEYS (comma-separated, min 3)
     LOG_LEVEL (default "INFO")
   - Fail fast pada startup jika variabel wajib tidak ada (WALLET_KEYPAIR_B64,
     RPC_PRIMARY_URL, REDIS_URL, DATABASE_URL)
   - Property: is_dry_run → bool
   - Singleton instance: settings = Settings()

2. logger_setup.py
   - Setup Loguru dengan dua handler: stderr dan file rotasi harian
   - File log disimpan di logs/bot_{date}.log
   - Format: "{time:YYYY-MM-DD HH:mm:ss.SSS} | {level:<8} | {extra[component]:<20} | {message}"
   - Helper: component_logger(name: str) → Logger yang pre-bind component
   - Intercept stdlib logging (asyncio warnings, aiohttp)
   - Jangan pernah log WALLET_KEYPAIR_B64 — tambahkan filter Loguru yang
     redact string yang mengandung kata "keypair", "private", "secret", "seed"
```

---

## Prompt 3.2 — Keypair loading

```
Gunakan @web3-solana safety rules poin 1 (Private key never leaves memory).

Buat components/wallet.py:

def load_keypair(keypair_b64: str) -> Keypair:
  - Decode base64 → bytes
  - Buat Keypair dari bytes menggunakan solders
  - JANGAN log keypair, bytes, atau nilai apapun dari parameter
  - Raise ValueError dengan pesan yang tidak mengandung nilai keypair jika decode gagal
  - Return Keypair

def get_pubkey_str(keypair: Keypair) -> str:
  - Return str(keypair.pubkey())
  - Ini satu-satunya nilai dari keypair yang boleh di-log atau dikirim ke komponen lain

Tambahkan komentar: "Fungsi ini dipanggil SATU KALI di main.py. Keypair tidak
pernah diteruskan ke komponen selain Execution."
```

---

## Prompt 3.3 — Main process entry point

```
Gunakan @web3-solana-engine references/main-process.md secara lengkap.
Gunakan @web3-solana-architecture untuk urutan startup dan Redis schema.

Buat main.py di root solana-bot/ dengan startup sequence yang tepat:

1.  Load settings (config.py) — fail fast jika env var wajib tidak ada
2.  Setup Loguru (logger_setup.py)
3.  Load keypair dari WALLET_KEYPAIR_B64 — simpan sebagai local variable,
    JANGAN simpan di settings atau global state
4.  Connect Redis pool — test PING, raise ConnectionError jika gagal
5.  Connect PostgreSQL pool — test SELECT 1, raise jika gagal
6.  Jalankan db/migrate.py — run_migrations(pool)
7.  Create aiohttp.ClientSession (shared, satu instance)
8.  ensure_consumer_groups() — XGROUP CREATE idempotent untuk:
      stream.signals        → aggregator-group
      stream.agent.eligible → orchestrator-group
      stream.agent.approved → risk-group
      stream.signals        → risk-sell-group  (SELL passthrough)
      stream.swaps          → exec-group
      stream.fills          → tracker-group  (PositionTracker)
      stream.fills          → db-group       (DBWriter — group terpisah agar keduanya terima semua fills)
      stream.commands       → cmd-group
9.  Drain pending stream messages (crash recovery — replay XREADGROUP dengan "0")
10. SET state.bot.status = "stopped"
11. Register SIGTERM/SIGINT handler → set global stop_event
12. Spawn CommandListener + Monitor sebagai asyncio tasks (selalu berjalan)
13. Log "Bot ready. Waiting for START command."
14. await stop_event (CommandListener yang akan trigger START)
15. finally: shutdown sequence

Shutdown sequence (urutan penting):
  1. SET state.bot.status = "stopping"
  2. Cancel Scanner tasks (stop new signals)
  3. Cancel Strategy tasks (setelah drain in-flight max 5s)
  4. Wait RiskManager selesai current signal (max 10s)
  5. Wait Execution selesai current swap (max 60s)
  6. Cancel PositionTracker, DBWriter
  7. Close aiohttp.ClientSession
  8. Close Redis pool
  9. Close PostgreSQL pool
  10. Log "Bot shutdown complete."

Semua komponen (Scanner, Strategy, dll) belum ada — buat placeholder class
dengan async def start(self) -> None: raise NotImplementedError.
Import harus valid.

if __name__ == "__main__": asyncio.run(main())
```

---

## Prompt 3.4 — ensure_consumer_groups dan Redis helpers

```
Gunakan @web3-solana-architecture references/redis-topology.md.

Buat components/redis_helpers.py:

async def ensure_consumer_groups(redis) -> None:
  - XGROUP CREATE untuk semua streams yang dibutuhkan:
    stream.signals        → aggregator-group
    stream.signals        → risk-sell-group   (SELL passthrough ke RiskManager)
    stream.agent.eligible → orchestrator-group
    stream.agent.approved → risk-group
    stream.swaps          → exec-group
    stream.fills          → tracker-group  (PositionTracker)
    stream.fills          → db-group       (DBWriter — group terpisah agar keduanya terima semua fills)
    stream.commands       → cmd-group
  - Gunakan id="0" dan mkstream=True
  - Tangani exception "BUSYGROUP" (group sudah ada) — lanjut tanpa error
  - Log tiap group yang dibuat atau sudah ada

async def drain_pending_messages(redis, streams: list[str]) -> int:
  - Untuk tiap stream, XREADGROUP dengan id="0" (pending messages)
  - Log jumlah pending messages yang ditemukan per stream
  - Return total count — caller menentukan apa yang dilakukan dengan pending messages
  - Jangan process — hanya drain dan log

async def set_bot_status(redis, status: str) -> None:
  - SET state.bot.status = status
  - Valid values: "running", "paused", "stopped", "stopping"
  - Raise ValueError untuk value yang tidak valid

async def get_bot_status(redis) -> str:
  - GET state.bot.status
  - Return "stopped" jika key tidak ada
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] config.py — Pydantic Settings, fail fast, DRY_RUN default True
- [ ] logger_setup.py — Loguru dengan redact keypair filter
- [ ] components/wallet.py — load_keypair, get_pubkey_str
- [ ] main.py — 15 langkah startup + shutdown sequence
- [ ] components/redis_helpers.py — ensure_consumer_groups, drain_pending
- [ ] Bot bisa dijalankan: `python main.py` tanpa error (placeholder components)
