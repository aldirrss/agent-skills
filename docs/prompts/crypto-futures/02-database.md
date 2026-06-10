# Fase 02 — Database Schema

Tujuan: SQLModel models, DDL, initial migration, dan seed script.
Prasyarat: Fase 01 selesai, Alembic sudah setup.

---

## Prompt 2.1 — SQLModel models

```
Gunakan @crypto-futures-bot-db-schema untuk implementasi database schema.

Buat file bot_engine/db/models.py dengan semua SQLModel table classes:
- Account (id, name, exchange, api_key_ref, is_testnet, is_active, created_at)
- Symbol (id, account_id FK, symbol, strategy, leverage, risk_pct, timeframe,
          timeframes JSON, is_active, created_at)
- Trade (id, account_id FK, symbol, direction, qty, entry_price, exit_price,
         pnl, fee, sl_price, tp_price, status, strategy, signal_id,
         entry_order_id, sl_order_id, tp_order_id, opened_at, closed_at)
- Signal (id, account_id FK, symbol, strategy, direction, confidence,
          regime, confluence_score, confluence_details JSON, llm_score,
          llm_direction, acted_on bool, signal_ts, created_at)
- DailyPnl (id, account_id FK, date, realized_pnl, fee_total, trade_count,
            win_count, loss_count, max_drawdown_pct, created_at)

Aturan penting:
- Semua kolom harga, qty, pnl, fee: gunakan Numeric(24,8) — JANGAN Float
- Gunakan timezone-aware datetime (timezone=True)
- Setiap model punya Field(default=None, primary_key=True) untuk id
- Tambahkan index pada: symbol, account_id, opened_at, closed_at, status
- Relationships antar model menggunakan SQLModel Relationship

Buat juga bot_engine/db/engine.py:
- create_async_engine dengan DATABASE_URL dari settings
- AsyncSession factory
- get_session() dependency untuk FastAPI dan bot engine
```

---

## Prompt 2.2 — Initial migration dan seed

```
Prasyarat: bot_engine/db/models.py sudah dibuat.
Gunakan @crypto-futures-bot-db-schema untuk referensi.

1. Generate Alembic migration pertama:
   Buat bot_engine/alembic/versions/0001_initial_schema.py
   yang berisi CREATE TABLE untuk semua model dari models.py.
   Gunakan sa.Numeric(24, 8) untuk kolom harga.
   Tambahkan indeks eksplisit.

2. Buat scripts/seed.py yang:
   - Membuat 1 Account default (name="main", exchange="binance",
     api_key_ref="EXCHANGE_1_KEY", is_testnet=True)
   - Tambahkan 1 Symbol default (BTCUSDT, strategy=trend, leverage=10,
     risk_pct=0.01)
   - Idempotent: cek dulu apakah sudah ada sebelum insert
   - Jalankan dengan: python scripts/seed.py

3. Buat scripts/check_db.py yang:
   - Konek ke DB dan Redis
   - Print status koneksi (OK/FAIL)
   - Print tabel yang ada
   - Berguna untuk health check saat development
```

---

## Prompt 2.3 — Query patterns

```
Gunakan @crypto-futures-bot-db-schema references/query-patterns.md.

Buat bot_engine/db/queries.py dengan fungsi-fungsi async berikut:

1. get_daily_pnl(session, account_id, start_date, end_date) → list[DailyPnl]
2. get_equity_curve(session, account_id, days=90) → list[dict]
   - Returns: [{date, cumulative_pnl, drawdown_pct}]
3. get_trade_stats(session, account_id, symbol=None, days=30) → dict
   - Returns: {win_rate, profit_factor, avg_pnl, max_drawdown_pct, trade_count}
4. get_open_trades(session, account_id) → list[Trade]
5. upsert_daily_pnl(session, account_id, date, pnl_delta, fee, won) → DailyPnl
   - Digunakan oleh DBWriter setelah setiap fill

Semua fungsi menggunakan select() dari sqlalchemy, bukan query string.
Return values menggunakan Decimal untuk semua angka finansial.
```

---

## Roadmap

Selesai? Tandai di `docs/ROADMAP.md` → Phase 1 › Infrastructure:

- [ ] Alembic initial schema migration
