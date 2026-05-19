---
name: odoo-performance
description: Performance optimization patterns — N+1 prevention, SQL, batch operations, caching for all Odoo versions.
---

# Performance — All Versions

## #1 Killer: N+1 Queries Inside Loops

```python
# ❌ N+1: search() inside for loop
for order in orders:
    partner = self.env['res.partner'].search([('id', '=', order.partner_id.id)])
    # → N queries for N orders

# ✅ FIX: search once with IN domain
partner_ids = orders.mapped('partner_id.id')
partners = self.env['res.partner'].browse(partner_ids)

# ❌ N+1: write() per record
for rec in records:
    rec.write({'state': 'done'})  # N SQL UPDATE

# ✅ FIX: batch write
records.write({'state': 'done'})  # 1 SQL UPDATE

# ❌ N+1: create() inside loop
for vals in data_list:
    self.env['my.model'].create(vals)  # N SQL INSERT

# ✅ FIX: batch create
self.env['my.model'].create(data_list)  # 1 SQL INSERT (v15+)
```

---

## Computed Field Performance

```python
# ❌ search_count per record
@api.depends()  # empty or missing
def _compute_invoice_count(self):
    for rec in self:
        rec.invoice_count = self.env['account.invoice'].search_count(
            [('partner_id', '=', rec.id)]  # N queries
        )

# ✅ Aggregate once for all
@api.depends()
def _compute_invoice_count(self):
    domain = [('partner_id', 'in', self.ids)]
    grouped = self.env['account.move'].read_group(
        domain,
        fields=['partner_id'],
        groupby=['partner_id'],
    )
    count_map = {g['partner_id'][0]: g['partner_id_count'] for g in grouped}
    for rec in self:
        rec.invoice_count = count_map.get(rec.id, 0)
```

---

## search_read vs search + read

```python
# ❌ Two separate queries
records = self.env['sale.order'].search(domain)
data = records.read(['name', 'state', 'amount_total'])

# ✅ One query
data = self.env['sale.order'].search_read(
    domain=domain,
    fields=['name', 'state', 'amount_total'],
    limit=50,
)
```

---

## Raw SQL for Large Aggregations

```python
# Use raw SQL for:
# - Millions of rows
# - Complex GROUP BY
# - Cross-table aggregation without ORM
# - Reporting queries

# v14, v15, v16:
def get_sales_summary(self, date_from, date_to):
    self.env.cr.execute("""
        SELECT
            p.id AS partner_id,
            COUNT(so.id) AS order_count,
            SUM(so.amount_total) AS total_amount
        FROM sale_order so
        JOIN res_partner p ON p.id = so.partner_id
        WHERE so.date_order BETWEEN %s AND %s
            AND so.state IN ('sale', 'done')
        GROUP BY p.id
        ORDER BY total_amount DESC
    """, (date_from, date_to))
    return self.env.cr.dictfetchall()

# v17+: SQL() class is safer
from odoo.tools import SQL
def get_sales_summary(self, date_from, date_to):
    self.env.cr.execute(SQL("""
        SELECT p.id, COUNT(so.id), SUM(so.amount_total)
        FROM sale_order so
        JOIN res_partner p ON p.id = so.partner_id
        WHERE so.date_order BETWEEN %s AND %s
            AND so.state IN ('sale', 'done')
        GROUP BY p.id
    """, date_from, date_to))
    return self.env.cr.dictfetchall()
```

---

## Index Strategy

```python
# Add index=True on fields frequently searched
class MyModel(models.Model):
    _name = 'my.model'

    name = fields.Char(index=True)              # frequently searched
    partner_id = fields.Many2one(index=True)    # FK frequently joined
    state = fields.Selection(index=True)        # frequently filtered
    date = fields.Date(index=True)              # frequently sorted/filtered

    # Composite index via _sql_constraints or migration
    _sql_constraints = [
        ('unique_ref_company', 'UNIQUE(reference, company_id)',
         'Reference must be unique per company'),
    ]
```

---

## with_context to Disable Overhead

```python
# Disable mail tracking for bulk operations
records.with_context(tracking_disable=True).write({'state': 'done'})

# Disable recompute for batch import
records.with_context(no_recompute=True).write({'field': value})
self.env['my.model'].recompute()  # recompute manually afterwards

# Disable automatic chatter
records.with_context(mail_notrack=True).write({'partner_id': partner.id})
```

---

## Prefetch & Lazy Loading

```python
# Odoo automatically prefetches fields for a model on browse
records = self.env['my.model'].browse(ids)
# First access of records[0].name → prefetches all names at once

# Force specific prefetch
records._prefetch_ids  # set of IDs that will be prefetched

# Limit fields to load
records.read(['name', 'state'])  # only load 2 fields
```

---

## Caching

```python
# Cache ir.config_parameter
url = self.env['ir.config_parameter'].sudo().get_param('my_module.api_url')

# Cache with tools.cache (warning: cleared on upgrade)
from odoo.tools import ormcache

class MyModel(models.Model):
    _name = 'my.model'

    @ormcache('self.env.uid', 'record_id')
    def _get_cached_data(self, record_id):
        # data that rarely changes
        return self.browse(record_id).expensive_compute()

    def _clear_cache(self):
        self._get_cached_data.clear_cache(self)
```

---

## Performance Checklist

- [ ] No `search()` or `create()` inside for loops
- [ ] `search_read()` used instead of `search()` + `read()`
- [ ] Computed fields that are searched have `store=True`
- [ ] `mapped()` used to extract fields from recordsets (not list comprehension)
- [ ] `filtered()` used to filter recordsets (not Python list filter)
- [ ] Raw SQL only for aggregations that cannot be done efficiently via ORM
- [ ] Index on fields frequently searched/filtered
- [ ] `with_context(tracking_disable=True)` for bulk writes
- [ ] No f-strings in SQL queries
