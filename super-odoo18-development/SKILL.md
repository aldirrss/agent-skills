---
name: super-odoo18-development
description: >
  ELITE Odoo 18 development skill for senior-level guidance. Use this for ANY Odoo 18 task
  that requires architectural decisions, code quality review, debugging, performance optimization,
  or avoiding common pitfalls. Triggers on: Odoo 18 module development, custom addon, ORM query,
  computed field, OWL component, controller, security, migration, wizard, report, cron job,
  traceback, N+1 query, UniqueViolation, transaction error, or any mention of __manifest__,
  models/, views/, addons/, ir.rule, @api.depends, @api.onchange, fields.Many2one, search_read,
  sudo(), with_context(). ALWAYS use alongside skill odoo-18 for deep technical reference.
  Go beyond documentation — think like a senior Odoo architect.
globs: "**/*.{py,xml,csv,js}"
---

# Super Odoo 18 Development — Senior Architect Layer

This skill provides **opinionated guidance** on top of the `odoo-18` reference skill.
Where `odoo-18` answers "what", this skill answers **"how", "why", and "watch out"**.

> Always pair with `odoo-18` for API detail. This skill focuses on judgment calls.

## Quick Index

| Need | Go To |
|------|-------|
| "Which decorator do I use?" | [Decision Trees](#decision-trees) |
| "Why is this slow?" | [Performance Pitfalls](#-performance-pitfalls) |
| "Something feels wrong architecturally" | [Architecture Patterns](#architecture-patterns) |
| "I have a traceback / weird error" | [Debugging Workflow](#debugging-workflow) |
| "Is this code good?" | [Code Quality Checklist](#code-quality-checklist) |
| "Security concern" | [Security Traps](#security-traps) |
| Deep technical reference | `references/` files below |

## Reference Files (Load on Demand)

| File | When to Read |
|------|-------------|
| `references/decision-trees.md` | Choosing between decorators, field types, auth types, etc. |
| `references/pitfalls.md` | Common mistakes by category — N+1, transactions, OWL, security |
| `references/architecture.md` | Module structure patterns, service layers, scalable design |
| `references/debugging.md` | Systematic approach to tracebacks, DB errors, OWL errors |
| `references/code-quality.md` | Review checklist, naming conventions, anti-patterns |

---

## Decision Trees

Quick answers to the most common "which one do I use?" questions.

### Computed Field vs Onchange

```
Need to update a field value?
├── Must be correct in DB (not just UI) → @api.depends (computed field)
│   ├── Needs to be searched → store=True + search=...
│   ├── Needs to be edited → add inverse=...
│   └── Context-dependent → also @api.depends_context
└── UI feedback only, no DB write needed → @api.onchange
    ⚠️  onchange NEVER does CRUD — no create/write/unlink inside onchange
```

### store=True vs store=False

```
Computed field — should it be stored?
├── Searched in domain filters? → store=True (REQUIRED)
├── Used in reports or exports? → store=True (much faster)
├── Changes rarely, many records? → store=True
├── Changes constantly (e.g. "now") → store=False
└── Only shown in form UI, rarely queried → store=False is fine
```

### @api.constrains vs Override write/create

```
Need to validate data?
├── Constraint on model fields → @api.constrains (preferred)
│   ⚠️  No dotted paths! Only direct fields.
│   ⚠️  Only triggers if the field is in the vals being written.
└── Need to validate regardless of which fields change → override write()
    └── Call super() FIRST, then validate
```

### sudo() — When to Use

```
Need elevated access?
├── In a controller (public endpoint) → sudo() OK, but be explicit about why
├── In a model method → AVOID — rethink your security model instead
├── For counting/checking existence of related records → sudo() OK
├── For sending emails or notifications → sudo() OK (technical operation)
└── "I just want it to work" → NEVER — fix the access rights instead
```

### auth Type in Controllers

```
HTTP endpoint — who can call it?
├── Only logged-in users → auth='user' (default, safe)
├── Public website page (no login needed) → auth='public'
│   └── Use sudo() explicitly only for what you need
├── Webhook from external system → auth='none', csrf=False
│   └── ALWAYS validate signature/token manually
└── Internal utility, no env needed → auth='none'
```

### Field Type Selection

```
What data are you storing?
├── Short text (name, code, ref) → Char
├── Long text (notes, description) → Text
├── Formatted HTML → Html (auto-sanitized)
├── True/False → Boolean
├── Whole number → Integer
├── Decimal number → Float
│   └── Money amount → Monetary (+ currency_id field)
├── Date only → Date
├── Date + time → Datetime
├── File/image → Binary (use attachment=True for large files)
├── Fixed options → Selection
├── Link to one record → Many2one (+ ondelete='restrict'/'cascade'/'set null')
├── Children records → One2many (+ inverse_name required)
└── Multiple links → Many2many
```

---

## ⚠️ Performance Pitfalls

**The #1 Odoo performance killer: N+1 queries inside loops.**

### Quick Diagnosis

```python
# 🔴 RED FLAG: search() inside a for loop
for record in records:
    related = self.env['other.model'].search([('ref_id', '=', record.id)])

# ✅ FIX: search once with IN domain
all_related = self.env['other.model'].search([('ref_id', 'in', records.ids)])
```

```python
# 🔴 RED FLAG: Computed field without @api.depends dependencies
@api.depends()  # empty or missing
def _compute_something(self):
    for rec in self:
        rec.value = self.env['model'].search_count([...])  # runs per record!

# ✅ FIX: Use _read_group for aggregation in computed fields
```

```python
# 🔴 RED FLAG: write() inside a loop
for rec in records:
    rec.write({'state': 'done'})  # N SQL updates

# ✅ FIX: Batch write on recordset
records.write({'state': 'done'})  # 1 SQL update
```

### When to Use SQL Directly

Use `self.env.cr.execute(SQL(...))` when:
- Aggregating over millions of rows
- Cross-model aggregations
- Reporting queries with complex GROUP BY

Never use raw f-strings. Always use `SQL()` or `%s` params:
```python
# 🔴 NEVER
self.env.cr.execute(f"SELECT * FROM table WHERE id = {record_id}")

# ✅ ALWAYS
from odoo.tools import SQL
self.env.cr.execute(SQL("SELECT * FROM table WHERE id = %s", record_id))
```

> For full patterns → `references/pitfalls.md#performance`

---

## Architecture Patterns

### The Golden Rule: Thin Controllers, Fat Models

```
HTTP Request
    ↓
Controller (validate input, call model, return response)
    ↓
Model Method (all business logic lives here)
    ↓
ORM / DB
```

Never put business logic in controllers. Never put presentation logic in models.

### Service Layer for External Integrations

When integrating with external APIs (Camunda, payment gateways, etc.):

```
my_module/
├── models/
│   └── my_model.py          # Business logic, triggers service
├── services/
│   └── external_api.py      # All HTTP calls to external system
└── controllers/
    └── webhook.py           # Receives callbacks from external system
```

```python
# models/my_model.py
def action_send_to_external(self):
    service = self.env['my.external.service']
    result = service.send(self._prepare_payload())
    self.write({'external_id': result['id'], 'state': 'sent'})

# services/external_api.py — thin, testable, mockable
class MyExternalService(models.AbstractModel):
    _name = 'my.external.service'

    def send(self, payload):
        # All requests/urllib calls here
        # Always handle failures gracefully
        try:
            ...
        except Exception as e:
            raise UserError(f"External API failed: {e}")
```

### Multi-Company Awareness

If your module stores company-specific data:
```python
class MyModel(models.Model):
    _name = 'my.model'

    company_id = fields.Many2one('res.company', required=True,
        default=lambda self: self.env.company)
```

And add a record rule:
```xml
<record id="rule_my_model_company" model="ir.rule">
    <field name="name">My Model: Multi-company</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">[('company_id', 'in', company_ids)]</field>
    <field name="global" eval="True"/>
</record>
```

> For full patterns → `references/architecture.md`

---

## Debugging Workflow

When you hit an error, follow this order:

```
1. Read the FULL traceback — last line first, then work up
2. Identify the error TYPE:
   ├── UserError / ValidationError → business logic issue
   ├── AccessError → security/permission issue
   ├── MissingError → record deleted or wrong ID
   ├── UniqueViolation → duplicate key constraint
   ├── InFailedSqlTransaction → earlier error not handled, tx aborted
   └── KeyError / AttributeError → Python bug, usually wrong field name

3. For transaction errors — ALWAYS use savepoints:
   with self.env.cr.savepoint():
       try:
           self.create({...})
       except Exception:
           pass  # savepoint auto-rolled back

4. For OWL/JS errors — open browser console FIRST
   Most OWL errors show cleaner messages in console than in Odoo logs
```

> For systematic approach → `references/debugging.md`

---

## Security Traps

```python
# 🔴 TRAP: sudo() without understanding why
record = self.env['hr.payslip'].sudo().search([])  # exposes all payslips!

# 🔴 TRAP: Passing user input directly to domain
domain = eval(request.params.get('domain'))  # REMOTE CODE EXECUTION!

# 🔴 TRAP: Raw SQL with string formatting
self.env.cr.execute("SELECT * FROM res_partner WHERE name = '%s'" % name)  # SQL INJECTION

# 🔴 TRAP: Missing csrf=False check on webhook
@http.route('/webhook', type='json', auth='none')  # Missing: validate signature!
def webhook(self): ...

# ✅ PATTERN: Validate webhook signature
@http.route('/webhook', type='http', auth='none', csrf=False)
def webhook(self):
    signature = request.httprequest.headers.get('X-Signature')
    if not self._verify_signature(signature, request.httprequest.data):
        return request.make_json_response({'error': 'Invalid signature'}, status=401)
```

> For complete security guide → `odoo-18` skill → `references/odoo-18-security-guide.md`

---

## Code Quality Checklist

Before submitting any Odoo 18 code, verify:

**Models**
- [ ] `_name` defined (or `_inherit` for extension)
- [ ] `_description` defined (Odoo 18 warns without it)
- [ ] `create()` uses `@api.model_create_multi` (not legacy `@api.model`)
- [ ] No `search()` or `create()` inside loops
- [ ] All `@api.depends` list every dependency (missing = stale values)
- [ ] `@api.onchange` does NOT call `create/write/unlink`
- [ ] Deletion guard uses `@api.ondelete(at_uninstall=False)` not `unlink()` override

**Security**
- [ ] `ir.model.access.csv` has entry for every new model
- [ ] `sudo()` usage is commented with reason
- [ ] No raw f-string SQL queries
- [ ] Webhooks validate signatures

**Performance**
- [ ] No search/write/create inside for loops
- [ ] Computed fields that are searched have `store=True`
- [ ] `search_read()` used instead of `search()` + `read()` combo
- [ ] `mapped()` used for single-field extraction from recordset

**XML/Views**
- [ ] `noupdate="1"` on user-editable data
- [ ] `ir.model.access.csv` listed before views in manifest `data:`
- [ ] Security files listed FIRST in manifest `data:` array

**OWL/JS**
- [ ] `useService('rpc')` not deprecated `this.rpc`
- [ ] Component registered in correct registry
- [ ] Props validated with `static props = {...}`

> For detailed anti-patterns → `references/code-quality.md`
