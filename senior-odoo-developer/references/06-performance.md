---
name: odoo-performance
description: Performance optimization patterns — N+1 prevention, SQL, batch operations, caching untuk semua versi Odoo.
---

# Performance — All Versions

## #1 Killer: N+1 Queries di Loop

```python
# ❌ N+1: search() dalam for loop
for order in orders:
    partner = self.env['res.partner'].search([('id', '=', order.partner_id.id)])
    # → N query untuk N orders

# ✅ FIX: search sekali dengan IN domain
partner_ids = orders.mapped('partner_id.id')
partners = self.env['res.partner'].browse(partner_ids)

# ❌ N+1: write() per record
for rec in records:
    rec.write({'state': 'done'})  # N SQL UPDATE

# ✅ FIX: batch write
records.write({'state': 'done'})  # 1 SQL UPDATE

# ❌ N+1: create() dalam loop
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

# ✅ Agregasi sekali untuk semua
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
# ❌ Dua query terpisah
records = self.env['sale.order'].search(domain)
data = records.read(['name', 'state', 'amount_total'])

# ✅ Satu query
data = self.env['sale.order'].search_read(
    domain=domain,
    fields=['name', 'state', 'amount_total'],
    limit=50,
)
```

---

## Raw SQL untuk Agregasi Besar

```python
# Gunakan raw SQL untuk:
# - Jutaan baris
# - Complex GROUP BY
# - Cross-table aggregation tanpa ORM
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

# v17+: SQL() class lebih aman
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
# Tambahkan index=True pada field yang sering di-search
class MyModel(models.Model):
    _name = 'my.model'

    name = fields.Char(index=True)              # sering di-search
    partner_id = fields.Many2one(index=True)    # FK yang sering di-join
    state = fields.Selection(index=True)        # sering di-filter
    date = fields.Date(index=True)              # sering di-sort/filter

    # Composite index via _sql_constraints atau migration
    _sql_constraints = [
        ('unique_ref_company', 'UNIQUE(reference, company_id)',
         'Reference must be unique per company'),
    ]
```

---

## with_context untuk Disable Overhead

```python
# Disable mail tracking untuk bulk operations
records.with_context(tracking_disable=True).write({'state': 'done'})

# Disable recompute untuk batch import
records.with_context(no_recompute=True).write({'field': value})
self.env['my.model'].recompute()  # recompute manual setelahnya

# Disable automatic chatter
records.with_context(mail_notrack=True).write({'partner_id': partner.id})
```

---

## Prefetch & Lazy Loading

```python
# Odoo otomatis prefetch field satu model saat browse
records = self.env['my.model'].browse(ids)
# Akses pertama records[0].name → prefetch semua name sekaligus

# Force prefetch spesifik
records._prefetch_ids  # set of IDs yang akan di-prefetch

# Batasi field yang di-load
records.read(['name', 'state'])  # hanya load 2 field
```

---

## Caching

```python
# Cache ir.config_parameter
url = self.env['ir.config_parameter'].sudo().get_param('my_module.api_url')

# Cache dengan tools.cache (hati-hati: clear saat upgrade)
from odoo.tools import ormcache

class MyModel(models.Model):
    _name = 'my.model'

    @ormcache('self.env.uid', 'record_id')
    def _get_cached_data(self, record_id):
        # data yang jarang berubah
        return self.browse(record_id).expensive_compute()

    def _clear_cache(self):
        self._get_cached_data.clear_cache(self)
```

---

## Performance Checklist

- [ ] Tidak ada `search()` atau `create()` di dalam for loop
- [ ] `search_read()` dipakai alih-alih `search()` + `read()`
- [ ] Computed fields yang di-search punya `store=True`
- [ ] `mapped()` untuk ekstrak field dari recordset (bukan list comprehension)
- [ ] `filtered()` untuk filter recordset (bukan Python list filter)
- [ ] Raw SQL hanya untuk agregasi yang tidak bisa efisien via ORM
- [ ] Index pada field yang sering di-search/filter
- [ ] `with_context(tracking_disable=True)` untuk bulk write
- [ ] Tidak ada f-string di SQL query
