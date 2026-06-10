---
name: odoo-senior-developer
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

This skill covers **Odoo 14 through 19** with a senior architect approach:
judgment calls, anti-patterns, architecture, and version-aware guidance.

---

## ⚡ STEP 1 — VERSION DETECTION (REQUIRED)

Before providing any guidance, read `__manifest__.py`:

```python
# Extract version from 'version': 'X.0.Y.Z' field
# First digit = Odoo version (14, 15, 16, 17, 18, 19)
```

Then load `references/00-version-matrix.md` for critical API differences for that version.

---

## ⚡ STEP 2 — CHECK OCA BEFORE BUILDING

Before developing any new feature, search in:
1. Odoo Community: `github.com/odoo/odoo/tree/{version}.0/addons`
2. OCA: `github.com/OCA?q={keyword}&type=repositories`

> See full workflow → `references/12-oca-workflow.md`

---

## Quick Index — Load Files as Needed

| Need | File |
|------|------|
| API differences between versions | `references/00-version-matrix.md` |
| Module structure, service layer | `references/01-architecture.md` |
| Choose decorator, field type, auth | `references/02-decision-trees.md` |
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
| Anti-patterns per version | `references/13-pitfalls.md` |

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

For complete API differences per version → `references/00-version-matrix.md`

---

## Golden Rules (All Versions)

1. **Thin controllers, fat models** — business logic belongs in models, not controllers
2. **No search() inside loops** — always batch with `IN` domain
3. **store=True if field is searched** — computed fields without store cannot be filtered
4. **sudo() must have a reason** — never use sudo() just to bypass ACL
5. **Security first** — `ir.model.access.csv` required for every new model
6. **Check OCA first** — don't reinvent the wheel
7. **Version-aware syntax** — `<tree>` in v14-16, `<list>` in v17+
