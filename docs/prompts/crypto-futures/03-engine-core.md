# Fase 03 — Bot Engine Core

Tujuan: Entry point, config, logging, registry, dan health heartbeat.
Prasyarat: Fase 01-02 selesai.

---

## Prompt 3.1 — Config dan Logging

```
Gunakan @crypto-futures-bot-engine references/config-logging.md.

Buat dua file berikut di bot_engine/:

1. config.py
   - Pydantic BaseSettings dengan semua env vars yang dibutuhkan bot engine:
     REDIS_URL, DATABASE_URL, LLM_PROVIDER, LLM_API_KEY, LLM_MODEL,
     LLM_REFRESH_INTERVAL_S, ENVIRONMENT, LOG_LEVEL, COMMAND_TIMEOUT_S
   - Method llm_providers() yang return list config provider
   - Fail fast pada startup jika env var wajib tidak ada
   - Singleton instance: settings = Settings()

2. logger_setup.py
   - Setup Loguru dengan dua handler: stderr dan file rotasi harian
   - File log disimpan di logs/bot_engine_{date}.log
   - Format: "{time} | {level} | {extra[component]} | {extra[symbol]} | {message}"
   - Helper: component_logger(component: str, symbol: str = "") → BoundLogger
     yang pre-bind component dan symbol ke setiap log entry
   - Interceptor untuk stdlib logging (asyncio, sqlalchemy)
```

---

## Prompt 3.2 — WorkerRegistry

```
Gunakan @crypto-futures-bot-engine references/main-process.md bagian
"Task orchestration rules".

Buat bot_engine/registry.py dengan:

1. @dataclass WorkerSet:
   - symbol: str
   - strategy: str
   - collector_task: asyncio.Task
   - strategy_task: asyncio.Task
   - stop_event: asyncio.Event

2. class WorkerRegistry:
   - Thread-safe dengan asyncio.Lock
   - Methods: add(ws), remove(symbol), get(symbol), all_symbols()
   - TIDAK menyimpan state ke Redis — hanya in-memory

3. async def spawn_worker(symbol, config, redis, registry, global_stop):
   - Validasi: symbol tidak boleh duplikat
   - Simpan config ke Redis: config.worker.{symbol}
   - Create task collector dan strategy dengan asyncio.create_task + name
   - Register callback _on_task_done untuk auto-restart on crash
   - Tambahkan symbol ke Redis set: state.bot.workers
   - Return WorkerSet

4. async def stop_worker(symbol, registry, redis):
   - Set stop_event
   - Cancel kedua tasks
   - Remove dari registry dan Redis set

5. _on_task_done callback:
   - Jika crash (bukan cancelled) dan global_stop belum set:
     schedule _restart_worker dengan delay 5s

6. async def _restart_worker(symbol, registry, redis, global_stop):
   - Baca config dari Redis
   - Spawn ulang worker
```

---

## Prompt 3.3 — Main process entry point

```
Gunakan @crypto-futures-bot-engine references/main-process.md secara lengkap.

Buat bot_engine/main.py dengan urutan startup yang benar:

1. Load settings + setup Loguru
2. Connect Redis pool (test PING, raise jika gagal)
3. Connect PostgreSQL pool (test SELECT 1, raise jika gagal)
4. Panggil _ensure_consumer_groups() — buat stream groups jika belum ada:
   - stream.signals → risk-manager
   - stream.orders → order-executor
   - stream.fills → fill-processors
   - stream.commands → command-listener
5. Instansiasi semua shared components:
   DBWriter, PositionTracker, OrderExecutor, RiskManager, PositionManager,
   LiquidationCollector, LLMSignalAgent, CommandListener
6. Register SIGTERM/SIGINT handler yang set global stop_event
7. Drain pending stream messages (crash recovery)
8. Restore workers dari state.bot.workers di Redis
9. SET state.bot.status = "running"
10. Launch semua tasks dengan asyncio.wait(FIRST_EXCEPTION)
11. finally: shutdown sequence yang benar

Import dari components/ — semua komponen belum ada, gunakan placeholder
`pass` atau raise NotImplementedError. Import harus valid.

Tambahkan if __name__ == "__main__": asyncio.run(main())
```

---

## Prompt 3.4 — Health heartbeat

```
Gunakan @crypto-futures-bot-engine references/config-logging.md bagian heartbeat.

Buat bot_engine/health.py dengan:

async def run_health_heartbeat(redis, registry, stop_event):
  - Setiap 30 detik:
    - SET state.health.heartbeat = unix timestamp (ex=90)
    - SET state.health.worker_count = len(registry.all_symbols()) (ex=90)
    - SET state.health.workers = JSON list of active symbols (ex=90)
  - Log level DEBUG setiap heartbeat
  - Loop berhenti saat stop_event.is_set()
  - Tidak crash jika Redis unavailable — log warning dan retry
```
