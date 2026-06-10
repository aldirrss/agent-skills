---
name: odoo-security
description: Complete security patterns — ACL, record rules, field access, security pitfalls for all Odoo versions.
---

# Security — All Versions

## Access Rights (ir.model.access.csv)

Required for every new model. Format:

```csv
id,name,model_id:id,group_id:id,perm_read,perm_write,perm_create,perm_unlink
access_my_model_user,my.model.user,model_my_model,base.group_user,1,0,0,0
access_my_model_manager,my.model.manager,model_my_model,my_module.group_manager,1,1,1,1
access_my_model_admin,my.model.admin,model_my_model,base.group_system,1,1,1,1
```

Rules:
- Empty `group_id` = all users (including portal/public) — **be careful**
- ACL is **additive** — user gets the union of all their groups' access
- Security files must be **FIRST** in the manifest `data:` array

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
# Check group in code
if self.env.user.has_group('my_module.group_my_module_manager'):
    # manager-only logic
    pass
```

---

## Record Rules (ir.rule)

```xml
<!-- User can only see their own records -->
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

<!-- Manager sees all records -->
<record id="rule_my_model_all" model="ir.rule">
    <field name="name">My Model: All Records (Manager)</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">[(1, '=', 1)]</field>
    <field name="groups" eval="[(4, ref('my_module.group_my_module_manager'))]"/>
</record>

<!-- Multi-company (global rule — applies to everyone) -->
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
- **Global** (without `groups`): ALL global rules must match (intersection)
- **Group** (with `groups`): ANY ONE group rule is sufficient (union)
- Two conflicting global rules → **NO records can be accessed!**

---

## Field-Level Access

```python
class MyModel(models.Model):
    _name = 'my.model'

    name = fields.Char()                                           # everyone
    internal_notes = fields.Text(groups='base.group_user')         # employees
    salary = fields.Float(groups='my_module.group_hr_manager')     # HR only
    secret_code = fields.Char(groups='base.group_system')          # admin only
```

---

## Security Pitfalls

### 1. Excessive sudo()
```python
# ❌ TRAP: sudo() without reason
records = self.env['hr.payslip'].sudo().search([])  # exposes all payslips!

# ✅ Only sudo for specific technical operations
mail_template = self.env.ref('my_module.email_template').sudo()
mail_template.send_mail(self.id, force_send=True)
```

### 2. eval() on User Input
```python
# ❌ REMOTE CODE EXECUTION
domain = eval(request.params.get('domain'))

# ✅ Use safe_eval or literal_eval
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
<!-- ❌ t-raw with user content -->
<div t-raw="user_message"/>

<!-- ✅ t-esc auto-escapes -->
<div t-esc="user_message"/>
```

```python
# ✅ Markup for structured HTML
from markupsafe import Markup
message = Markup("<p><strong>%s</strong>: %s</p>") % (label, user_content)
```

### 5. Webhook Without Signature Validation
```python
# ❌ Open webhook without validation
@http.route('/webhook/payment', type='http', auth='none', csrf=False)
def payment_webhook(self):
    data = request.get_json_data()
    self._process_payment(data)  # DANGEROUS!

# ✅ Validate signature first
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
# ❌ All public methods can be called via JSON-RPC
def action_done(self):
    self.write({'state': 'done'})  # anyone can call this!

# ✅ Validate permission
def action_done(self):
    if not self.env.user.has_group('my_module.group_manager'):
        raise AccessError("Only managers can mark as done")
    self.write({'state': 'done'})
```

---

## Security Checklist

- [ ] `ir.model.access.csv` exists for every new model
- [ ] Groups defined in XML, not hardcoded in code
- [ ] Record rules exist for models with per-user or per-company data
- [ ] sudo() used minimally with a comment explaining why
- [ ] No raw string SQL (f-strings with user input)
- [ ] Webhooks have signature validation
- [ ] Sensitive public methods have permission checks
- [ ] t-esc (not t-raw) for user content in QWeb
