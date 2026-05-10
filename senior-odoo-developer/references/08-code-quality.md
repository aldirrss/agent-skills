---
name: odoo-code-quality
description: Code review checklist, naming conventions, dan anti-patterns untuk semua versi Odoo.
---

# Code Quality Checklist — All Versions

## Pre-Submit Checklist

### Models
- [ ] `_name` didefinisikan (atau `_inherit` untuk extension)
- [ ] `_description` didefinisikan — Odoo warn jika tidak ada
- [ ] `create()` menggunakan `@api.model_create_multi` (v15+), bukan `@api.model`
- [ ] Tidak ada `search()`, `create()`, atau `write()` di dalam for loop
- [ ] Semua `@api.depends` mencantumkan **semua** dependency (missing = stale values)
- [ ] `@api.onchange` TIDAK memanggil create/write/unlink
- [ ] Deletion guard pakai `@api.ondelete(at_uninstall=False)` (v15+) atau override `unlink()`
- [ ] Computed field yang di-search punya `store=True`
- [ ] Loop di setiap compute method (`for rec in self:`)

### Security
- [ ] `ir.model.access.csv` ada untuk setiap model baru
- [ ] `sudo()` ada comment alasannya
- [ ] Tidak ada raw f-string SQL
- [ ] Webhook memvalidasi signature

### Performance
- [ ] `search_read()` alih-alih `search()` + `read()`
- [ ] `mapped()` untuk ekstrak single field dari recordset
- [ ] `filtered()` untuk filter recordset
- [ ] Tidak ada query di loop

### XML/Views
- [ ] `noupdate="1"` pada data yang bisa diedit user
- [ ] Security files PERTAMA di manifest `data:`
- [ ] View tag sesuai versi (`<tree>` v14-16, `<list>` v18+)
- [ ] Dynamic attrs sesuai versi

### OWL/JS (v15+)
- [ ] `useService('rpc')` bukan deprecated `this.rpc` (v16+)
- [ ] Component diregister di registry yang benar
- [ ] Props divalidasi dengan `static props = {...}`
- [ ] Tidak ada memory leak (cleanup di onWillUnmount)

---

## Naming Conventions

```python
# Model names: lowercase dengan dot notation
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

# XML IDs: snake_case, prefixed dengan module name
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
# ❌ search() dalam loop
for order in orders:
    partner = self.env['res.partner'].search([('id', '=', order.partner_id.id)])

# ❌ @api.model pada create (v15+)
@api.model
def create(self, vals):
    return super().create(vals)

# ✅ @api.model_create_multi
@api.model_create_multi
def create(self, vals_list):
    return super().create(vals_list)

# ❌ Missing loop di compute
@api.depends('amount')
def _compute_tax(self):
    self.tax = self.amount * 0.1  # hanya update self[0]!

# ✅ Dengan loop
@api.depends('amount')
def _compute_tax(self):
    for rec in self:
        rec.tax = rec.amount * 0.1

# ❌ CRUD dalam onchange
@api.onchange('partner_id')
def _onchange_partner(self):
    self.env['log'].create({'msg': 'changed'})  # JANGAN

# ❌ eval() pada user input
domain = eval(user_input)  # RCE vulnerability

# ❌ f-string SQL
self.env.cr.execute(f"SELECT * FROM table WHERE id = {user_id}")  # SQL injection

# ❌ Dotted path di @api.constrains
@api.constrains('partner_id.country_id')  # tidak valid

# ❌ Lupa super() di override
def write(self, vals):
    # do stuff
    return True  # seharusnya return super().write(vals)

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

    # 1. Fields (dalam urutan: basic → relational → computed)
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

    # 7. Action methods (dipanggil dari views)
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

## OCA Standards (jika publish ke OCA)

- README.rst wajib ada
- Tests coverage > 80%
- Tidak ada `print()` statement
- Semua string translatable pakai `_()`
- License header di setiap `.py` file: `# License LGPL-3.0 or later`
- `pre-commit` hooks: flake8, isort, prettier, eslint
