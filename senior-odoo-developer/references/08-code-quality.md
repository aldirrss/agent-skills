---
name: odoo-code-quality
description: Code review checklist, naming conventions, and anti-patterns for all Odoo versions.
---

# Code Quality Checklist — All Versions

## Pre-Submit Checklist

### Models
- [ ] `_name` defined (or `_inherit` for extension)
- [ ] `_description` defined — Odoo warns if missing
- [ ] `create()` uses `@api.model_create_multi` (v15+), not `@api.model`
- [ ] No `search()`, `create()`, or `write()` inside for loops
- [ ] All `@api.depends` list **every** dependency (missing = stale values)
- [ ] `@api.onchange` does NOT call create/write/unlink
- [ ] Deletion guard uses `@api.ondelete(at_uninstall=False)` (v15+) or override `unlink()`
- [ ] Computed fields that are searched have `store=True`
- [ ] Loop in every compute method (`for rec in self:`)

### Security
- [ ] `ir.model.access.csv` exists for every new model
- [ ] `sudo()` usage has a comment explaining why
- [ ] No raw f-string SQL
- [ ] Webhooks validate signatures

### Performance
- [ ] `search_read()` instead of `search()` + `read()`
- [ ] `mapped()` to extract single fields from recordsets
- [ ] `filtered()` to filter recordsets
- [ ] No queries inside loops

### XML/Views
- [ ] `noupdate="1"` on user-editable data
- [ ] Security files FIRST in manifest `data:`
- [ ] View tag matches version (`<tree>` v14-16, `<list>` v18+)
- [ ] Dynamic attrs match version

### OWL/JS (v15+)
- [ ] `useService('rpc')` not deprecated `this.rpc` (v16+)
- [ ] Component registered in correct registry
- [ ] Props validated with `static props = {...}`
- [ ] No memory leaks (cleanup in onWillUnmount)

---

## Naming Conventions

```python
# Model names: lowercase with dot notation
_name = 'my.module.my.model'      # ✅
_name = 'MyModule.MyModel'         # ❌

# Field names: snake_case
partner_id = fields.Many2one(...)  # ✅
PartnerId = fields.Many2one(...)   # ❌

# Method names: snake_case, prefix _compute_, _onchange_, _check_
def _compute_total(self): ...      # computed field
def _onchange_partner(self): ...   # onchange
def _check_state(self): ...        # constrains
def action_confirm(self): ...      # user-triggered action
def _prepare_vals(self): ...       # private helper

# XML IDs: snake_case, prefixed with module name
id="my_module.action_my_model"
id="my_module.view_my_model_form"
id="my_module.menu_my_module"

# File names: snake_case
my_model.py
my_model_views.xml
my_module_security.xml
```

---

## Anti-Patterns

```python
# ❌ search() inside loop
for order in orders:
    partner = self.env['res.partner'].search([('id', '=', order.partner_id.id)])

# ❌ @api.model on create (v15+)
@api.model
def create(self, vals):
    return super().create(vals)

# ✅ @api.model_create_multi
@api.model_create_multi
def create(self, vals_list):
    return super().create(vals_list)

# ❌ Missing loop in compute
@api.depends('amount')
def _compute_tax(self):
    self.tax = self.amount * 0.1  # only updates self[0]!

# ✅ With loop
@api.depends('amount')
def _compute_tax(self):
    for rec in self:
        rec.tax = rec.amount * 0.1

# ❌ CRUD in onchange
@api.onchange('partner_id')
def _onchange_partner(self):
    self.env['log'].create({'msg': 'changed'})  # DON'T

# ❌ eval() on user input
domain = eval(user_input)  # RCE vulnerability

# ❌ f-string SQL
self.env.cr.execute(f"SELECT * FROM table WHERE id = {user_id}")  # SQL injection

# ❌ Dotted path in @api.constrains
@api.constrains('partner_id.country_id')  # invalid

# ❌ Forgetting super() in override
def write(self, vals):
    # do stuff
    return True  # should be return super().write(vals)

# ❌ Hardcode user/company ID
if self.env.uid == 1:  # admin
    pass
# ✅
if self.env.user.has_group('base.group_system'):
    pass
```

---

## Code Organization

```python
class MyModel(models.Model):
    _name = 'my.model'
    _description = 'My Model'
    _order = 'date desc, name'

    # 1. Fields (in order: basic → relational → computed)
    name = fields.Char(required=True)
    state = fields.Selection([...], default='draft')
    date = fields.Date(default=fields.Date.today)
    partner_id = fields.Many2one('res.partner')
    line_ids = fields.One2many('my.model.line', 'model_id')
    amount_total = fields.Float(compute='_compute_total', store=True)

    # 2. SQL constraints
    _sql_constraints = [...]

    # 3. Compute methods
    @api.depends('line_ids.price_total')
    def _compute_total(self):
        ...

    # 4. Onchange
    @api.onchange('partner_id')
    def _onchange_partner(self):
        ...

    # 5. Constrains
    @api.constrains('date')
    def _check_date(self):
        ...

    # 6. CRUD overrides
    @api.model_create_multi
    def create(self, vals_list):
        ...

    def write(self, vals):
        ...

    @api.ondelete(at_uninstall=False)
    def _unlink_check(self):
        ...

    # 7. Action methods (called from views)
    def action_confirm(self):
        ...

    def action_cancel(self):
        ...

    # 8. Private helpers (prefix _)
    def _prepare_mail_values(self):
        ...

    def _get_report_values(self, docids, data=None):
        ...
```

---

## OCA Standards (if publishing to OCA)

- README.rst is required
- Tests coverage > 80%
- No `print()` statements
- All strings translatable with `_()`
- License header in every `.py` file: `# License LGPL-3.0 or later`
- `pre-commit` hooks: flake8, isort, prettier, eslint
