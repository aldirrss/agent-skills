# Odoo 16 Development Guide

This file provides guidance to AI agents when working with Odoo 16 code in this repository.

> **For setup instructions with different AI IDEs, see [AGENTS.md](./AGENTS.md)**

## Documentation Structure

The `skills/odoo-16.0/references/` directory contains modular guides for Odoo 16 development:

```
skills/odoo-16.0/
├── SKILL.md                       # Master index
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
├── CLAUDE.md                      # This file
└── AGENTS.md                      # AI agents setup
```

## Which Guide to Use

| Task | Guide |
|------|-------|
| Creating actions, menus, cron jobs | `references/odoo-16-actions-guide.md` |
| Creating a new module | `references/odoo-16-development-guide.md` |
| Configuring __manifest__.py | `references/odoo-16-manifest-guide.md` |
| Creating XML/CSV data files | `references/odoo-16-data-guide.md` |
| Writing ORM queries/search | `references/odoo-16-model-guide.md` |
| Defining model fields | `references/odoo-16-field-guide.md` |
| Using @api decorators | `references/odoo-16-decorator-guide.md` |
| Writing XML views | `references/odoo-16-view-guide.md` |
| Fixing slow code/N+1 queries | `references/odoo-16-performance-guide.md` |
| Handling database errors | `references/odoo-16-transaction-guide.md` |
| Creating HTTP endpoints | `references/odoo-16-controller-guide.md` |
| Building OWL components | `references/odoo-16-owl-guide.md` |
| Upgrading modules/migrating data | `references/odoo-16-migration-guide.md` |
| Using mail.thread, activities, mixins | `references/odoo-16-mixins-guide.md` |
| Creating QWeb reports | `references/odoo-16-reports-guide.md` |
| Configuring security (ACL, rules) | `references/odoo-16-security-guide.md` |
| Writing tests | `references/odoo-16-testing-guide.md` |
| Adding translations/localization | `references/odoo-16-translation-guide.md` |

## Odoo 16 vs Odoo 17/18 — Perbedaan Kritis

| Aspek | Odoo 16 (INI) | Odoo 17/18 |
|-------|--------------|------------|
| List view tag | `<tree>` ✅ | `<list>` |
| Dynamic attributes | `attrs="{'invisible': [...]}"` ✅ | `invisible="..."` (direct) |
| Delete validation | Override `unlink()` atau `@api.ondelete` | `@api.ondelete(at_uninstall=False)` |
| Field aggregation | `group_operator=` ✅ | `aggregator=` |
| SQL queries | `cr.execute("...", (param,))` ✅ | `SQL()` class |
| read_group API | Returns list of dicts | Returns grouped recordsets |
| Python | 3.10 | 3.12 |
| OWL RPC | `this.rpc(...)` atau `useService('rpc')` | `useService('rpc')` only |

## Critical Anti-Patterns (Odoo 16)

| Anti-Pattern | Why Bad | Correct Approach |
|--------------|---------|------------------|
| `invisible="state == 'draft'"` (inline) | Odoo 17/18 syntax — tidak valid di Odoo 16 | Gunakan `attrs="{'invisible': [('state', '=', 'draft')]}"` |
| `SQL()` class | Belum ada di Odoo 16 (masuk Odoo 17) | `self.env.cr.execute("SELECT ... WHERE id = %s", (record_id,))` |
| `aggregator=` pada field | Odoo 17+ syntax | Gunakan `group_operator=` |
| `<list>` tag di views | Odoo 17+ syntax | Gunakan `<tree>` |
| `@api.depends('partner_id')` lalu akses `partner_id.email` | N queries per record | Tambah `@api.depends('partner_id.email')` |
| `search()` inside loop | N+1 queries | `search()` dengan domain `IN` |
| `create()` in loop | N INSERT statements | Batch: `create([{...}, {...}])` |

## @api Decorator Decision Tree

```
Need to define field behavior?
├── Field computed from other fields → @api.depends
│   └── CAN use dotted paths: `@api.depends('partner_id.email')`
├── Validate data → @api.constrains
│   └── CANNOT use dotted paths: only simple field names
├── Prevent record deletion → @api.ondelete (Odoo 16)
└── Update form UI → @api.onchange
    └── NO CRUD operations allowed

Need to define method behavior?
├── Method-level, doesn't depend on self → @api.model
└── Normal record method → no decorator needed
```

## Common Patterns Reference

### N+1 Query Prevention

```python
# BAD: search in loop
for order in orders:
    payments = self.env['payment'].search([('order_id', '=', order.id)])

# GOOD: single query
payments = self.env['payment'].search_read([('order_id', 'in', orders.ids)])
```

### Tree View (Odoo 16)

```xml
<tree string="Records" editable="bottom">
    <field name="state" decoration-success="state == 'done'"/>
    <field name="phone"/>
</tree>
```

### Dynamic Visibility (Odoo 16)

```xml
<!-- Odoo 16: gunakan attrs -->
<field name="date_end" attrs="{'invisible': [('state', '!=', 'done')], 'required': [('state', '=', 'done')]}"/>

<!-- BUKAN ini (Odoo 17/18 syntax): -->
<!-- <field name="date_end" invisible="state != 'done'"/> -->
```

### Delete Validation (Odoo 16)

```python
# Bisa pakai @api.ondelete (tersedia sejak Odoo 15)
@api.ondelete(at_uninstall=False)
def _unlink_if_not_draft(self):
    if any(rec.state != 'draft' for rec in self):
        raise UserError("Cannot delete non-draft records")

# Atau override unlink() (masih valid di Odoo 16)
def unlink(self):
    if any(rec.state != 'draft' for rec in self):
        raise UserError("Cannot delete non-draft records")
    return super().unlink()
```

### SQL Queries (Odoo 16)

```python
# Odoo 16: gunakan parameterized query langsung
self.env.cr.execute(
    "SELECT id, name FROM res_partner WHERE company_id = %s",
    (company_id,)
)
rows = self.env.cr.fetchall()

# BUKAN ini (Odoo 17+ syntax):
# from odoo.tools import SQL
# self.env.cr.execute(SQL("SELECT ... WHERE id = %s", record_id))
```

## Module Structure

```
my_module/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── __init__.py
│   └── my_model.py
├── views/
│   └── my_model_views.xml
├── security/
│   ├── ir.model.access.csv
│   └── my_module_security.xml
├── data/
│   └── my_module_data.xml
├── migrations/
│   └── 16.0.1.0/
│       └── post-migrate_data.py
├── tests/
│   ├── __init__.py
│   └── test_my_model.py
├── wizard/
│   ├── __init__.py
│   └── my_wizard.py
├── controllers/
│   ├── __init__.py
│   └── my_controller.py
└── static/
    └── src/
        ├── js/
        │   └── my_component.js
        ├── xml/
        │   └── my_component.xml
        └── scss/
            └── my_component.scss
```

## Base Code Reference

The guides are based on Odoo 16 source code. Reference these files in your Odoo installation:
- `odoo/models.py` - ORM implementation
- `odoo/fields.py` - Field types
- `odoo/api.py` - Decorators
- `odoo/http.py` - HTTP layer
- `odoo/exceptions.py` - Exception types
