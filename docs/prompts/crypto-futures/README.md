# Crypto Futures Bot — Prompt Guide

Kumpulan prompt siap pakai untuk membangun proyek crypto futures trading bot
dari nol menggunakan Claude Code. Urutan prompt mengikuti dependency antar
komponen — jangan loncat fase.

## Cara pakai

1. Buka proyek baru di Claude Code
2. Pastikan skills `crypto-futures-*` sudah terkonfigurasi di environment
3. Copy-paste prompt dari file yang sesuai fase
4. Tunggu Claude Code selesai generate, review hasilnya, baru lanjut ke prompt berikutnya
5. Setiap prompt dalam satu file bisa dijalankan dalam **satu sesi** Claude Code

## Urutan pengerjaan

```
01-infra-setup.md       → Docker, .env, pyproject.toml, requirements
02-database.md          → SQLModel models, migration, initial seed
03-engine-core.md       → main.py, config.py, registry.py, logger_setup.py
04-engine-components.md → DataCollector, StrategyWorker, RiskManager,
                          OrderExecutor, PositionTracker, PositionManager,
                          LiquidationCollector, CommandListener, LLMSignalAgent
05-strategies.md        → Implementasi 6 strategi di strategy_worker.py
06-api-server.md        → FastAPI server, auth, endpoints, WebSocket
07-monitoring.md        → Metrics, health, alerts, Telegram
08-dashboard.md         → Next.js (latest) dashboard
```

## Tips

- **Jangan skip review** — setelah setiap prompt, periksa kode yang di-generate
  sebelum lanjut. Bug di fase awal menyebar ke seluruh codebase.
- **Satu prompt = satu unit kerja** — jika prompt terlalu besar untuk satu sesi,
  potong jadi dua prompt terpisah.
- **State matters** — setiap prompt menulis "project state saat ini" agar
  Claude Code punya konteks yang cukup tanpa perlu membaca ulang semua file.
- **Gunakan `@skill-name`** — di setiap prompt sudah ada referensi skill.
  Pastikan skill tersebut terkonfigurasi dan bisa diakses Claude Code.

## Struktur proyek yang dihasilkan

```
crypto-futures-bot/
├── bot_engine/              ← asyncio bot process
│   ├── main.py
│   ├── config.py
│   ├── logger_setup.py
│   ├── registry.py
│   ├── health.py
│   ├── components/
│   │   ├── data_collector.py
│   │   ├── strategy_worker.py
│   │   ├── price_structure.py
│   │   ├── risk_manager.py
│   │   ├── order_executor.py
│   │   ├── position_tracker.py
│   │   ├── position_manager.py
│   │   ├── db_writer.py
│   │   ├── command_listener.py
│   │   ├── liquidation_collector.py
│   │   └── llm_signal_agent.py
│   └── db/
│       ├── models.py
│       └── engine.py
├── api_server/              ← FastAPI server
│   ├── main.py
│   ├── app.py
│   ├── config.py
│   ├── dependencies.py
│   ├── auth/
│   │   ├── security.py
│   │   ├── router.py
│   │   └── middleware.py
│   ├── routers/
│   │   ├── bot.py
│   │   ├── data.py
│   │   └── _command.py
│   └── ws/
│       ├── manager.py
│       └── relay.py
├── monitoring/              ← monitoring daemon
│   ├── main.py
│   ├── metrics_collector.py
│   ├── health_checker.py
│   ├── alert_manager.py
│   └── alerts/
│       ├── rules.py
│       └── notifier.py
├── dashboard/               ← Next.js (latest)
│   ├── app/
│   ├── components/
│   └── lib/
├── docker-compose.yml
├── .env.example
└── pyproject.toml
```
