# Web3 Solana Trading Bot — Prompt Guide

Kumpulan prompt siap pakai untuk membangun Solana DEX trading bot dari nol
menggunakan Claude Code. Urutan prompt mengikuti dependency antar komponen —
jangan loncat fase.

## Pipeline Flow

```
Scanner (10 sources: Helius webhook + 9 pollers)
    ↓ pub/sub: scanner.token.new / scanner.token.trending / scanner.wallet.buy
Strategy — pre-filter: anchor signal present per strategi?
    ↓ confluence engine: SIGNAL_WEIGHTS + MIN_CONFIDENCE_SCORE (Layer 1 scoring)
    ↓ stream.signals.raw  [jika AGENT_ENABLED=true]
AgentConfirmer — LLM scoring (Layer 2, opsional)
    ↓ final_confidence = original×0.7 + llm_score×0.3
    ↓ stream.signals
RiskManager — safety gate (position limit, circuit breaker, SOL reserve)
    ↓ stream.swaps [Redis Stream]
Execution — Jupiter V6 quote → sign → send → confirm
    ↓ stream.fills
PositionTracker + DBWriter
```

## Cara Pakai

1. Buka proyek baru di Claude Code
2. Pastikan semua skill `web3-solana-*` sudah terkonfigurasi
3. Copy-paste prompt dari file yang sesuai fase
4. Tunggu Claude Code selesai generate, review hasilnya, baru lanjut
5. Setiap prompt dalam satu file bisa dijalankan dalam **satu sesi** Claude Code

## Urutan Pengerjaan

```
01-infra-setup.md       → Docker, .env, pyproject.toml, struktur direktori
02-database.md          → PostgreSQL schema (5 tabel), migration, asyncpg pool
03-engine-core.md       → main.py, config.py, logger_setup.py, startup/shutdown
04-scanner.md           → Scanner (10 sources, dedup, signal normalization)
05-strategy.md          → Strategy (SignalBuffer, 6 strategi, confluence engine)
06-risk-execution.md    → RiskManager (safety gate) + Execution (Jupiter swap)
07-agent-layer.md       → AgentConfirmer (LLM Layer 2, opsional)
08-monitor.md           → Monitor (Telegram, heartbeat, metrics, daily report)
```

## Skill yang Digunakan

| Skill | Fase |
|---|---|
| `@web3-solana` | Semua fase — safety rules wajib dibaca dulu |
| `@web3-solana-architecture` | 01, 03 — blueprint Redis schema dan component wiring |
| `@web3-solana-db-schema` | 02 — DDL tabel dan query patterns |
| `@web3-solana-engine` | 03 — startup/shutdown sequence, directory layout |
| `@web3-solana-scanner` | 04 — 10 scanner sources dan signal format |
| `@web3-solana-strategy` | 05 — 6 strategi, confluence model, position monitor |
| `@web3-solana-risk` | 06 — safety gate, position sizing, slippage tiers |
| `@web3-solana-execution` | 06 — Jupiter flow, signing, confirmation, error handling |
| `@web3-solana-agent` | 07 — AgentConfirmer, LLM scoring, fail-open design |
| `@web3-solana-monitor` | 08 — Telegram alerts, heartbeat, stats, daily report |

## Tips

- **Baca `@web3-solana` dulu sebelum apapun** — 10 safety rules non-negotiable
  berlaku untuk semua kode yang dihasilkan. Private key, slippage, confirmation —
  semua harus sesuai rules tersebut.
- **Default `DRY_RUN=true`** — semua kode yang dihasilkan harus bisa berjalan
  tanpa mengirim transaksi nyata. Mainnet adalah opt-in eksplisit.
- **Jangan skip review** — bug di fase awal (DB schema, Redis naming) menyebar
  ke seluruh codebase.
- **Satu prompt = satu unit kerja** — jika terlalu besar untuk satu sesi, potong jadi dua.

## Struktur Proyek yang Dihasilkan

```
solana-bot/
├── main.py
├── config.py
├── logger_setup.py
├── components/
│   ├── scanner/
│   │   ├── dexscreener.py
│   │   ├── gmgn.py
│   │   ├── pumpfun.py
│   │   ├── birdeye.py
│   │   ├── helius.py
│   │   ├── kol_wallet.py
│   │   ├── cielo.py
│   │   ├── twitter.py
│   │   └── telegram.py
│   ├── strategy/
│   │   ├── buffer.py
│   │   ├── confluence.py
│   │   ├── kol_copy.py
│   │   ├── new_launch.py
│   │   ├── graduation.py
│   │   ├── momentum.py
│   │   ├── smart_money.py
│   │   ├── social_alpha.py
│   │   └── position_monitor.py
│   ├── risk_manager.py
│   ├── execution.py
│   ├── position_tracker.py
│   ├── db_writer.py
│   ├── command_listener.py
│   ├── agent_confirmer.py
│   └── monitor.py
├── db/
│   └── migrations/
│       └── migration_001_initial.sql
├── .env
└── .env.example
```
