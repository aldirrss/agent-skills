# Fase 01 — Infrastructure Setup

Tujuan: Docker Compose, .env, pyproject.toml, requirements, dan direktori proyek.
Jalankan semua prompt dalam satu sesi Claude Code.

---

## Prompt 1.1 — Buat struktur direktori proyek

```
Buat struktur direktori lengkap untuk proyek crypto futures trading bot dengan layout berikut:

crypto-futures-bot/
├── bot_engine/
│   ├── components/
│   └── db/
├── api_server/
│   ├── auth/
│   ├── routers/
│   └── ws/
├── monitoring/
│   └── alerts/
├── dashboard/         ← kosong dulu, diisi fase 08
├── infra/             ← tempat nginx.conf, systemd, dll nanti
└── scripts/           ← seed script, migration runner

Buat __init__.py di setiap package Python. Buat .gitkeep di folder yang masih kosong.
Jangan buat file apapun selain struktur direktori dan file init.
```

---

## Prompt 1.2 — docker-compose.yml

```
Gunakan @crypto-futures-bot-architecture untuk konteks arsitektur.

Buat docker-compose.yml di root proyek crypto-futures-bot/ dengan service berikut:

1. redis
   - image: redis:7-alpine
   - command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
   - port: 6379
   - volume: redis_data

2. postgres
   - image: postgres:16-alpine
   - env: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD dari .env
   - port: 5432
   - volume: postgres_data
   - healthcheck: pg_isready

3. bot_engine
   - build: ./bot_engine
   - depends_on: redis, postgres
   - env_file: .env
   - restart: unless-stopped
   - volumes: ./bot_engine:/app (untuk hot-reload dev)

4. api_server
   - build: ./api_server
   - depends_on: redis, postgres
   - env_file: .env
   - port: 8000
   - restart: unless-stopped

5. monitoring
   - build: ./monitoring
   - depends_on: redis, postgres
   - env_file: .env
   - restart: unless-stopped

Tambahkan profile "dev" untuk semua service selain redis dan postgres.
Buat juga docker-compose.override.yml untuk development (volume mounts, reload).
```

---

## Prompt 1.3 — .env.example

```
Buat .env.example di root proyek. Sertakan semua variabel yang dibutuhkan oleh
bot_engine, api_server, dan monitoring berdasarkan @crypto-futures-bot-engine
dan @crypto-futures-bot-api skills.

Variabel yang HARUS ada:
- REDIS_URL, REDIS_PASSWORD
- DATABASE_URL (asyncpg format)
- ADMIN_PASSWORD_HASH (bcrypt — tulis placeholder "run: python -c ...")
- SESSION_SECRET (random 32 bytes hex)
- COOKIE_NAME, COOKIE_SECURE, COOKIE_DOMAIN
- CORS_ORIGINS (JSON array)
- LLM_PROVIDER (openai/anthropic), LLM_API_KEY, LLM_MODEL
- LLM_REFRESH_INTERVAL_S (default 240)
- EXCHANGE_1_KEY, EXCHANGE_1_SECRET (placeholder, tidak boleh hardcode)
- TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
- COMMAND_TIMEOUT_S (default 10)
- LOG_LEVEL (default INFO)
- ENVIRONMENT (development/production)

Format: KEY=value dengan komentar penjelasan tiap variabel.
Tambahkan instruksi cara generate password hash di komentar atas file.
Jangan isi nilai sensitif — semua placeholder.
```

---

## Prompt 1.4 — pyproject.toml dan requirements

```
Buat pyproject.toml di root proyek dengan konfigurasi:
- build-system: setuptools
- Python: versi terbaru yang stable (minimal 3.11)

Buat requirements file terpisah per service — gunakan versi latest/terbaru
untuk semua package, tanpa pin versi spesifik:

bot_engine/requirements.txt:
- ccxt
- ccxt[async]
- redis[asyncio]
- asyncpg
- sqlmodel
- sqlalchemy[asyncio]
- alembic
- pydantic-settings
- loguru
- pandas
- pandas-ta
- websockets
- httpx

api_server/requirements.txt:
- fastapi
- uvicorn[standard]
- redis[asyncio]
- asyncpg
- sqlmodel
- sqlalchemy[asyncio]
- pydantic-settings
- loguru
- bcrypt
- python-multipart

monitoring/requirements.txt:
- redis[asyncio]
- asyncpg
- sqlmodel
- sqlalchemy[asyncio]
- pydantic-settings
- loguru
- httpx

Buat juga Dockerfile minimal (python:latest-slim) untuk masing-masing service
di direktori service masing-masing. Gunakan non-root user, copy requirements,
pip install, copy source.
```

---

## Prompt 1.5 — Alembic setup

```
Setup Alembic untuk database migration di dalam bot_engine/:

1. Jalankan `alembic init bot_engine/alembic` (atau buat struktur manualnya)
2. Edit alembic/env.py:
   - Import Settings dari config.py
   - Set target_metadata dari SQLModel.metadata
   - Gunakan DATABASE_URL dari settings untuk async connection
   - Support async migration dengan AsyncEngine

3. Buat alembic.ini yang membaca DATABASE_URL dari .env (jangan hardcode)

4. Buat scripts/migrate.sh yang:
   - Load .env
   - Jalankan alembic upgrade head
   - Print status setelah selesai

Gunakan @crypto-futures-bot-db-schema untuk konteks schema yang akan dimigrate.
```
