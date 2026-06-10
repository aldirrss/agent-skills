# Debugging Workflow — Odoo 18

Systematic approach to diagnosing and fixing errors in Odoo 18 modules.

---

## Step 1: Classify the Error

Read the traceback from bottom to top. The last line tells you the error type.

| Error | Meaning | First Action |
|-------|---------|-------------|
| `UserError` | Business logic violation | Check model method raising it |
| `ValidationError` | @api.constrains failed | Check constraint method |
| `AccessError` | Security / permission | Check ir.rule or ACL |
| `MissingError` | Record deleted or ID wrong | Check browse() + exists() |
| `UniqueViolation` | Duplicate key in DB | Check unique constraint + use savepoint |
| `InFailedSqlTransaction` | Earlier error left tx aborted | Find earlier uncaught exception |
| `KeyError` | Dict key missing | Check vals dict or context keys |
| `AttributeError` on recordset | Wrong field name | Check field spelling + model name |
| `XMLSyntaxError` | Bad XML | Check view XML, especially unclosed tags |
| `ValueError: External ID not found` | Bad ref() in XML | Check module prefix in ref |

---

## Step 2: Error-Specific Diagnosis

### InFailedSqlTransaction

```
Symptom: "InFailedSqlTransaction: current transaction is aborted, commands ignored until end of transaction block"

Root cause: A DB error happened earlier in the same request, and you continued
without rolling back.

Fix:
1. Find the REAL error — scroll up in logs to find the error BEFORE this one
2. Wrap risky operations in savepoint:

try:
    with self.env.cr.savepoint():
        self.create({...})
except Exception as e:
    _logger.warning("Expected failure: %s", e)
    # Continue safely — savepoint was rolled back automatically
```

### UniqueViolation

```
Symptom: psycopg2.errors.UniqueViolation: duplicate key value violates unique constraint

Diagnosis:
1. What unique constraint? Check the constraint name in the error
2. Is it _sql_constraints in your model?
3. Or a PostgreSQL-level constraint?

Fix pattern:
from psycopg2 import errors as pgerrors

try:
    with self.env.cr.savepoint():
        record = self.create(vals)
except pgerrors.UniqueViolation:
    record = self.search([('key_field', '=', vals['key_field'])], limit=1)
```

### AccessError

```
Symptom: odoo.exceptions.AccessError: You are not allowed to access 'Model'

Diagnosis:
1. Check ir.model.access.csv — is there an entry for this model + group?
2. Check ir.rule — is there a record rule that filters this record out?
3. Is sudo() needed? (and if so, why doesn't the user have access?)

Quick debug in Python console:
self.env['my.model'].check_access_rights('read')  # raises if no access
self.env['my.model'].check_access_rule('read')     # raises if record rule blocks
```

### MissingError

```
Symptom: odoo.exceptions.MissingError: record does not exist or has been deleted

Diagnosis: browse(id) was called with an ID that doesn't exist

Fix:
record = self.env['my.model'].browse(some_id)
if not record.exists():
    raise UserError("Record not found")
# Or silently handle:
record = record.exists()
if not record:
    return
```

### External ID Not Found

```
Symptom: ValueError: External ID not found in the system: module.xml_id

Diagnosis:
1. Typo in the ref() — check module prefix
2. The record hasn't been loaded yet (wrong order in manifest data:)
3. The module isn't installed

Fix:
- Check: SELECT module, name FROM ir_model_data WHERE name = 'your_id';
- Verify manifest data: order — referenced module loads first
```

---

## Step 3: Odoo Shell Debugging

Quick inspection without restarting:

```bash
# Start shell for specific database
python odoo-bin shell -d my_database

# Or with Docker
docker exec -it odoo_container odoo shell -d my_database
```

```python
# In Odoo shell:

# Check model fields
env['my.model'].fields_get(['name', 'state'])

# Inspect a specific record
rec = env['my.model'].browse(1)
rec.read()

# Test a domain
env['my.model'].search_count([('state', '=', 'draft')])

# Run a method
env['my.model'].browse(1).action_submit()
env.cr.commit()  # Only if you want to save in shell

# Check access rights
env['my.model'].check_access_rights('write')

# Check who has a group
env.ref('my_module.group_manager').users.mapped('name')

# Test with specific user
user = env['res.users'].browse(3)
env_as_user = env(user=user)
env_as_user['my.model'].search([])
```

---

## Step 4: OWL / JavaScript Debugging

```javascript
// Always check browser console FIRST for OWL errors
// Odoo server logs won't show JS errors

// Enable OWL debug mode in URL:
// http://localhost:8069/web?debug=assets

// Inspect component state in browser console:
// Click the OWL devtools icon (if installed)
// Or: owl.__apps__[0].root.component

// Common OWL errors and meaning:
// "Cannot read property of undefined" → props not passed correctly
// "Unknown component" → forgot registry.category("fields").add(...)
// "useService can only be used in setup" → called outside setup()
// "Props validation error" → static props doesn't match received props
```

```python
# RPC debugging — add logging to controller
import logging
_logger = logging.getLogger(__name__)

@http.route('/my/endpoint', type='json', auth='user')
def my_endpoint(self, **kwargs):
    _logger.info("Received: %s", kwargs)
    result = ...
    _logger.info("Returning: %s", result)
    return result
```

---

## Step 5: Database Inspection

```sql
-- Check if record exists
SELECT id, name, active FROM my_model WHERE id = 42;

-- Check ir.model.access entries
SELECT a.name, m.model, g.full_name, a.perm_read, a.perm_write
FROM ir_model_access a
JOIN ir_model m ON m.id = a.model_id
LEFT JOIN res_groups g ON g.id = a.group_id
WHERE m.model = 'my.model';

-- Check external IDs
SELECT module, name, model, res_id
FROM ir_model_data
WHERE model = 'my.model'
ORDER BY module, name;

-- Check record rules
SELECT r.name, m.model, r.domain_force, r.global
FROM ir_rule r
JOIN ir_model m ON m.id = r.model_id
WHERE m.model = 'my.model';

-- Find UniqueViolation constraint
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'my_model'::regclass AND contype = 'u';
```

---

## Step 6: Module Upgrade Issues

```bash
# Upgrade specific module
python odoo-bin -d mydb -u my_module --stop-after-init

# Upgrade with log level for XML errors
python odoo-bin -d mydb -u my_module --stop-after-init --log-level=debug

# Common upgrade errors:
# "Element '<field name=X>' cannot be located" → bad xpath in view inheritance
# "noupdate" records out of sync → delete ir_model_data entry + reinstall
# "Cannot convert" field type → need migration script
```

```python
# Migration script template for data changes
# migrations/18.0.X.Y/pre-migrate.py
def migrate(cr, version):
    if version is None:
        return  # Fresh install, skip

    # Rename column
    cr.execute("""
        ALTER TABLE my_model
        RENAME COLUMN old_name TO new_name
    """)

    # Convert field type
    cr.execute("""
        ALTER TABLE my_model
        ALTER COLUMN my_field TYPE integer
        USING my_field::integer
    """)
```

---

## Logging Best Practices

```python
import logging
_logger = logging.getLogger(__name__)

class MyModel(models.Model):
    _name = 'my.model'

    def action_submit(self):
        _logger.info("Submitting %d records", len(self))
        for rec in self:
            try:
                rec._do_submit()
                _logger.debug("Record %s submitted OK", rec.name)
            except Exception as e:
                _logger.error("Failed to submit %s: %s", rec.name, e, exc_info=True)
                raise

# Log levels:
# _logger.debug()   → detailed, only in debug mode
# _logger.info()    → important business events
# _logger.warning() → something unexpected but handled
# _logger.error()   → error that was caught
# _logger.critical()→ system-level failure
```
