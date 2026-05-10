---
name: odoo-pitfalls
description: Anti-patterns dan jebakan umum per versi Odoo — dengan fix yang benar.
---

# Pitfalls & Anti-Patterns — All Versions

## Universal Pitfalls (Semua Versi)

### N+1 Query
```python
# ❌ Search dalam loop
for order in orders:
    payments = self.env['account.payment'].search([('ref', '=', order.name)])

# ✅ Single query
all_payments = self.env['account.payment'].search(
    [('ref', 'in', orders.mapped('name'))]
)
payment_map = {p.ref: p for p in all_payments}
```

### Write dalam Loop
```python
# ❌ N SQL UPDATE
for rec in records:
    rec.write({'state': 'done'})

# ✅ 1 SQL UPDATE
records.write({'state': 'done'})
```

### Missing Loop di Compute
```python
# ❌ Hanya update self[0], record lain tidak di-update
@api.depends('amount')
def _compute_tax(self):
    self.tax = self.amount * 0.1

# ✅
@api.depends('amount')
def _compute_tax(self):
    for rec in self:
        rec.tax = rec.amount * 0.1
```

### sudo() Tanpa Alasan
```python
# ❌ sudo() karena malas fix ACL
def get_partner_data(self):
    return self.env['res.partner'].sudo().search([])  # expose semua!

# ✅ Fix ACL yang benar, atau sudo minimal + dokumentasi
def get_partner_data(self):
    # sudo needed: partner readable by all employees for display purpose
    return self.env['res.partner'].sudo().search([('customer_rank', '>', 0)])
```

### CRUD di Onchange
```python
# ❌ DILARANG KERAS
@api.onchange('partner_id')
def _onchange_partner(self):
    self.env['audit.log'].create({'action': 'partner_changed'})  # NO!

# ✅ Onchange hanya update field UI
@api.onchange('partner_id')
def _onchange_partner(self):
    if self.partner_id:
        self.payment_term_id = self.partner_id.property_payment_term_id
```

### Dotted Path di @api.constrains
```python
# ❌ Tidak valid — tidak akan trigger saat partner berubah
@api.constrains('partner_id.country_id')
def _check_country(self): ...

# ✅ Hanya direct fields
@api.constrains('partner_id')
def _check_country(self):
    for rec in self:
        if rec.partner_id.country_id.code != 'ID':
            raise ValidationError("Indonesia only")
```

### SQL Injection
```python
# ❌ CRITICAL SECURITY BUG
name = request.params.get('name')
self.env.cr.execute(f"SELECT id FROM table WHERE name = '{name}'")

# ✅
self.env.cr.execute("SELECT id FROM table WHERE name = %s", (name,))
```

---

## Version-Specific Pitfalls

### v14 Only
```python
# ❌ @api.multi sudah deprecated di v14
@api.multi
def action_do(self):
    for rec in self:
        pass

# ✅ Tanpa decorator (recordset method)
def action_do(self):
    for rec in self:
        pass
```

### v15 Pitfalls
```python
# ❌ Masih pakai OWL 1.x syntax
const { useState } = owl.hooks;

# ✅ Module system v15
/** @odoo-module **/
import { useState } from "@odoo/owl";

# ❌ @api.model untuk create
@api.model
def create(self, vals):
    return super().create(vals)

# ✅
@api.model_create_multi
def create(self, vals_list):
    return super().create(vals_list)
```

### v16 Pitfalls
```python
# ❌ this.rpc deprecated di v16
async _loadData() {
    await this.rpc({model: 'my.model', method: 'get_data', args: []});
}

# ✅ useService('rpc') atau orm
setup() {
    this.orm = useService("orm");
}
async _loadData() {
    await this.orm.call("my.model", "get_data", []);
}
```

### v17 Pitfalls
```python
# ❌ Masih pakai <tree> tanpa cek versi
# Odoo 17 sedang transisi — lebih baik pakai <list> jika targetnya v17+

# ❌ Masih pakai group_operator= (deprecated mulai v17)
amount = fields.Float(group_operator='sum')

# ✅ v17+
amount = fields.Float(aggregator='sum')
```

### v18 Pitfalls
```python
# ❌ Masih pakai <tree> tag di v18
# <tree string="Records">  ← harus <list> di v18

# ❌ Masih pakai attrs= di v18 (deprecated)
# <field name="x" attrs="{'invisible': [...]}"/>
# ✅
# <field name="x" invisible="state == 'done'"/>

# ❌ group_operator= di v18
amount = fields.Float(group_operator='sum')
# ✅
amount = fields.Float(aggregator='sum')

# ❌ <div class="oe_chatter"> di v18
# <div class="oe_chatter">...</div>
# ✅
# <chatter/>
```

---

## Transaction Pitfalls

### Handle UniqueViolation Tanpa Savepoint
```python
# ❌ Transaction rusak setelah UniqueViolation tanpa savepoint
try:
    self.create({'reference': ref})
except Exception:
    # Transaction sudah "aborted" — query apapun akan gagal!
    existing = self.search([('reference', '=', ref)])  # ERROR: InFailedSqlTransaction

# ✅ Gunakan savepoint
try:
    with self.env.cr.savepoint():
        self.create({'reference': ref})
except Exception:
    # savepoint di-rollback, transaction utama masih oke
    existing = self.search([('reference', '=', ref)])  # ✅ jalan
```

### Lupa flush() Sebelum Raw SQL
```python
# ❌ ORM cache belum ditulis ke DB saat raw SQL dijalankan
record.write({'amount': 500})  # di ORM cache, belum ke DB
self.env.cr.execute("SELECT amount FROM my_model WHERE id = %s", (record.id,))
# → bisa dapat nilai lama!

# ✅ Flush dulu
record.write({'amount': 500})
self.env.flush_all()  # atau record.flush_recordset()
self.env.cr.execute("SELECT amount FROM my_model WHERE id = %s", (record.id,))
```

---

## Architecture Pitfalls

### Business Logic di Controller
```python
# ❌ Controller tebal dengan business logic
@http.route('/api/confirm', type='json', auth='user')
def confirm_order(self, order_id):
    order = request.env['sale.order'].browse(order_id)
    if order.amount_total < 100:
        return {'error': 'Minimum order 100'}
    order.write({'state': 'sale'})
    order._send_confirmation_email()
    return {'success': True}

# ✅ Controller tipis, model yang handle
@http.route('/api/confirm', type='json', auth='user')
def confirm_order(self, order_id):
    order = request.env['sale.order'].browse(order_id)
    order.action_confirm_from_api()  # semua logic di sini
    return {'success': True, 'id': order.id}
```

### Hard-Depend ke Enterprise Module Tanpa Guard
```python
# ❌ Module community yang depend enterprise tanpa cek
{
    'depends': ['sale', 'sale_management', 'sale_enterprise_feature'],  # bisa fail!
}

# ✅ Gunakan auto_install atau pisahkan ke glue module
{
    'name': 'My Module Enterprise Bridge',
    'depends': ['my_module', 'sale_enterprise_feature'],
    'auto_install': True,  # install otomatis jika kedua deps ada
}
```
