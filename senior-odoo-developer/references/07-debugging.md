---
name: odoo-debugging
description: Systematic debugging workflow for Python errors, OWL/JS errors, transaction errors, and performance issues across all Odoo versions.
---

# Debugging Workflow — All Versions

## Step 1: Reading the Traceback Correctly

```
ALWAYS read from BOTTOM to TOP:
- Last line = error type + message
- Lines above = location in our code
- Keep going up until you find a file in our addons/ (not odoo core)
```

---

## Identifying the Error Type

```
Error TYPE → Meaning → Action

UserError / ValidationError
  → Business logic issue — invalid data
  → Check validation in @api.constrains or write/create override

AccessError
  → Permission issue
  → Check ir.model.access.csv and ir.rule
  → Check if sudo() is needed (but find out WHY first)

MissingError
  → Record deleted or wrong ID
  → Check if record still exists: record.exists()
  → Possible race condition or stale ID

UniqueViolation (psycopg2.errors.UniqueViolation)
  → Duplicate key constraint in database
  → Use savepoint! Transaction is already broken after this error
  → Check constraint name in e.diag.constraint_name

InFailedSqlTransaction
  → A previous error was not handled
  → Transaction is still in "aborted" state
  → Must use savepoint from the start

KeyError / AttributeError
  → Python bug — wrong field name or attribute not found
  → Check field name typos, check if field exists in model

IntegrityError
  → Foreign key constraint or NOT NULL violation
  → Check many2one relationship ondelete strategy

RecursionError
  → @api.depends or compute calls itself
  → Check circular dependency in depends chain
```

---

## Pattern: Handle UniqueViolation

```python
from psycopg2 import errors as pg_errors

def create_with_fallback(self, vals):
    try:
        with self.env.cr.savepoint():
            return self.create(vals)
    except Exception as e:
        if isinstance(e.__cause__, pg_errors.UniqueViolation):
            # Record already exists — find and return existing
            existing = self.search([
                ('reference', '=', vals.get('reference')),
                ('company_id', '=', vals.get('company_id', self.env.company.id)),
            ], limit=1)
            if existing:
                return existing
        raise
```

---

## Pattern: Savepoint for Partial Failures

```python
def process_batch(self, records):
    success = self.env['my.model']
    failed = []

    for record in records:
        try:
            with self.env.cr.savepoint():
                record.action_process()
                success |= record
        except Exception as e:
            failed.append({'record': record.id, 'error': str(e)})
            # savepoint auto-rolled back, main transaction keeps running

    return {'success': success.ids, 'failed': failed}
```

---

## Debug OWL / JavaScript Errors

```
1. ALWAYS open browser DevTools → Console FIRST
   OWL errors in console are far more informative than Odoo logs

2. OWL error types:
   - "Cannot read property X of undefined" → props incomplete, check static props
   - "Component is destroyed" → async operation after component unmounted
   - "willStart/onWillStart failed" → error in async initialization

3. Debug steps:
   a. F12 → Console → read full error message
   b. Network tab → check if RPC call failed (status 500/400)
   c. Source tab → set breakpoint in JS code
   d. Reload with ?debug=assets to load non-minified JS
```

```javascript
// Add temporary debug logging
import { useEffect } from "@odoo/owl";

class MyComponent extends Component {
    setup() {
        useEffect(() => {
            console.log("Props:", this.props);
            console.log("State:", this.state);
        });
    }
}
```

---

## Debug Performance Issues

```python
# Enable query logging temporarily
import logging
logging.getLogger('odoo.sql_db').setLevel(logging.DEBUG)

# Count queries in one operation
from odoo.tests.common import BaseCase
import odoo.tests.common as common

# Use ?debug=1 in URL to see technical info
# Settings → Technical → Logging → add odoo.sql_db DEBUG

# Profile with Python profiler
import cProfile
import pstats

pr = cProfile.Profile()
pr.enable()
# ... code to profile ...
pr.disable()
stats = pstats.Stats(pr).sort_stats('cumulative')
stats.print_stats(20)
```

---

## Odoo Shell for Interactive Debugging

```bash
# Odoo shell
odoo-bin shell -d mydb --addons-path=...

# In shell:
env = self.env  # or: env = api.Environment(cr, uid, {})

# Test query
records = env['my.model'].search([('state', '=', 'draft')])
print(records)
print(records.read(['name', 'state']))

# Test method
result = records[0].action_confirm()
env.cr.rollback()  # don't commit!
```

---

## Common Odoo-Specific Bugs

```python
# BUG: @api.depends with dotted path in @api.constrains
@api.constrains('partner_id.country_id')  # ❌ INVALID
def _check_country(self):
    pass

@api.constrains('partner_id')  # ✅ only direct fields
def _check_country(self):
    for rec in self:
        if rec.partner_id.country_id.code != 'ID':
            raise ValidationError("Indonesia only")

# BUG: CRUD inside onchange
@api.onchange('partner_id')
def _onchange_partner(self):
    if self.partner_id:
        self.env['my.log'].create({'message': 'changed'})  # ❌ don't!
        self.name = self.partner_id.name  # ✅ only update UI fields

# BUG: Forgot loop in compute method
@api.depends('amount')
def _compute_tax(self):
    # ❌ without loop — only updates first record
    self.tax_amount = self.amount * 0.1

    # ✅ with loop
    for rec in self:
        rec.tax_amount = rec.amount * 0.1

# BUG: Modifying list while iterating
for line in order.line_ids:
    if condition:
        line.unlink()  # ❌ modifying while iterating

lines_to_delete = order.line_ids.filtered(lambda l: condition)
lines_to_delete.unlink()  # ✅
```
