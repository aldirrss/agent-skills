# Common Pitfalls — Odoo 18

Traps that catch even experienced Odoo developers. Organized by category.

---

## Performance Pitfalls

### P1: search() Inside Loop (N+1 Query)

```python
# 🔴 KILLS performance at scale
for order in orders:
    payment = self.env['account.payment'].search([
        ('ref', '=', order.name)
    ], limit=1)

# ✅ FIX
all_payments = self.env['account.payment'].search_read(
    [('ref', 'in', orders.mapped('name'))],
    ['ref', 'amount']
)
payment_map = {p['ref']: p for p in all_payments}
```

### P2: write() Inside Loop

```python
# 🔴 N SQL UPDATE statements
for rec in records:
    rec.state = 'done'
    rec.write({'date_done': fields.Datetime.now()})

# ✅ 1 SQL UPDATE
records.write({'state': 'done', 'date_done': fields.Datetime.now()})
```

### P3: Missing store=True on Searched Computed Field

```python
# 🔴 Full table scan every time this field is in a domain
total = fields.Float(compute='_compute_total')  # store=False!
# domain = [('total', '>', 1000)]  → computes for ALL records first

# ✅
total = fields.Float(compute='_compute_total', store=True)
```

### P4: Forgetting @api.depends Dependency

```python
# 🔴 Field never recomputes when line_ids changes
@api.depends('partner_id')  # Missing: 'line_ids.price_subtotal'
def _compute_total(self):
    for rec in self:
        rec.total = sum(rec.line_ids.mapped('price_subtotal'))

# ✅
@api.depends('partner_id', 'line_ids.price_subtotal')
def _compute_total(self): ...
```

### P5: search() + read() Instead of search_read()

```python
# 🔴 Two roundtrips
records = self.env['model'].search(domain)
data = records.read(['name', 'date'])

# ✅ One roundtrip
data = self.env['model'].search_read(domain, ['name', 'date'])
```

### P6: Prefetch Broken by with_context()

```python
# 🔴 Creates new prefetch group, breaks batching
for rec in records:
    name = rec.with_context(lang='fr_FR').name  # new prefetch per iteration

# ✅ Apply context to whole recordset
for rec in records.with_context(lang='fr_FR'):
    name = rec.name  # batch prefetched
```

---

## Transaction Pitfalls

### T1: No Savepoint on UniqueViolation

```python
# 🔴 Transaction left in aborted state
try:
    self.create({'email': email})
except Exception:
    # Transaction is ABORTED — any subsequent DB call will fail!
    existing = self.search([('email', '=', email)])  # InFailedSqlTransaction!

# ✅ Use savepoint
try:
    with self.env.cr.savepoint():
        self.create({'email': email})
except Exception:
    # Savepoint rolled back, main transaction still alive
    existing = self.search([('email', '=', email)])  # Works!
```

### T2: commit() in Business Code

```python
# 🔴 NEVER call self.env.cr.commit() in model methods
# Commits ALL pending changes from ALL models, breaks atomicity
def my_method(self):
    self.write({'state': 'done'})
    self.env.cr.commit()  # DANGEROUS

# ✅ Let Odoo manage transactions — commit only in cron jobs or scripts
```

### T3: Aborted Transaction After Exception

```python
# If you catch an exception but don't use savepoint,
# ALL subsequent ORM calls in the same request will fail with:
# "InFailedSqlTransaction: current transaction is aborted"
# Solution: always use savepoint when you expect exceptions
```

---

## Decorator / ORM Pitfalls

### D1: @api.onchange Doing CRUD

```python
# 🔴 Undefined behavior — onchange works on pseudo-records
@api.onchange('partner_id')
def _onchange_partner(self):
    log = self.env['my.log'].create({'action': 'changed'})  # NEVER DO THIS

# ✅ onchange only updates field values on self
@api.onchange('partner_id')
def _onchange_partner(self):
    if self.partner_id:
        self.payment_term_id = self.partner_id.property_payment_term_id
```

### D2: @api.constrains with Dotted Path

```python
# 🔴 Dotted paths silently don't trigger
@api.constrains('partner_id.email')  # BROKEN — never triggers
def _check_email(self): ...

# ✅ Use direct field name only
@api.constrains('partner_id')
def _check_email(self):
    for rec in self:
        if rec.partner_id and not rec.partner_id.email:
            raise ValidationError("Partner must have email")
```

### D3: Forgetting @api.model_create_multi on create()

```python
# 🔴 Odoo 18 shows deprecation warning + performance penalty
@api.model
def create(self, vals):  # OLD pattern
    return super().create(vals)

# ✅ Odoo 18 correct pattern
@api.model_create_multi
def create(self, vals_list):
    for vals in vals_list:
        vals.setdefault('state', 'draft')
    return super().create(vals_list)
```

### D4: unlink() Override Instead of @api.ondelete

```python
# 🔴 Blocks module uninstall
def unlink(self):
    if any(r.state == 'done' for r in self):
        raise UserError("Cannot delete done records")
    return super().unlink()

# ✅ Odoo 18 correct pattern
@api.ondelete(at_uninstall=False)
def _unlink_if_done(self):
    if any(r.state == 'done' for r in self):
        raise UserError("Cannot delete done records")
```

### D5: Missing super() in Inheritance

```python
# 🔴 Breaks other modules that also inherit the method
def write(self, vals):
    # ... your code ...
    return True  # Never called super()!

# ✅ Always call super()
def write(self, vals):
    result = super().write(vals)
    # ... your code after ...
    return result
```

---

## Security Pitfalls

### S1: eval() on User Input

```python
# 🔴 REMOTE CODE EXECUTION
domain = eval(request.params.get('domain', '[]'))

# ✅ Use safe_eval from odoo.tools
from odoo.tools.safe_eval import safe_eval
domain = safe_eval(request.params.get('domain', '[]'))
```

### S2: Raw SQL f-string

```python
# 🔴 SQL INJECTION
name = request.params.get('name')
self.env.cr.execute(f"SELECT id FROM res_partner WHERE name = '{name}'")

# ✅
from odoo.tools import SQL
self.env.cr.execute(SQL("SELECT id FROM res_partner WHERE name = %s", name))
```

### S3: sudo() Without Reason

```python
# 🔴 Exposes ALL records to current user
orders = self.env['sale.order'].sudo().search([])

# ✅ sudo() only for specific technical operations, documented
# Only elevate for the specific operation needed
order = self.env['sale.order'].sudo().browse(order_id)  # checking existence
```

### S4: Missing Signature Validation on Webhooks

```python
# 🔴 Anyone can call your webhook
@http.route('/webhook/payment', type='http', auth='none', csrf=False)
def payment_webhook(self):
    data = request.httprequest.data
    self._process_payment(data)  # No validation!

# ✅
@http.route('/webhook/payment', type='http', auth='none', csrf=False)
def payment_webhook(self):
    signature = request.httprequest.headers.get('X-Signature', '')
    body = request.httprequest.data
    if not self._verify_hmac(signature, body):
        return Response('Forbidden', status=403)
    self._process_payment(body)
```

---

## OWL / Frontend Pitfalls

### O1: Using Deprecated RPC API

```javascript
// 🔴 DEPRECATED in Odoo 18
this.rpc('/web/dataset/call_kw', { model: '...', method: '...' })

// ✅
import { useService } from "@web/core/utils/hooks";
setup() {
    this.rpc = useService("rpc");
}
async myMethod() {
    const result = await this.rpc("/my/endpoint", { key: "value" });
}
```

### O2: Direct DOM Manipulation

```javascript
// 🔴 Breaks OWL reactivity
document.querySelector('.my-element').style.color = 'red';

// ✅ Use OWL state
setup() {
    this.state = useState({ color: 'black' });
}
// In template: t-att-style="'color:' + state.color"
```

### O3: Missing Component Registration

```javascript
// 🔴 Component exists but never shows up
export class MyWidget extends Component { ... }
// Forgot to register!

// ✅
import { registry } from "@web/core/registry";
registry.category("fields").add("my_widget", MyWidget);
```

### O4: Props Not Declared

```javascript
// 🔴 In dev mode: OWL throws "unknown prop" error
export class MyComponent extends Component {
    static template = xml`<div t-esc="props.someValue"/>`;
    // No static props declared
}

// ✅
static props = {
    someValue: { type: String, optional: true },
};
```

---

## XML / View Pitfalls

### X1: Wrong View Type Name (Odoo 18)

```xml
<!-- 🔴 Odoo 17 and below -->
<field name="view_mode">tree,form</field>

<!-- ✅ Odoo 18: "tree" renamed to "list" -->
<field name="view_mode">list,form</field>
```

### X2: noupdate Missing on User Data

```xml
<!-- 🔴 Will overwrite user's changes on module upgrade -->
<record id="default_config" model="my.config">
    <field name="value">default</field>
</record>

<!-- ✅ Wrap user-editable data in noupdate -->
<data noupdate="1">
    <record id="default_config" model="my.config">
        <field name="value">default</field>
    </record>
</data>
```

### X3: Security File Not First in Manifest

```python
# 🔴 Views reference groups that don't exist yet — XML load error
'data': [
    'views/my_views.xml',  # References groups not loaded yet!
    'security/security.xml',
    'security/ir.model.access.csv',
]

# ✅ Security always first
'data': [
    'security/security.xml',
    'security/ir.model.access.csv',
    'views/my_views.xml',
]
```
