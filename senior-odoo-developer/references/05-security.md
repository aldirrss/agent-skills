---
name: odoo-security
description: Security patterns lengkap — ACL, record rules, field access, security pitfalls untuk semua versi Odoo.
---

# Security — All Versions

## Access Rights (ir.model.access.csv)

WAJIB untuk setiap model baru. Format:

```csv
id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink
access_my_model_user,my.model.user,model_my_model,base.group_user,1,0,0,0
access_my_model_manager,my.model.manager,model_my_model,my_module.group_manager,1,1,1,1
access_my_model_admin,my.model.admin,model_my_model,base.group_system,1,1,1,1
```

Rules:
- `group_id` kosong = semua user (termasuk portal/public) — **hati-hati**
- ACL bersifat **additive** — user dapat union dari semua grup-nya
- Security files harus **PERTAMA** di `data:` array manifest

---

## User Groups

```xml
<record id="group_my_module_user" model="res.groups">
    <field name="name">User</field>
    <field name="category_id" ref="base.module_category_my_module"/>
    <field name="implied_ids" eval="[(4, ref('base.group_user'))]"/>
</record>

<record id="group_my_module_manager" model="res.groups">
    <field name="name">Manager</field>
    <field name="category_id" ref="base.module_category_my_module"/>
    <field name="implied_ids" eval="[(4, ref('my_module.group_my_module_user'))]"/>
</record>
```

```python
# Check group di code
if self.env.user.has_group('my_module.group_my_module_manager'):
    # manager-only logic
    pass
```

---

## Record Rules (ir.rule)

```xml
<!-- User hanya lihat rekord miliknya -->
<record id="rule_my_model_own" model="ir.rule">
    <field name="name">My Model: Own Records</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">[('user_id', '=', user.id)]</field>
    <field name="groups" eval="[(4, ref('my_module.group_my_module_user'))]"/>
    <field name="perm_read" eval="True"/>
    <field name="perm_write" eval="True"/>
    <field name="perm_create" eval="True"/>
    <field name="perm_unlink" eval="True"/>
</record>

<!-- Manager lihat semua -->
<record id="rule_my_model_all" model="ir.rule">
    <field name="name">My Model: All Records (Manager)</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">[(1, '=', 1)]</field>
    <field name="groups" eval="[(4, ref('my_module.group_my_module_manager'))]"/>
</record>

<!-- Multi-company (global rule — berlaku untuk semua) -->
<record id="rule_my_model_company" model="ir.rule">
    <field name="name">My Model: Multi-company</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">
        ['|', ('company_id', '=', False), ('company_id', 'in', company_ids)]
    </field>
    <field name="global" eval="True"/>
</record>
```

**⚠️ Global Rules vs Group Rules:**
- **Global** (tanpa `groups`): SEMUA global rules harus match (intersection)
- **Group** (dengan `groups`): SALAH SATU group rules cukup (union)
- Dua global rules yang bertentangan → **TIDAK ADA rekord yang bisa diakses!**

---

## Field-Level Access

```python
class MyModel(models.Model):
    _name = 'my.model'

    name = fields.Char()                                           # semua
    internal_notes = fields.Text(groups='base.group_user')         # employees
    salary = fields.Float(groups='my_module.group_hr_manager')     # HR only
    secret_code = fields.Char(groups='base.group_system')          # admin only
```

---

## Security Pitfalls

### 1. sudo() Berlebihan
```python
# ❌ TRAP: sudo() tanpa alasan
records = self.env['hr.payslip'].sudo().search([])  # expose semua payslip!

# ✅ Hanya sudo untuk operasi teknis spesifik
mail_template = self.env.ref('my_module.email_template').sudo()
mail_template.send_mail(self.id, force_send=True)
```

### 2. eval() pada User Input
```python
# ❌ REMOTE CODE EXECUTION
domain = eval(request.params.get('domain'))

# ✅ Gunakan safe_eval atau literal_eval
from odoo.tools.safe_eval import safe_eval
domain = safe_eval(request.params.get('domain', '[]'))
```

### 3. SQL Injection
```python
# ❌ SQL INJECTION
query = f"SELECT id FROM table WHERE name = '{user_input}'"
self.env.cr.execute(query)

# ✅ Parameterized query
self.env.cr.execute("SELECT id FROM table WHERE name = %s", (user_input,))

# ✅ v17+: SQL() class
from odoo.tools import SQL
self.env.cr.execute(SQL("SELECT id FROM table WHERE name = %s", user_input))
```

### 4. XSS — Unescaped Content
```xml
<!-- ❌ t-raw dengan user content -->
<div t-raw="user_message"/>

<!-- ✅ t-esc auto-escapes -->
<div t-esc="user_message"/>
```

```python
# ✅ Markup untuk HTML terstruktur
from markupsafe import Markup
message = Markup("<p><strong>%s</strong>: %s</p>") % (label, user_content)
```

### 5. Webhook tanpa Validasi Signature
```python
# ❌ Webhook terbuka tanpa validasi
@http.route('/webhook/payment', type='http', auth='none', csrf=False)
def payment_webhook(self):
    data = request.get_json_data()
    self._process_payment(data)  # BAHAYA!

# ✅ Validasi signature dulu
@http.route('/webhook/payment', type='http', auth='none', csrf=False)
def payment_webhook(self):
    signature = request.httprequest.headers.get('X-Signature')
    payload = request.httprequest.data
    if not self._verify_hmac(signature, payload):
        return request.make_json_response({'error': 'Invalid signature'}, status=401)
    data = request.get_json_data()
    self._process_payment(data)
```

### 6. Public Method via RPC
```python
# ❌ Semua public method bisa dipanggil via JSON-RPC
def action_done(self):
    self.write({'state': 'done'})  # siapapun bisa panggil ini!

# ✅ Validasi permission
def action_done(self):
    if not self.env.user.has_group('my_module.group_manager'):
        raise AccessError("Only managers can mark as done")
    self.write({'state': 'done'})
```

---

## Security Checklist

- [ ] `ir.model.access.csv` ada untuk setiap model baru
- [ ] Groups didefinisikan di XML, bukan hardcoded di code
- [ ] Record rules ada untuk model yang punya data per-user atau per-company
- [ ] sudo() dipakai minimal dan ada comment alasannya
- [ ] Tidak ada raw string SQL (f-string dengan user input)
- [ ] Webhook punya signature validation
- [ ] Public methods yang sensitif punya permission check
- [ ] t-esc (bukan t-raw) untuk user content di QWeb
