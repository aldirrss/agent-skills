# Code Quality — Odoo 18

Standards, naming conventions, anti-patterns, and review checklist.

---

## Naming Conventions

### Models

```python
# _name: lowercase, dots as separator, plural
_name = 'sale.order'          # ✅
_name = 'SaleOrder'           # ❌
_name = 'sale_order'          # ❌
_name = 'sale.orders'         # ❌ (no plural)

# _description: human readable, title case
_description = 'Sale Order'   # ✅
_description = 'sale_order'   # ❌
# Missing _description → Odoo 18 warning in logs
```

### Fields

```python
# Boolean: is_*, has_*, can_*, active
is_company = fields.Boolean()
has_warranty = fields.Boolean()
active = fields.Boolean()      # Special: controls archive

# Many2one: singular noun + _id suffix
partner_id = fields.Many2one('res.partner')
user_id = fields.Many2one('res.users')

# One2many: plural noun + _ids suffix
line_ids = fields.One2many('sale.order.line', 'order_id')
tag_ids = fields.Many2many('res.partner.category')

# Computed: _compute_ prefix
amount_total = fields.Float(compute='_compute_amount_total')

# Onchange: _onchange_ prefix
@api.onchange('partner_id')
def _onchange_partner_id(self): ...

# Constrains: _check_ prefix
@api.constrains('date_start', 'date_end')
def _check_dates(self): ...

# Ondelete: _unlink_ prefix
@api.ondelete(at_uninstall=False)
def _unlink_if_confirmed(self): ...
```

### Methods

```python
# Public actions (button clicks): action_ prefix
def action_submit(self): ...
def action_approve(self): ...
def action_cancel(self): ...

# Private helpers: _ prefix
def _prepare_vals(self): ...
def _validate_data(self): ...
def _get_default_partner(self): ...

# Avoid generic names:
# ❌ def process(self)
# ❌ def handle(self)
# ✅ def action_validate_and_send(self)
```

### XML IDs

```python
# Pattern: {type}_{model_snake}_{description}
# Views
view_my_model_form          # form view
view_my_model_list          # list view (NOT tree in Odoo 18)
view_my_model_kanban        # kanban view
view_my_model_search        # search view

# Actions
action_my_model             # window action
action_my_model_from_wizard # context-specific action

# Menus
menu_my_module_root         # top-level menu
menu_my_module_my_model     # submenu

# Rules
rule_my_model_company       # record rule
rule_my_model_personal      # personal record rule

# Groups
group_my_module_user        # user group
group_my_module_manager     # manager group

# Reports
report_my_model_pdf         # PDF report action
report_my_model_document    # QWeb template
```

---

## Method Structure Standards

```python
def action_submit(self):
    """Submit documents for approval.

    Validates that required fields are filled, then transitions
    state from 'draft' to 'submitted'.

    Raises:
        UserError: If required fields are missing.
        UserError: If document is not in draft state.
    """
    # 1. Input validation first
    if any(r.state != 'draft' for r in self):
        raise UserError("Only draft documents can be submitted.")

    # 2. Business validation
    self._validate_for_submit()

    # 3. State change
    self.write({'state': 'submitted', 'date_submitted': fields.Datetime.now()})

    # 4. Side effects (notifications, triggers)
    self._notify_approvers()

    # 5. Return value (for button actions, usually None or action dict)
    return True
```

---

## Anti-Patterns to Avoid

### God Model

```python
# ❌ BAD: One model doing everything
class MyModule(models.Model):
    _name = 'my.module'
    # 50+ fields
    # 30+ methods
    # Handles orders, payments, shipping, notifications...

# ✅ GOOD: Split by responsibility
class MyOrder(models.Model): ...       # Order lifecycle
class MyOrderLine(models.Model): ...   # Line items
class MyShipment(models.Model): ...    # Shipping logic
```

### Nested Sudo

```python
# ❌ BAD: sudo() inside sudo() — confusing and dangerous
def my_method(self):
    sudo_self = self.sudo()
    result = sudo_self.env['other.model'].sudo().search([])  # redundant

# ✅ Use sudo() once, at the right level
def my_method(self):
    result = self.env['other.model'].sudo().search([])
```

### Context Pollution

```python
# ❌ BAD: Adding context everywhere as a workaround
self.with_context(
    no_recompute=True,
    skip_validation=True,
    ignore_locks=True,
    bypass_all_rules=True
).write(vals)

# ✅ Fix the underlying issue — recompute, validation, locking should work
```

### Silent Exception Swallowing

```python
# ❌ BAD: Swallowing exceptions without logging
try:
    self.action_submit()
except Exception:
    pass  # Why? What failed?

# ✅ Log or re-raise
try:
    self.action_submit()
except UserError as e:
    _logger.warning("Submit failed for %s: %s", self.name, e)
    # Handle gracefully
except Exception as e:
    _logger.error("Unexpected error: %s", e, exc_info=True)
    raise
```

### Magic Numbers / Strings

```python
# ❌ BAD: Magic values scattered in code
if rec.state == '3':  # What is state 3?
    ...
if rec.type_id.id == 42:  # What is record 42?
    ...

# ✅ Named constants or proper field references
if rec.state == 'approved':
    ...
if rec.type_id == self.env.ref('my_module.type_standard'):
    ...
```

---

## Pre-Commit Review Checklist

### Python

- [ ] `_name` is defined (or `_inherit` for extensions)
- [ ] `_description` is defined (Odoo 18 warns without it)
- [ ] All fields have `string=` parameter
- [ ] `@api.model_create_multi` on `create()` override
- [ ] `super()` called in all overrides
- [ ] No `search()`/`create()`/`write()` inside `for` loops
- [ ] No `@api.onchange` doing CRUD
- [ ] No `@api.constrains` with dotted paths
- [ ] `@api.ondelete(at_uninstall=False)` instead of `unlink()` override
- [ ] `store=True` on computed fields used in domains/reports
- [ ] All `@api.depends` include every dependency
- [ ] No raw f-string SQL
- [ ] No `eval()` on user input — use `safe_eval`
- [ ] `sudo()` usage has a comment explaining why

### Security

- [ ] Every new model has an entry in `ir.model.access.csv`
- [ ] `ir.model.access.csv` listed after security XML in manifest
- [ ] Record rules use `company_ids` for multi-company models
- [ ] Webhooks validate signatures before processing
- [ ] Public controllers use `auth='public'` not `auth='none'`

### XML/Views

- [ ] `noupdate="1"` on all user-editable default data
- [ ] Security files listed FIRST in manifest `data:`
- [ ] `view_mode` uses `list` not `tree` (Odoo 18)
- [ ] All `ref()` targets actually exist in the system
- [ ] XPath in view inheritance tested — no silent mismatches

### OWL/JavaScript

- [ ] Components registered in correct registry category
- [ ] `static props = {...}` declared for all components
- [ ] `useService('rpc')` used (not deprecated `this.rpc`)
- [ ] No direct DOM manipulation
- [ ] Assets declared in `__manifest__.py` under correct bundle

### Tests

- [ ] At least one test per new public method
- [ ] `setUpClass` used for expensive fixtures
- [ ] Tests are isolated (no cross-test dependencies)
- [ ] Tests use `@tagged('my_module')` for filtering

---

## Performance Quick Wins

When reviewing code for performance, look for these in order of impact:

1. **N+1 queries** — `search()` inside loops → biggest impact
2. **Missing `store=True`** on searched computed fields → full table scans
3. **`search()` + `read()`** instead of `search_read()` → extra roundtrip
4. **`write()` per record** instead of batch → N SQL updates
5. **Missing `@api.depends`** → unnecessary recomputation
6. **Binary fields in `read()`** without `bin_size=True` → huge memory usage
7. **`mapped('field')` on huge recordsets** without prefetch → memory issue

```python
# Binary field read optimization
# ❌ Loads actual binary content into memory
records.read(['image_1920'])

# ✅ Returns file size instead of content
records.with_context(bin_size=True).read(['image_1920'])
```
