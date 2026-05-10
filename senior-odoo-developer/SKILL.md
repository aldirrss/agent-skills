---
name: senior-odoo-developer
description: >
  ELITE senior Odoo architect skill covering ALL versions (14–19). Use for ANY Odoo task:
  module development, architecture decisions, ORM patterns, security, performance, debugging,
  OWL components, migration, testing, and OCA integration. Automatically adapts guidance
  to the detected Odoo version. Triggers on: __manifest__.py, models/, views/, addons/,
  ir.rule, @api.depends, @api.onchange, fields.Many2one, search_read, sudo(), with_context(),
  OWL, N+1, UniqueViolation, InFailedSqlTransaction, tree/list view, attrs, computed field,
  wizard, cron, controller, webhook, migration, upgrade, OCA, stock, account, sale, hr, purchase.
globs: "**/*.{py,xml,csv,js,ts,scss}"
---

# Senior Odoo Developer — Elite Multi-Version Skill

Skill ini mencakup **Odoo 14 hingga 19** dengan pendekatan senior architect:
judgment calls, anti-patterns, architecture, dan version-aware guidance.

---

## ⚡ STEP 1 — DETEKSI VERSI (WAJIB)

Sebelum memberikan apapun, baca `__manifest__.py`:

```python
# Ekstrak versi dari field 'version': 'X.0.Y.Z'
# Digit pertama = versi Odoo (14, 15, 16, 17, 18, 19)
```

Lalu load `references/00-version-matrix.md` untuk context perbedaan kritis versi tersebut.

---

## ⚡ STEP 2 — CEK OCA SEBELUM BUILD

Sebelum develop fitur baru, cari di:
1. Odoo Community: `github.com/odoo/odoo/tree/{version}.0/addons`
2. OCA: `github.com/OCA?q={keyword}&type=repositories`

> Lihat workflow lengkap → `references/12-oca-workflow.md`

---

## Quick Index — Load File Sesuai Kebutuhan

| Kebutuhan | File |
|-----------|------|
| Perbedaan API antar versi | `references/00-version-matrix.md` |
| Struktur modul, service layer | `references/01-architecture.md` |
| Pilih decorator, field type, auth | `references/02-decision-trees.md` |
| ORM, CRUD, domain, read_group | `references/03-orm-patterns.md` |
| Views XML, attrs vs inline | `references/04-view-patterns.md` |
| ACL, record rules, security | `references/05-security.md` |
| N+1, SQL, batch optimization | `references/06-performance.md` |
| Debug traceback, OWL error | `references/07-debugging.md` |
| Code review checklist | `references/08-code-quality.md` |
| OWL components (v1/v2/v3) | `references/09-owl-components.md` |
| Unit test, integration test | `references/10-testing.md` |
| Upgrade v14→v19, migration script | `references/11-migration.md` |
| OCA search & integration | `references/12-oca-workflow.md` |
| Anti-patterns per versi | `references/13-pitfalls.md` |

---

## Version Dispatch Cheatsheet

```
Manifest version X.0.Y.Z → Odoo vX

v14 → Python 3.8,  OWL 1.x, <tree>, attrs=, @api.multi deprecated
v15 → Python 3.8+, OWL 1.x, <tree>, attrs=, @api.multi REMOVED
v16 → Python 3.10, OWL 2.x, <tree>, attrs=, cr.execute()
v17 → Python 3.11, OWL 2.x, <tree>/<list> transition, SQL() class, inline attrs
v18 → Python 3.12, OWL 2.x, <list>, inline attrs, SQL() class, aggregator=
v19 → Python 3.12, OWL 3.x, <list>, inline attrs, SQL() class
```

Untuk tabel lengkap perbedaan setiap API → `references/00-version-matrix.md`

---

## Golden Rules (Berlaku Semua Versi)

1. **Thin controllers, fat models** — business logic di model, bukan controller
2. **No search() inside loops** — selalu batch dengan domain `IN`
3. **store=True jika field di-search** — computed field tanpa store tidak bisa di-filter
4. **sudo() harus ada alasannya** — jangan sudo() karena malas fix ACL
5. **Security first** — `ir.model.access.csv` wajib untuk setiap model baru
6. **Check OCA dulu** — jangan reinvent the wheel
7. **Version-aware syntax** — `<tree>` di v14-16, `<list>` di v17+
