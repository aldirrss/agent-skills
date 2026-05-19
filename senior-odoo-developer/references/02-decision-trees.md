---
name: odoo-decision-trees
description: Decision trees for choosing decorators, field types, auth, SQL vs ORM, and architectural choices across all Odoo versions.
---

# Decision Trees — All Versions

## Computed Field vs Onchange

```
Need to update a field value?
├── Must be correct in DB (not just UI) → @api.depends (computed field)
│   ├── Needs to be searched/filtered → store=True + search=...
│   ├── Needs to be edited by user → add inverse=...
│   └── Context-dependent → add @api.depends_context
└── UI feedback only, no DB write needed → @api.onchange
    ⚠️  onchange CANNOT do CRUD — no create/write/unlink
    ⚠️  onchange return value is only for domain/warning, not persistence
```

## store=True vs store=False

```
Computed field — should it be stored?
├── Searched in domain filters? → store=True (REQUIRED)
├── Used in reports or exports? → store=True (much faster)
├── Changes rarely, many records? → store=True
├── Changes constantly (e.g., "now") → store=False
└── Only shown in form, never queried → store=False is fine
```

## @api.constrains vs Override write/create

```
Need to validate data?
├── Constraint on specific fields → @api.constrains (preferred)
│   ⚠️  NO dotted paths! Only direct fields.
│   ⚠️  Only triggers if that field is in the vals being written.
└── Validate regardless of which fields change → override write()
    └── Call super() FIRST, then validate
```

## @api.ondelete vs Override unlink()

```
Need to prevent deletion?
├── v15+ → @api.ondelete(at_uninstall=False)  ← RECOMMENDED
│   └── Does not break module uninstall process
└── v14 or complex logic needed → override unlink()
    └── if any(rec.state != 'draft' for rec in self): raise UserError(...)
    └── return super().unlink()
```

## sudo() — When to Use

```
Need elevated access?
├── In a controller (public endpoint) → sudo() OK, but comment the reason
├── In a model method → AVOID — fix the ACL instead
├── For counting/checking related records → sudo() OK
├── For sending emails/notifications → sudo() OK (technical operation)
└── "Just to make it work" → NEVER — fix the access rights
```

## auth Type in Controllers

```
HTTP endpoint — who can access it?
├── Only logged-in users → auth='user' (default, safe)
├── Public website page → auth='public'
│   └── Use sudo() ONLY for what is needed
├── Webhook from external system → auth='none', csrf=False
│   └── MUST validate signature/token manually
└── Internal utility → auth='none'
```

## Field Type Selection

```
What data are you storing?
├── Short text (name, code) → Char
├── Long text (notes) → Text
├── Formatted HTML → Html (auto-sanitized)
├── True/False → Boolean
├── Whole number → Integer
├── Decimal → Float
│   └── Money → Monetary (+ currency_id field)
├── Date only → Date
├── Date + time → Datetime
├── Small file/image → Binary
│   └── Large file → Binary(attachment=True)
├── Fixed options → Selection
├── Link to one record → Many2one (+ ondelete='restrict'/'cascade'/'set null')
├── Child records → One2many (+ inverse_name required)
├── Multiple links → Many2many
└── v17+: Semi-structured data → Json / Properties
```

## ORM vs Raw SQL

```
Need to query the database?
├── Standard CRUD → ORM (search, create, write, unlink)
├── Simple aggregation → read_group() / _read_group() v17+
├── Complex aggregation / millions of rows → Raw SQL
│   ├── v14-v16 → cr.execute("...", (param,))
│   └── v17+ → SQL() class or cr.execute()
├── Cross-model aggregation → Raw SQL
└── Complex GROUP BY reports → Raw SQL
    ⚠️  NEVER use f-string SQL! Always parameterized.
```

## Many2one ondelete Strategy

```
Many2one field — what happens when parent is deleted?
├── Delete child too (cascade) → ondelete='cascade'
│   ⚠️  Warning: can silently delete important data
├── Reject parent deletion → ondelete='restrict' (DEFAULT, safe)
└── Set field to null → ondelete='set null' (+ required=False)
```

## Mixin Selection

```
Need a feature?
├── Chatter / change tracking → _inherit = ['mail.thread', 'mail.activity.mixin']
├── Tracking only, no chatter → _inherit = 'mail.thread' only
├── Automatic sequence numbers → _inherit = 'ir.sequence'
│   └── Or use ir.sequence in data XML
├── Portal access → _inherit = 'portal.mixin'
└── Rating → _inherit = 'rating.mixin'
```

## When to Create New Module vs Inherit

```
New feature — new module or extend existing?
├── Independent feature that can be toggled ON/OFF → new module
├── Small extension to existing module → inherit in existing or glue module
├── Integration of two modules → new glue module that depends on both
└── Modify Odoo core → NEVER — only inherit and override
    ⚠️  Never edit files in Odoo's addons/ directory directly
```
