# Fase 01 — Infrastructure Setup

Tujuan: Struktur direktori, Docker Compose, .env, dan pyproject.toml.
Prasyarat: Tidak ada — ini fase pertama.

---

## Prompt 1.1 — Buat struktur direktori proyek

```
Buat struktur direktori lengkap untuk proyek Solana DEX trading bot dengan layout:

solana-bot/
├── components/
│   ├── scanner/
│   └── strategy/
├── db/
│   └── migrations/
└── logs/

Buat __init__.py di setiap package Python.
Buat .gitkeep di folder yang masih kosong.
Jangan buat file apapun selain struktur direktori dan file init.
```

---

## Prompt 1.2 — docker-compose.yml

```
Gunakan @web3-solana-architecture untuk konteks Redis topology dan komponen bot.

Buat docker-compose.yml di root solana-bot/ dengan service berikut:

1. redis
   - image: redis:7-alpine
   - command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
   - port: 6379
   - volume: redis_data
   - healthcheck: redis-cli ping

2. postgres
   - image: postgres:16-alpine
   - env: POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD dari .env
   - port: 5432
   - volume: postgres_data
   - healthcheck: pg_isready

3. solana_bot
   - build: . (dari root)
   - depends_on dengan condition service_healthy untuk redis dan postgres
   - env_file: .env
   - restart: unless-stopped
   - volumes: ./logs:/app/logs

Tambahkan profile "dev" untuk solana_bot yang mount source code sebagai volume
untuk hot-reload development.
Semua service dalam satu network: solana_net
```

---

## Prompt 1.3 — .env.example

```
Gunakan @web3-solana untuk daftar variabel env yang dibutuhkan.
Gunakan @web3-solana-architecture untuk Redis dan PostgreSQL config.
Gunakan @web3-solana-agent untuk variabel agent layer.

Buat .env.example di root proyek. Sertakan semua variabel berikut dengan komentar:

# === SOLANA ===
WALLET_KEYPAIR_B64=          # base64 encoded 64-byte keypair — generate: python -c "from solders.keypair import Keypair; import base64; print(base64.b64encode(bytes(Keypair())).decode())"
RPC_PRIMARY_URL=             # Helius / QuickNode mainnet RPC
RPC_FALLBACK_URL=            # backup RPC
DRY_RUN=true                 # WAJIB true sampai siap mainnet

# === REDIS ===
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0
REDIS_PASSWORD=

# === POSTGRES ===
DATABASE_URL=postgresql+asyncpg://user:pass@postgres:5432/solana_bot
POSTGRES_DB=solana_bot
POSTGRES_USER=
POSTGRES_PASSWORD=

# === SCANNER APIS ===
HELIUS_API_KEY=              # helius.dev — untuk webhook dan RPC
HELIUS_WEBHOOK_SECRET=       # validasi webhook signature
BIRDEYE_API_KEY=
CIELO_API_KEY=
TWITTER_BEARER_TOKEN=
TELEGRAM_API_ID=             # dari my.telegram.org
TELEGRAM_API_HASH=
TELEGRAM_PHONE=

# === ALERTS ===
TELEGRAM_BOT_TOKEN=          # dari @BotFather
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=         # opsional

# === AGENT LAYER (opsional) ===
AGENT_ENABLED=false
ANTHROPIC_API_KEY=           # hanya dipakai jika AGENT_ENABLED=true
AGENT_MODEL=claude-haiku-4-5

# === RISK CONFIG ===
MAX_POSITION_USDC=500        # hard ceiling per trade — code constant, ini hanya dokumentasi
MAX_CONCURRENT_POSITIONS=5

Format: KEY=value dengan komentar penjelasan tiap baris.
Jangan isi nilai sensitif — semua placeholder.
Tambahkan peringatan besar di baris pertama: "JANGAN COMMIT FILE INI KE GIT"
Tambahkan .env ke .gitignore.
```

---

## Prompt 1.4 — Dockerfile dan pyproject.toml

```
Buat Dockerfile di root solana-bot/:
- Base image: python:3.12-slim
- Non-root user: appuser
- Install system deps: gcc, libpq-dev (untuk asyncpg)
- Copy requirements.txt, pip install
- Copy source, set WORKDIR /app
- CMD: python main.py

Buat requirements.txt dengan dependencies terbaru (tanpa pin versi spesifik):
- solders
- solana
- aiohttp
- asyncio (stdlib, tidak perlu install)
- loguru
- pydantic
- pydantic-settings
- redis[hiredis]
- asyncpg
- telethon         (Telegram scanner)

Buat pyproject.toml minimal:
- project name: solana-bot
- Python >= 3.12
- Tidak perlu build system — hanya metadata
```

---

## Roadmap

Selesai? Tandai progress berikut:

- [ ] Struktur direktori terbuat
- [ ] docker-compose.yml (redis, postgres, solana_bot)
- [ ] .env.example dengan semua variabel
- [ ] .env di .gitignore
- [ ] Dockerfile (non-root, python:3.12-slim)
- [ ] requirements.txt
