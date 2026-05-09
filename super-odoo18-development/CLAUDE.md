# CLAUDE.md — super-odoo18-development Skill

## Tentang Skill Ini

Skill ini adalah **standalone senior architect layer** untuk Odoo 18.
Tidak memerlukan skill lain — semua referensi sudah tersedia di dalam folder `references/`.

## Cara Menggunakan

Invoke via Skill tool di Claude Code:
```
Skill("super-odoo18-development")
```

Atau user mengetik `/super-odoo18-development` di Claude Code.

## Struktur File

```
super-odoo18-development/
├── SKILL.md                        # Entry point — baca ini pertama
├── CLAUDE.md                       # File ini
├── AGENTS.md                       # Instruksi untuk agent lain
└── references/
    ├── decision-trees.md           # Pohon keputusan dekorator, field, dll
    ├── pitfalls.md                 # Jebakan umum — N+1, transaksi, OWL
    ├── architecture.md             # Pola arsitektur modul
    ├── debugging.md                # Pendekatan sistematis debugging
    ├── code-quality.md             # Checklist review kode
    └── odoo-18-security-guide.md   # Panduan lengkap security Odoo 18
```

## Kapan Load File references/

Jangan load semua sekaligus. Load hanya saat dibutuhkan:

| User menanyakan... | Load file ini |
|--------------------|---------------|
| Pilih decorator / field type | `references/decision-trees.md` |
| Kode lambat / N+1 | `references/pitfalls.md` |
| Struktur modul / service layer | `references/architecture.md` |
| Ada error / traceback | `references/debugging.md` |
| Review kode | `references/code-quality.md` |
| ACL / record rules / XSS / injection | `references/odoo-18-security-guide.md` |

## Prinsip Utama

- Berikan **rekomendasi tegas** — jangan false balance
- Fokus pada **judgment** (kapan & kenapa), bukan syntax
- Gunakan bahasa yang sama dengan user (Indonesia jika user pakai Indonesia)
- Skill ini untuk **senior developer** — tidak perlu jelaskan hal dasar
