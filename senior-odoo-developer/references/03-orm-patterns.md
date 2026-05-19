---
name: odoo-orm-patterns
description: ORM patterns, CRUD, search, domain, read_group for all Odoo versions 14-19.
---

# ORM Patterns — All Versions

## Model Definition

```python
from odoo import models, fields, api
from odoo.exceptions import UserError, ValidationError

class MyModel(models.Model):
    _name = 'my.model'
    _description = 'My Model'          # Required — Odoo warns without this
    _order = 'date desc, name'
    _rec_name = 'name'

    name = fields.Char(required=True, index=True)
    active = fields.Boolean(default=True)
    state = fields.Selection([
        ('draft', 'Draft'),
        ('confirmed', 'Confirmed'),
        ('done', 'Done'),
        ('cancel', 'Cancelled'),
    ], default='draft', required=True, tracking=True)

    company_id = fields.Many2one('res.company', default=lambda self: self.env.company)
    user_id = fields.Many2one('res.users', default=lambda self: self.env.user)
    date = fields.Date(default=fields.Date.today)
    amount_total = fields.Float(digits='Product Price')
    currency_id = fields.Many2one('res.currency', related='company_id.currency_id')
    amount_currency = fields.Monetary(currency_field='currency_id')

    line_ids = fields.One2many('my.model.line', 'model_id', string='Lines')
    tag_ids = fields.Many2many('my.tag', string='Tags')

    # Computed field
    line_count = fields.Integer(compute='_compute_line_count', store=True)

    @api.depends('line_ids')
    def _compute_line_count(self):
        for rec in self:
            rec.line_count = len(rec.line_ids)
```

---

## CRUD Operations

### Create

```python
# Single create
record = self.env['my.model'].create({
    'name': 'Test',
    'state': 'draft',
})

# Batch create (v15+: @api.model_create_multi)
records = self.env['my.model'].create([
    {'name': 'A'},
    {'name': 'B'},
    {'name': 'C'},
])

# Override create — v15+ style
@api.model_create_multi
def create(self, vals_list):
    for vals in vals_list:
        if not vals.get('name'):
            vals['name'] = self.env['ir.sequence'].next_by_code('my.model')
    return super().create(vals_list)
```

### Read

```python
# Search + read (most common)
records = self.env['my.model'].search([('state', '=', 'draft')])

# search_read (more efficient than search() + read())
data = self.env['my.model'].search_read(
    domain=[('state', '=', 'draft')],
    fields=['name', 'state', 'amount_total'],
    limit=10,
    order='date desc',
)

# browse by ID
record = self.env['my.model'].browse(record_id)

# sudo to bypass ACL (use with a clear reason)
record = self.env['my.model'].sudo().browse(record_id)
```

### Write & Unlink

```python
# Batch write (1 SQL for all records)
records.write({'state': 'confirmed'})

# Override write
def write(self, vals):
    if 'state' in vals and vals['state'] == 'confirmed':
        vals['confirmed_date'] = fields.Datetime.now()
    return super().write(vals)

# Delete validation — v15+
@api.ondelete(at_uninstall=False)
def _unlink_if_draft(self):
    if any(rec.state != 'draft' for rec in self):
        raise UserError("Only Draft records can be deleted.")

# v14: override unlink
def unlink(self):
    if any(rec.state != 'draft' for rec in self):
        raise UserError("Only Draft records can be deleted.")
    return super().unlink()
```

---

## Search & Domain

```python
# Domain operators
domain = [
    ('state', '=', 'draft'),
    ('amount_total', '>', 1000),
    ('partner_id.country_id.code', '=', 'ID'),
]

# OR condition
domain = ['|', ('state', '=', 'draft'), ('state', '=', 'confirmed')]

# NOT condition
domain = [('state', '!=', 'cancel')]
domain = ['!', ('state', '=', 'cancel')]  # same

# IN / NOT IN
domain = [('state', 'in', ['draft', 'confirmed'])]
domain = [('id', 'in', record_ids)]

# LIKE patterns
domain = [('name', 'ilike', 'keyword')]   # case-insensitive
domain = [('name', 'like', 'keyword')]    # case-sensitive
domain = [('name', '=ilike', 'Test%')]   # starts with

# Date filters
from odoo.fields import Datetime
domain = [('date', '>=', Datetime.to_string(Datetime.now()))]

# search options
records = self.env['my.model'].search(
    domain,
    limit=80,
    offset=0,
    order='date desc, name asc',
    count=False,  # True to get only the count
)
count = self.env['my.model'].search_count(domain)
```

---

## read_group / Aggregation

```python
# All versions: read_group
result = self.env['my.model'].read_group(
    domain=[('state', '=', 'done')],
    fields=['partner_id', 'amount_total:sum'],
    groupby=['partner_id'],
)
# result: [{'partner_id': (1, 'Name'), 'amount_total': 1500.0, 'partner_id_count': 3}, ...]

# v17+: _read_group (more powerful, returns recordsets)
groups = self.env['my.model']._read_group(
    domain=[('state', '=', 'done')],
    groupby=['partner_id'],
    aggregates=['amount_total:sum', '__count'],
)
for partner, total, count in groups:
    print(partner.name, total, count)
```

---

## Environment & Context

```python
# Context manipulation
records_no_mail = self.with_context(mail_notrack=True).write({'state': 'done'})

# Useful contexts
self.with_context(lang='id_ID')           # force language
self.with_context(no_recompute=True)      # skip compute
self.with_context(tracking_disable=True)  # disable mail tracking

# Check environment
self.env.user        # current user
self.env.company     # current company
self.env.companies   # all enabled companies
self.env.lang        # current language code
self.env.context     # current context dict
self.env.uid         # current user ID

# sudo — with reason
self.sudo()          # superuser env
self.env['model'].with_user(specific_user)  # specific user
```

---

## Recordset Operations

```python
records = self.env['my.model'].search([])

# mapped — extract fields
names = records.mapped('name')           # list of strings
partners = records.mapped('partner_id')  # recordset

# filtered — filter recordset
drafts = records.filtered(lambda r: r.state == 'draft')
drafts = records.filtered('active')  # shorthand for boolean

# sorted
sorted_recs = records.sorted('date', reverse=True)
sorted_recs = records.sorted(lambda r: r.amount_total)

# Set operations
combined = rec1 | rec2    # union
common = rec1 & rec2      # intersection
diff = rec1 - rec2        # difference

# Exists check
if record.exists():
    # record was not deleted
    pass
```

---

## Sequence Numbers

```python
# Di model
name = fields.Char(default='New', copy=False)

@api.model_create_multi
def create(self, vals_list):
    for vals in vals_list:
        if vals.get('name', 'New') == 'New':
            vals['name'] = self.env['ir.sequence'].next_by_code('my.model.sequence')
    return super().create(vals_list)
```

```xml
<!-- data/sequences.xml -->
<record id="seq_my_model" model="ir.sequence">
    <field name="name">My Model Sequence</field>
    <field name="code">my.model.sequence</field>
    <field name="prefix">MYM/%(year)s/</field>
    <field name="padding">4</field>
</record>
```
