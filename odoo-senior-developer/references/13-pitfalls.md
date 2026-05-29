---
name: odoo-pitfalls
description: Anti-patterns and common traps per Odoo version — with correct fixes.
---

# Pitfalls & Anti-Patterns — All Versions

## Universal Pitfalls (All Versions)

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

### Write Inside Loop
```python
# ❌ N SQL UPDATE
for rec in records:
    rec.write({'state': 'done'})

# ✅ 1 SQL UPDATE
records.write({'state': 'done'})
```

### Missing Loop in Compute
```python
# ❌ Only updates self[0], other records not updated
@api.depends('amount')
def _compute_tax(self):
    self.tax = self.amount * 0.1

# ✅
@api.depends('amount')
def _compute_tax(self):
    for rec in self:
        rec.tax = rec.amount * 0.1
```

### sudo() Without Reason
```python
# ❌ sudo() because lazy to fix ACL
def get_partner_data(self):
    return self.env['res.partner'].sudo().search([])  # exposes all records!

# ✅ Fix the ACL properly, or minimal sudo + documentation
def get_partner_data(self):
    # sudo needed: partner readable by all employees for display purpose
    return self.env['res.partner'].sudo().search([('customer_rank', '>', 0)])
```

### CRUD in Onchange
```python
# ❌ STRICTLY FORBIDDEN
@api.onchange('partner_id')
def _onchange_partner(self):
    self.env['audit.log'].create({'action': 'partner_changed'})  # NO!

# ✅ Onchange hanya update field UI
@api.onchange('partner_id')
def _onchange_partner(self):
    if self.partner_id:
        self.payment_term_id = self.partner_id.property_payment_term_id
```

### Dotted Path in @api.constrains
```python
# ❌ Invalid — will not trigger when partner changes
@api.constrains('partner_id.country_id')
def _check_country(self): ...

# ✅ Only direct fields
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
# ❌ @api.multi was deprecated in v14
@api.multi
def action_do(self):
    for rec in self:
        pass

# ✅ Without decorator (recordset method)
def action_do(self):
    for rec in self:
        pass
```

### v15 Pitfalls
```python
# ❌ Still using OWL 1.x syntax
const { useState } = owl.hooks;

# ✅ v15 module system
/** @odoo-module **/
import { useState } from "@odoo/owl";

# ❌ @api.model for create
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
# ❌ this.rpc is deprecated in v16
async _loadData() {
    await this.rpc({model: 'my.model', method: 'get_data', args: []});
}

# ✅ useService('rpc') or orm
setup() {
    this.orm = useService("orm");
}
async _loadData() {
    await this.orm.call("my.model", "get_data", []);
}
```

### v17 Pitfalls
```python
# ❌ Still using <tree> without checking the target version
# Odoo 17 is in a transition phase — prefer <list> if v17+ is your target

# ❌ Still using group_operator= (deprecated starting in v17)
amount = fields.Float(group_operator='sum')

# ✅ v17+
amount = fields.Float(aggregator='sum')
```

### v18 Pitfalls
```python
# ❌ Still using the <tree> tag in v18
# <tree string="Records">  ← must be <list> in v18

# ❌ Still using attrs= in v18 (deprecated)
# <field name="x" attrs="{'invisible': [...]}"/>
# ✅
# <field name="x" invisible="state == 'done'"/>

# ❌ group_operator= in v18
amount = fields.Float(group_operator='sum')
# ✅
amount = fields.Float(aggregator='sum')

# ❌ <div class="oe_chatter"> in v18
# <div class="oe_chatter">...</div>
# ✅
# <chatter/>
```

---

## Transaction Pitfalls

### Handling UniqueViolation Without a Savepoint
```python
# ❌ Transaction is broken after UniqueViolation without a savepoint
try:
    self.create({'reference': ref})
except Exception:
    # Transaction is already "aborted" — any query will fail!
    existing = self.search([('reference', '=', ref)])  # ERROR: InFailedSqlTransaction

# ✅ Use a savepoint
try:
    with self.env.cr.savepoint():
        self.create({'reference': ref})
except Exception:
    # Savepoint rolls back, main transaction remains healthy
    existing = self.search([('reference', '=', ref)])  # ✅ works
```

### Forgetting flush() Before Raw SQL
```python
# ❌ ORM cache has not been written to DB when raw SQL runs
record.write({'amount': 500})  # in ORM cache, not yet in DB
self.env.cr.execute("SELECT amount FROM my_model WHERE id = %s", (record.id,))
# → may return stale values!

# ✅ Flush first
record.write({'amount': 500})
self.env.flush_all()  # or record.flush_recordset()
self.env.cr.execute("SELECT amount FROM my_model WHERE id = %s", (record.id,))
```

---

## Architecture Pitfalls

### Business Logic in Controller
```python
# ❌ Fat controller with business logic
@http.route('/api/confirm', type='json', auth='user')
def confirm_order(self, order_id):
    order = request.env['sale.order'].browse(order_id)
    if order.amount_total < 100:
        return {'error': 'Minimum order 100'}
    order.write({'state': 'sale'})
    order._send_confirmation_email()
    return {'success': True}

# ✅ Thin controller, model handles the logic
@http.route('/api/confirm', type='json', auth='user')
def confirm_order(self, order_id):
    order = request.env['sale.order'].browse(order_id)
    order.action_confirm_from_api()  # all logic lives here
    return {'success': True, 'id': order.id}
```

### Hard Dependency on Enterprise Module Without Guard
```python
# ❌ Community module depends on enterprise module without safeguards
{
    'depends': ['sale', 'sale_management', 'sale_enterprise_feature'],  # may fail!
}

# ✅ Use auto_install or split into a glue module
{
    'name': 'My Module Enterprise Bridge',
    'depends': ['my_module', 'sale_enterprise_feature'],
    'auto_install': True,  # auto-install when both dependencies exist
}
```
