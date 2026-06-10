# Memory Template — crypto-futures

Template `CLAUDE.md` untuk project crypto futures bot berbasis skills `crypto-futures-*`.

## Cara pakai

1. Copy `CLAUDE.md` ke root project kamu (nama file tetap `CLAUDE.md`)
2. Ganti `[PROJECT_NAME]` dengan nama project kamu
3. Isi bagian `[SESUAIKAN]` dengan detail spesifik project:
   - Exchange utama yang digunakan
   - Info VPS dan domain
   - Telegram chat ID
   - LLM provider
   - Strategi dan symbol yang aktif
4. Jangan ubah bagian "Aturan Wajib" — aturan ini berlaku untuk semua project crypto-futures

## Apa yang ada di template ini

- Tech stack overview
- Tabel skills → kapan harus di-load
- Struktur direktori lengkap
- 10 aturan wajib (safety + correctness)
- Commands untuk development
- Environment variables yang dibutuhkan
- Redis key conventions
- Catatan penting (LiquidationCollector, LLM, PositionManager, WebSocket)
- Placeholder `[SESUAIKAN]` untuk info spesifik project
