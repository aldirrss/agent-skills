# Odoo 16 Documentation - AI Agents Setup

Setup guide for using Odoo 16 documentation with AI coding assistants (Cursor, Claude Code, Windsurf, Aider, etc.).

## Quick Start

### Install via skills.sh (Recommended)

```bash
# Add Odoo 16 skill to your project
npx skills add aldirrss/agent-skills --skill odoo-16 -a claude-code
```

### Cursor IDE - Remote Rule

Configure once in Cursor settings:
- `Settings` → `Rules` → `Add Remote Rule`
- Source: `Git Repository`
- URL: `git@github.com:aldirrss/agent-skills.git`
- Branch: `main`
- Subfolder: `odoo-16/`

---

## Documentation Structure

```
skills/odoo-16.0/
├── SKILL.md                       # Master index (all agents)
├── references/                    # Development guides (18 files)
│   ├── odoo-16-actions-guide.md     # ir.actions.*, cron, bindings
│   ├── odoo-16-controller-guide.md  # HTTP, routing, controllers
│   ├── odoo-16-data-guide.md        # XML/CSV data files, records
│   ├── odoo-16-decorator-guide.md   # @api decorators
│   ├── odoo-16-development-guide.md # Manifest, wizards (overview)
│   ├── odoo-16-field-guide.md       # Field types, parameters
│   ├── odoo-16-manifest-guide.md    # __manifest__.py reference
│   ├── odoo-16-mixins-guide.md      # mail.thread, activities, etc.
│   ├── odoo-16-model-guide.md       # ORM, CRUD, search, domain
│   ├── odoo-16-migration-guide.md   # Migration scripts, hooks
│   ├── odoo-16-owl-guide.md         # OWL components, services
│   ├── odoo-16-performance-guide.md # N+1 prevention, optimization
│   ├── odoo-16-reports-guide.md     # QWeb reports, PDF/HTML
│   ├── odoo-16-security-guide.md    # ACL, record rules, security
│   ├── odoo-16-testing-guide.md     # Test classes, decorators
│   ├── odoo-16-transaction-guide.md # Savepoints, errors
│   ├── odoo-16-translation-guide.md # Translations, i18n
│   └── odoo-16-view-guide.md        # XML views, QWeb
├── CLAUDE.md                      # Claude Code specific
└── AGENTS.md                      # THIS FILE - setup guide
```

---

## Guide Reference

| File | Purpose | When to Use |
|------|---------|-------------|
| `SKILL.md` | Master index for all guides | Find the right guide for your task |
| `references/odoo-16-actions-guide.md` | Actions (window, URL, server, cron) | Creating actions, menus, scheduled jobs |
| `references/odoo-16-controller-guide.md` | HTTP controllers, routing | Writing endpoints |
| `references/odoo-16-data-guide.md` | XML/CSV data files, records | Creating data files |
| `references/odoo-16-decorator-guide.md` | @api decorators usage | Using @api decorators |
| `references/odoo-16-development-guide.md` | Module structure, wizards | Creating new modules |
| `references/odoo-16-field-guide.md` | Field types, parameters | Defining model fields |
| `references/odoo-16-manifest-guide.md` | __manifest__.py reference | Configuring module manifest |
| `references/odoo-16-mixins-guide.md` | mail.thread, activities, mixins | Adding messaging, activities |
| `references/odoo-16-model-guide.md` | ORM methods, CRUD, domains | Writing model methods |
| `references/odoo-16-migration-guide.md` | Migration scripts, hooks | Upgrading modules |
| `references/odoo-16-owl-guide.md` | OWL components, hooks, services | Building OWL UI |
| `references/odoo-16-performance-guide.md` | Performance optimization | Fixing slow code |
| `references/odoo-16-reports-guide.md` | QWeb reports, templates | Creating reports |
| `references/odoo-16-security-guide.md` | ACL, record rules, security | Configuring security |
| `references/odoo-16-testing-guide.md` | Test classes, decorators, mocking | Writing tests |
| `references/odoo-16-transaction-guide.md` | Database transactions, error handling | Savepoints, UniqueViolation |
| `references/odoo-16-translation-guide.md` | Translations, localization, i18n | Adding translations |
| `references/odoo-16-view-guide.md` | XML views, actions, menus | Writing view XML |

---

## AI Agent Configuration

### Cursor IDE

| Setting | Value |
|---------|-------|
| Source | Git Repository |
| URL | `git@github.com:unclecatvn/agent-skills.git` |
| Branch | `16.0` |
| Subfolder | `skills/odoo-16.0/` |

**Globs patterns used by Cursor:**

| File | globs Pattern |
|------|---------------|
| `SKILL.md` | `**/*.{py,xml}` |
| `references/odoo-16-actions-guide.md` | `**/*.{py,xml}` |
| `references/odoo-16-controller-guide.md` | `**/controllers/**/*.py` |
| `references/odoo-16-data-guide.md` | `**/*.{xml,csv}` |
| `references/odoo-16-decorator-guide.md` | `**/models/**/*.py` |
| `references/odoo-16-development-guide.md` | `**/*.{py,xml,csv}` |
| `references/odoo-16-field-guide.md` | `**/models/**/*.py` |
| `references/odoo-16-manifest-guide.md` | `**/__manifest__.py` |
| `references/odoo-16-mixins-guide.md` | `**/models/**/*.py` |
| `references/odoo-16-model-guide.md` | `**/models/**/*.py` |
| `references/odoo-16-migration-guide.md` | `**/migrations/**/*.py` |
| `references/odoo-16-owl-guide.md` | `static/src/**/*.{js,xml}` |
| `references/odoo-16-performance-guide.md` | `**/*.{py,xml}` |
| `references/odoo-16-reports-guide.md` | `**/report/**/*.xml` |
| `references/odoo-16-security-guide.md` | `**/security/**/*.{csv,xml}` |
| `references/odoo-16-testing-guide.md` | `**/tests/**/*.py` |
| `references/odoo-16-transaction-guide.md` | `**/models/**/*.py` |
| `references/odoo-16-translation-guide.md` | `**/*.{py,js,xml}` |
| `references/odoo-16-view-guide.md` | `**/views/**/*.xml` |

### Claude Code

```bash
# Install via skills.sh
npx skills add aldirrss/agent-skills --skill odoo-16 -a claude-code
```

Claude Code reads:
- `CLAUDE.md` - Project overview and quick reference
- `SKILL.md` - Master index for all guides
- Individual guides in `references/` - Detailed information

### Other Agents

| Agent | Setup |
|-------|-------|
| Windsurf | Same as Cursor (uses `.mdc` files) |
| Continue | Place `CLAUDE.md` or `SKILL.md` in root |
| Aider | Place `CLAUDE.md` or add to prompt |
| OpenCode | Copy skill folder to project - no additional config needed |

---

## Cursor / Claude Skills Folder

After installing via `npx skills add aldirrss/agent-skills`, the skill is placed at:

```
.cursor/skills/
└── odoo-16/
    └── SKILL.md

.claude/skills/
└── odoo-16/
    └── SKILL.md
```

---

## Odoo 16 vs 17/18 — Key Differences

| Aspect | Odoo 16 (THIS skill) | Odoo 17/18 |
|--------|---------------------|------------|
| List view tag | `<tree>` | `<list>` |
| Dynamic attributes | `attrs="{'invisible': [...]}"` | `invisible="..."` (inline) |
| Delete validation | `unlink()` override or `@api.ondelete` | `@api.ondelete` preferred |
| Field aggregation | `group_operator=` | `aggregator=` |
| SQL queries | `cr.execute("...", (param,))` | `SQL()` class |
| `read_group` return | List of dicts | Grouped recordsets |
| Python version | 3.10 | 3.12 |
| OWL RPC | `this.rpc()` or `useService('rpc')` | `useService('rpc')` only |

---

## Repository

**URL**: `git@github.com:aldirrss/agent-skills.git`
**Branch**: `main`
**License**: MIT
