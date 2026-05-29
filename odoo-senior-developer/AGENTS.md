# AGENTS.md — senior-odoo-developer Skill

## Overview

Standalone senior Odoo architect skill covering **all versions 14–19**.
No external skill dependencies — all references bundled in `references/`.

## Install

```bash
npx skills add aldirrss/agent-skills --skill senior-odoo-developer -a claude-code
```

## Activation Triggers

This skill activates for ANY Odoo development task involving:
- `__manifest__.py`, `models/`, `views/`, `addons/` directories
- `@api.depends`, `@api.onchange`, `@api.constrains`, `@api.ondelete`
- `fields.Many2one`, `fields.One2many`, `fields.Many2many`
- `search_read`, `sudo()`, `with_context()`
- OWL components, `useService`, `useState`
- `UniqueViolation`, `InFailedSqlTransaction`, N+1 queries
- `ir.rule`, `ir.model.access`, security groups
- Migration, upgrade, version compatibility
- OCA modules, `github.com/OCA`

## Mandatory Workflow

1. **Detect Odoo version** from `__manifest__.py` (`version: 'X.0.Y.Z'`)
2. **Load `references/00-version-matrix.md`** for version-specific API differences
3. **Check OCA** before suggesting building from scratch (`references/12-oca-workflow.md`)

## File Structure

```
senior-odoo-developer/
├── SKILL.md                       # Entry point + dispatch logic
├── CLAUDE.md                      # Claude Code instructions
├── AGENTS.md                      # This file
└── references/
    ├── 00-version-matrix.md       # Critical API differences v14–v19
    ├── 01-architecture.md         # Module structure, service layer
    ├── 02-decision-trees.md       # When to use what
    ├── 03-orm-patterns.md         # ORM, CRUD, domain, read_group
    ├── 04-view-patterns.md        # XML views with version sections
    ├── 05-security.md             # ACL, record rules, pitfalls
    ├── 06-performance.md          # N+1, SQL, batch, index
    ├── 07-debugging.md            # Systematic debugging workflow
    ├── 08-code-quality.md         # Review checklist, anti-patterns
    ├── 09-owl-components.md       # OWL 1.x/2.x/3.x per version
    ├── 10-testing.md              # Unit/integration/HTTP tests
    ├── 11-migration.md            # Upgrade paths v14→v19
    ├── 12-oca-workflow.md         # OCA search before building
    └── 13-pitfalls.md             # Anti-patterns per version
```

## Loading Strategy

Load `references/` files **on demand**, not all at once.
Always load `00-version-matrix.md` first after version detection.

| User asks about... | Load |
|--------------------|------|
| Version detected | `00-version-matrix.md` (ALWAYS first) |
| Module structure | `01-architecture.md` |
| Which decorator/field | `02-decision-trees.md` |
| ORM, search, domain | `03-orm-patterns.md` |
| Views, XML, attrs | `04-view-patterns.md` |
| ACL, record rules | `05-security.md` |
| Performance, N+1 | `06-performance.md` |
| Error, traceback | `07-debugging.md` |
| Code review | `08-code-quality.md` |
| OWL, JavaScript | `09-owl-components.md` |
| Tests | `10-testing.md` |
| Upgrade, migration | `11-migration.md` |
| OCA modules | `12-oca-workflow.md` |
| Anti-patterns | `13-pitfalls.md` |

## Behavioral Guidelines

- Give **opinionated, version-correct** recommendations
- Always specify WHICH version the guidance applies to
- Senior audience — skip basic explanations
- **OCA first** — check OCA repositories before suggesting custom development
- Show bad pattern alongside correct fix
- End debugging with root cause + prevention, not just the fix

## Version Quick Reference

| Version | Python | OWL | List Tag | Dynamic Attrs | SQL Helper |
|---------|--------|-----|----------|---------------|------------|
| v14 | 3.8 | 1.x | `<tree>` | `attrs=` | `cr.execute()` |
| v15 | 3.8+ | 1.x | `<tree>` | `attrs=` | `cr.execute()` |
| v16 | 3.10 | 2.x | `<tree>` | `attrs=` | `cr.execute()` |
| v17 | 3.11 | 2.x | `<tree>`/`<list>` | both valid | `SQL()` class |
| v18 | 3.12 | 2.x | `<list>` | inline | `SQL()` class |
| v19 | 3.12+ | 3.x | `<list>` | inline | `SQL()` class |
