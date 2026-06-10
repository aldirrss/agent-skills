# Decision Trees — Odoo 18

Extended decision guidance for common Odoo 18 development choices.

---

## ORM Method Selection

```
Need to fetch records?
├── Know the IDs → browse(ids) + .exists()
├── Need to filter → search(domain)
├── Need dicts (for JSON/API) → search_read(domain, fields)
├── Just need count → search_count(domain)
└── Need aggregation → _read_group(domain, groupby, aggregates)

⚠️ NEVER: search() then loop to read fields — use search_read()
⚠️ NEVER: browse(id) without .exists() — ghost records cause AttributeError
```

## Choosing Between _read_group vs search + loop

```python
# Need: count of orders per partner
# 🔴 SLOW: search + loop
for partner in partners:
    count = self.env['sale.order'].search_count([('partner_id', '=', partner.id)])
    partner.order_count = count

# ✅ FAST: _read_group (Odoo 18 new API)
groups = self.env['sale.order']._read_group(
    domain=[('partner_id', 'in', partners.ids)],
    groupby=['partner_id'],
    aggregates=['__count']
)
count_map = {partner.id: count for partner, count in groups}
for partner in partners:
    partner.order_count = count_map.get(partner.id, 0)
```

## Choosing write() scope

```python
# Single field, multiple records → batch write on recordset
records.write({'state': 'done'})  # 1 SQL UPDATE

# Different values per record → loop with individual write
for rec in records:
    rec.write({'name': compute_name(rec)})  # N SQL UPDATEs (unavoidable)

# Better pattern for different values:
for vals in values_list:
    self.browse(vals['id']).write(vals)
```

---

## Field Parameter Decisions

### index=True — When?

```
Add index=True when field is:
├── Used in search() domains frequently → YES
├── Used in Many2one → YES (Odoo does this automatically)
├── Used in ORDER BY frequently → YES
├── Foreign key target → YES (auto-indexed in most cases)
├── Rarely searched, low cardinality (boolean) → NO
└── Only displayed, never filtered → NO

⚠️ Each index slows down INSERT/UPDATE — don't index everything
```

### copy=False — When?

```
Fields that should NOT be copied when record is duplicated:
- Reference numbers (name='/', sequence-based)
- State fields (reset to draft on copy)
- One2many with unique constraints
- Attachment links
- External system IDs

Fields that SHOULD be copied (default):
- Configuration fields
- Most descriptive fields
- Template-like content
```

### required=True vs @api.constrains

```
required=True:
- Enforced at ORM level (can't create without it)
- Shows asterisk in form view
- Use for fields that are ALWAYS mandatory

@api.constrains:
- More flexible validation logic
- Can depend on other fields ("required if state=done")
- Can give clearer error messages
- Use for conditional requirements
```

---

## Inheritance Strategy

```
Want to extend an existing Odoo model?
├── Add fields / override methods → _inherit = 'base.model'
├── Create a new model based on another → _inherit = [...], _name = 'new.model'
├── Extend view only → inherit_id in XML view
└── Override method:
    def method(self):
        result = super().method()  # ALWAYS call super()
        # Add your logic
        return result

⚠️ NEVER: Copy-paste core model code into your module
⚠️ NEVER: Override without calling super() (unless you're 100% sure)
```

---

## When to Use AbstractModel

```python
# Use models.AbstractModel when:
# - Building a mixin (reusable behavior, not a standalone model)
# - No database table needed
# - Shared methods across multiple models

class MyMixin(models.AbstractModel):
    _name = 'my.mixin'

    def shared_method(self):
        ...

class MyModel(models.Model):
    _name = 'my.model'
    _inherit = ['my.mixin']
```

---

## Transaction Error Recovery

```
Got "InFailedSqlTransaction" or transaction aborted error?
├── You're doing something after a failed DB operation
├── MUST rollback or use savepoint before retrying
│
Pattern for try-retry operations:
│
try:
    with self.env.cr.savepoint():
        self.create({...})
except UniqueViolation:
    # Savepoint auto-rolled back, transaction still alive
    existing = self.search([...])
    existing.write({...})
│
⚠️ NEVER try/except without savepoint — you'll get InFailedSqlTransaction
```

---

## OWL Component vs Field Widget

```
Building frontend UI for Odoo?
├── Custom display in a form field → Field Widget (extend AbstractField)
├── Standalone interactive component → OWL Component
├── New action/screen → Client Action + OWL Component
├── Modify existing view layout → View inheritance (XML xpath)
└── Add a button with custom behavior → Override existing button via XML inheritance

Key OWL service choices:
├── HTTP calls to backend → useService('rpc')
├── Show popup dialog → useService('dialog')
├── Show toast notification → useService('notification')
├── Navigate to action → useService('action')
└── Read URL params → useService('router')
```

---

## Manifest Data File Order

Security must come first. Views depend on security. Always:

```python
'data': [
    # 1. Groups (defines group_ XML IDs)
    'security/my_module_security.xml',
    # 2. ACL (references model_ XML IDs from Odoo internals)
    'security/ir.model.access.csv',
    # 3. Data (may reference groups)
    'data/my_module_data.xml',
    # 4. Views (may reference groups for visibility)
    'views/my_model_views.xml',
    # 5. Reports (depends on views)
    'report/my_report_views.xml',
    # 6. Wizards (depends on models + views)
    'wizard/my_wizard_views.xml',
    # 7. Menus (depends on actions in views)
    'views/menus.xml',
],
```
