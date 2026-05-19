# CLAUDE.md — senior-odoo-developer Skill

## About This Skill

A **standalone** skill for senior Odoo architects, covering all versions **14 through 19**.
No additional skills required — all references are bundled inside.

## How to Invoke

```
Skill("senior-odoo-developer")
```

or the user types `/senior-odoo-developer`

## Required Workflow

1. **Detect version** from `__manifest__.py` before providing any guidance
2. **Load `references/00-version-matrix.md`** for version-specific API differences
3. **Check OCA** before suggesting building from scratch (`references/12-oca-workflow.md`)

## File Structure

```
senior-odoo-developer/
├── SKILL.md                       # Entry point + version dispatch
├── CLAUDE.md                      # This file
├── AGENTS.md                      # Setup guide for other agents
└── references/
    ├── 00-version-matrix.md       # ← LOAD FIRST after version detection
    ├── 01-architecture.md         # Module structure, service layer
    ├── 02-decision-trees.md       # When to use what
    ├── 03-orm-patterns.md         # ORM, CRUD, domain, read_group
    ├── 04-view-patterns.md        # Views with version-specific syntax
    ├── 05-security.md             # ACL, record rules, pitfalls
    ├── 06-performance.md          # N+1, SQL, batch, index
    ├── 07-debugging.md            # Systematic debugging workflow
    ├── 08-code-quality.md         # Review checklist, naming, anti-patterns
    ├── 09-owl-components.md       # OWL 1.x/2.x/3.x per version
    ├── 10-testing.md              # Unit test, integration, HTTP test
    ├── 11-migration.md            # Upgrade paths v14→v19
    ├── 12-oca-workflow.md         # OCA search before building
    └── 13-pitfalls.md             # Anti-patterns per version
```

## When to Load Which File

| User asks about... | Load |
|--------------------|------|
| Version detected | `00-version-matrix.md` (ALWAYS first) |
| Module structure, service layer | `01-architecture.md` |
| Choose decorator / field type | `02-decision-trees.md` |
| ORM query, CRUD, domain | `03-orm-patterns.md` |
| View XML, attrs, form, tree | `04-view-patterns.md` |
| ACL, record rules, security | `05-security.md` |
| Slow code, N+1, SQL | `06-performance.md` |
| Error, traceback, debugging | `07-debugging.md` |
| Code review | `08-code-quality.md` |
| OWL, component, JS | `09-owl-components.md` |
| Test, unittest | `10-testing.md` |
| Upgrade, migration script | `11-migration.md` |
| OCA modules available? | `12-oca-workflow.md` |
| Anti-patterns, traps | `13-pitfalls.md` |

## Behavioral Principles

- Give **opinionated recommendations** — avoid false balance
- Always be **version-aware** — use correct syntax for the right version
- Target audience: **senior developer** — skip basic explanations
- **OCA first** — check OCA before suggesting building from scratch
- Use the same language as the user (Indonesian if user uses Indonesian)
