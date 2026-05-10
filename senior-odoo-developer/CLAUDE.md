# CLAUDE.md — senior-odoo-developer Skill

## Tentang Skill Ini

Skill **standalone** untuk senior Odoo architect, mencakup semua versi **14 hingga 19**.
Tidak perlu skill tambahan — semua referensi sudah bundled.

## Cara Invoke

```
Skill("senior-odoo-developer")
```

atau user mengetik `/senior-odoo-developer`

## Workflow Wajib

1. **Deteksi versi** dari `__manifest__.py` sebelum berikan guidance apapun
2. **Load `references/00-version-matrix.md`** untuk context perbedaan versi
3. **Cek OCA** sebelum sarankan develop dari scratch (`references/12-oca-workflow.md`)

## Struktur File

```
senior-odoo-developer/
├── SKILL.md                       # Entry point + version dispatch
├── CLAUDE.md                      # File ini
├── AGENTS.md                      # Setup guide untuk agent lain
└── references/
    ├── 00-version-matrix.md       # ← LOAD PERTAMA setelah detect versi
    ├── 01-architecture.md         # Module structure, service layer
    ├── 02-decision-trees.md       # Kapan pakai apa
    ├── 03-orm-patterns.md         # ORM, CRUD, domain, read_group
    ├── 04-view-patterns.md        # Views dengan version-specific syntax
    ├── 05-security.md             # ACL, record rules, pitfalls
    ├── 06-performance.md          # N+1, SQL, batch, index
    ├── 07-debugging.md            # Systematic debugging workflow
    ├── 08-code-quality.md         # Review checklist, naming, anti-patterns
    ├── 09-owl-components.md       # OWL 1.x/2.x/3.x per versi
    ├── 10-testing.md              # Unit test, integration, HTTP test
    ├── 11-migration.md            # Upgrade paths v14→v19
    ├── 12-oca-workflow.md         # OCA search sebelum build
    └── 13-pitfalls.md             # Anti-patterns per versi
```

## Kapan Load File Mana

| User menanyakan... | Load |
|--------------------|------|
| Version terdeteksi | `00-version-matrix.md` (SELALU) |
| Struktur modul, service layer | `01-architecture.md` |
| Pilih decorator / field type | `02-decision-trees.md` |
| ORM query, CRUD, domain | `03-orm-patterns.md` |
| View XML, attrs, form, tree | `04-view-patterns.md` |
| ACL, record rules, security | `05-security.md` |
| Kode lambat, N+1, SQL | `06-performance.md` |
| Error, traceback, debugging | `07-debugging.md` |
| Code review | `08-code-quality.md` |
| OWL, component, JS | `09-owl-components.md` |
| Test, unittest | `10-testing.md` |
| Upgrade, migration script | `11-migration.md` |
| Apakah ada module OCA? | `12-oca-workflow.md` |
| Anti-pattern, jebakan | `13-pitfalls.md` |

## Prinsip Behavior

- Berikan **rekomendasi tegas** — jangan false balance
- **Version-aware** selalu — syntax yang benar untuk versi yang tepat
- Target: **senior developer** — skip penjelasan hal dasar
- **OCA first** — cek OCA sebelum sarankan build dari scratch
- Gunakan bahasa yang sama dengan user (Indonesia jika user pakai Indonesia)
