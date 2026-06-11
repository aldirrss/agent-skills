# Fase 02 — Database Schema & Migration

Tujuan: PostgreSQL schema 5 tabel, migration script, dan asyncpg pool setup.
Prasyarat: Fase 01 selesai — postgres container berjalan.

---

## Prompt 2.1 — Migration script

```
Gunakan @web3-solana-db-schema secara lengkap, termasuk references/schema.md.

Buat db/migrations/migration_001_initial.sql dengan DDL untuk semua 5 tabel:

1. trades
   - Kolom: id, fill_id (UNIQUE), swap_id, mint, symbol, side, status,
     tx_signature, amount_usdc (NUMERIC), amount_tokens (BIGINT),
     price_usdc (NUMERIC), strategy, reason, pnl_usdc (NULL for BUY),
     pnl_pct (NULL for BUY), created_at (TIMESTAMPTZ)
   - Index: mint, strategy, created_at DESC, (side, status)

2. kol_wallets
   - Kolom: address (PK), label, source, win_rate, total_trades,
     avg_trade_usdc, total_pnl_usdc, active (DEFAULT true),
     last_seen_at, created_at, updated_at
   - Index: active, win_rate DESC NULLS LAST

3. signal_rejections
   - Kolom: id, mint, symbol, strategy, reason, sources (TEXT[]),
     confidence, liquidity_usdc, created_at
   - Index: reason, strategy, created_at DESC

4. strategy_stats
   - Kolom: strategy (PK), total_trades, wins, losses, win_rate,
     total_pnl_usdc, avg_pnl_usdc, best_trade_usdc, worst_trade_usdc,
     avg_hold_time_s, updated_at
   - TIDAK ada index tambahan — primary key cukup

5. daily_reports
   - Kolom: report_date (DATE PK), total_trades, win_rate, total_pnl_usdc,
     best_trade_usdc, worst_trade_usdc, strategies_used (TEXT[]),
     report_json (JSONB), created_at

Semua uang: NUMERIC, bukan FLOAT.
Semua timestamp: TIMESTAMPTZ.
Semua statement pakai IF NOT EXISTS — script idempotent, aman dijalankan ulang.
```

---

## Prompt 2.2 — asyncpg pool dan migration runner

```
Gunakan @web3-solana-db-schema references/queries.md.

Buat db/pool.py:
- async def create_pool(database_url: str) -> asyncpg.Pool
  - min_size=1, max_size=5
  - Test koneksi dengan SELECT 1, raise jika gagal
  - Return pool

Buat db/migrate.py:
- async def run_migrations(pool: asyncpg.Pool) -> None
  - Baca semua file migration_*.sql dari db/migrations/ secara sorted
  - Jalankan tiap file dalam satu transaction
  - Log nama file dan jumlah statement yang dieksekusi
  - Aman dijalankan berulang (semua DDL pakai IF NOT EXISTS)

Buat db/queries.py:
- Semua fungsi query sebagai async functions yang menerima pool
- Fungsi yang WAJIB ada:
  insert_buy_fill(pool, fill_data: dict) -> None
    → INSERT INTO trades dengan ON CONFLICT ON CONSTRAINT fill_id DO NOTHING
  update_sell_fill(pool, fill_data: dict, buy_amount_usdc: Decimal) -> None
    → UPDATE trades SET pnl_usdc, pnl_pct, status, tx_signature WHERE fill_id
    → pnl_usdc = sell_amount_usdc - buy_amount_usdc
    → pnl_pct = (pnl_usdc / buy_amount_usdc) * 100
  get_open_buy(pool, mint: str) -> dict | None
    → Ambil BUY confirmed terakhir untuk mint yang belum punya pasangan SELL
  insert_rejection(pool, rejection_data: dict) -> None
  rebuild_strategy_stats(pool) -> None
    → TRUNCATE strategy_stats lalu INSERT ... SELECT dari trades

Semua fungsi query:
  - Gunakan async with pool.acquire() as conn
  - Semua amount menggunakan Decimal, bukan float
  - Log error tapi jangan crash caller
```

---

## Prompt 2.3 — KOL wallet seed data

```
Gunakan @web3-solana-db-schema references/queries.md bagian kol_wallets.

Buat db/seed_kol_wallets.py:
- Script standalone yang bisa dijalankan: python -m db.seed_kol_wallets
- Load DATABASE_URL dari .env
- Buat pool dengan asyncpg
- Upsert 5-10 wallet placeholder sebagai contoh format data:
  {
    "address": "PLACEHOLDER_WALLET_ADDRESS_44_CHARS_LONG",
    "label": "whale_001",
    "source": "manual",
    "active": True,
  }
- Gunakan INSERT ... ON CONFLICT (address) DO UPDATE SET label, active, updated_at
- Print berapa wallet yang di-upsert
- Catatan di komentar: "Ganti placeholder address dengan wallet KOL nyata sebelum live"
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] migration_001_initial.sql — 5 tabel, semua IF NOT EXISTS
- [ ] db/pool.py — asyncpg pool dengan connection test
- [ ] db/migrate.py — runner sorted migration files
- [ ] db/queries.py — insert_buy_fill, update_sell_fill, get_open_buy, rebuild_strategy_stats
- [ ] db/seed_kol_wallets.py — placeholder data
