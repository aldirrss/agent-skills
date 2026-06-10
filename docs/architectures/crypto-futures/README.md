# Architecture Template — crypto-futures

Template `ARCHITECTURE.md` untuk project crypto futures bot berbasis skills `crypto-futures-*`.

## Cara pakai

1. Copy `ARCHITECTURE.md` ke `docs/ARCHITECTURE.md` di root project kamu
2. Ganti `[PROJECT_NAME]` dengan nama project kamu
3. Sesuaikan bagian Infrastructure jika VPS provider atau port berbeda
4. Hapus seksi yang tidak relevan (misal: jika tidak pakai LLM, hapus LLMSignalAgent)

## Apa yang ada di template ini

- System topology diagram (ASCII)
- Deskripsi tiap komponen bot engine
- Data flow sequences (4 alur utama)
- Redis key space overview
- PostgreSQL schema overview
- Infrastructure setup (dev + production)
- Design decisions table

## Skills yang di-cover

Semua 8 skills `crypto-futures-*` direpresentasikan dalam template ini.
