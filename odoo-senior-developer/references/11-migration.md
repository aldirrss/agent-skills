---
name: odoo-migration
description: Migration scripts, upgrade paths, and breaking changes between Odoo versions 14-19.
---

# Migration Guide — v14 to v19

## Migration Script Structure

```python
# migrations/16.0.1.1.0/pre-migrate.py
def migrate(cr, version):
    """Run BEFORE the module is loaded (pre-migrate)"""
    if not version:
        return  # fresh install, skip
    # Rename column, drop old constraint, etc.
    cr.execute("ALTER TABLE my_model RENAME COLUMN old_field TO new_field")

# migrations/16.0.1.1.0/post-migrate.py
from odoo import api, SUPERUSER_ID

def migrate(cr, version):
    """Run AFTER the module is loaded (post-migrate)"""
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    # Fill data, recompute, update records
    records = env['my.model'].search([('new_field', '=', False)])
    records.write({'new_field': 'default_value'})
```

---

## Breaking Changes Per Version

### v14 → v15

```python
# @api.multi REMOVED (was deprecated in v14)
# ❌ v14 still works:
@api.multi
def action_do(self):
    for rec in self:
        pass

# ✅ v15+: without decorator
def action_do(self):
    for rec in self:
        pass

# create() — switch to model_create_multi
@api.model_create_multi
def create(self, vals_list):
    return super().create(vals_list)

# OWL: switch to v15 module system
# Change: odoo.define('module.Widget', ...) 
# To: /** @odoo-module **/ + import statements
```

### v15 → v16

```python
# Python upgrade: 3.8/3.9 → 3.10
# OWL upgrade: 1.x → 2.x

# OWL 2: hooks usage changed
# v15 (OWL 1):
const { useState, useRef } = owl.hooks;
# v16 (OWL 2):
import { useState, useRef } from "@odoo/owl";

# this.rpc deprecated in v16
# ❌ v15 style:
await this.rpc({ model: 'x', method: 'y', args: [] });
# ✅ v16+:
const rpc = useService("rpc");
await rpc("/web/dataset/call_kw", {...});
# Or more cleanly:
const orm = useService("orm");
await orm.call("x", "y", []);

# @api.ondelete stably available in v15+
@api.ondelete(at_uninstall=False)
def _unlink_check(self):
    if self.state != 'draft':
        raise UserError("...")

# make_json_response available in v16+
return request.make_json_response({'result': data})
```

### v16 → v17

```python
# SQL() class available
from odoo.tools import SQL
query = SQL("SELECT id FROM table WHERE name = %s", name)

# New Json and Properties fields
json_data = fields.Json(string='Data')
properties = fields.Properties(string='Properties',
                               definition='model_id.property_definition')

# New _read_group API (more powerful)
groups = self.env['my.model']._read_group(
    domain=[],
    groupby=['partner_id'],
    aggregates=['amount_total:sum', '__count'],
)

# View: transition to inline attrs (both still valid)
# Chatter: start using <chatter/> tag
```

### v17 → v18

```python
# <list> tag replaces <tree>
# ❌ v17-:
# <tree string="Records">
# ✅ v18+:
# <list string="Records">

# aggregator= replaces group_operator=
# ❌:
amount = fields.Float(group_operator='sum')
# ✅:
amount = fields.Float(aggregator='sum')

# Inline attrs RECOMMENDED (attrs= still valid but deprecated)
# ✅ v18 style:
# <field name="date_end" invisible="state != 'done'" required="state == 'done'"/>

# Chatter: MUST use <chatter/> tag (not <div class="oe_chatter">)
```

### v18 → v19

```python
# OWL 3.x: functional components available
# Class components still valid but deprecated

# OWL 3 functional component:
import { Component, useState } from "@odoo/owl";

function MyWidget(props) {
    const state = useState({ count: 0 });
    return <div onClick={() => state.count++}>{state.count}</div>;
}

# Python: 3.12+ features available
```

---

## Migration Script Patterns

### Rename Column
```python
def migrate(cr, version):
    cr.execute("""
        ALTER TABLE my_model
        RENAME COLUMN old_name TO new_name
    """)
```

### Add Column with Default
```python
def migrate(cr, version):
    # Check if column already exists (idempotent)
    cr.execute("""
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'my_model' AND column_name = 'new_field'
    """)
    if not cr.fetchone():
        cr.execute("""
            ALTER TABLE my_model ADD COLUMN new_field VARCHAR DEFAULT 'draft'
        """)
```

### Migrate Data
```python
from odoo import api, SUPERUSER_ID

def migrate(cr, version):
    env = api.Environment(cr, SUPERUSER_ID, {})

    # Bulk update via SQL (faster for many records)
    cr.execute("""
        UPDATE my_model
        SET new_state = CASE
            WHEN old_state = 'open' THEN 'confirmed'
            WHEN old_state = 'closed' THEN 'done'
            ELSE 'draft'
        END
    """)

    # Or via ORM to trigger compute/onchange
    records = env['my.model'].search([('state', '=', False)])
    records.write({'state': 'draft'})
```

### Drop Old Constraint
```python
def migrate(cr, version):
    # Drop constraint before changing column
    cr.execute("""
        ALTER TABLE my_model
        DROP CONSTRAINT IF EXISTS my_model_name_uniq
    """)
    # The new model will have a new constraint
```

---

## Upgrade Checklist

- [ ] Read official upgrade notes at odoo.com/documentation
- [ ] Check OpenUpgrade (OCA) for community scripts
- [ ] Test on staging FIRST before production
- [ ] Backup database before upgrading
- [ ] Check all custom module dependencies
- [ ] Update `version` in manifest to new version
- [ ] Update deprecated syntax (see breaking changes above)
- [ ] Run: `odoo-bin -u my_module -d mydb`
- [ ] Run all tests: `odoo-bin test -d mydb --test-tags my_module`
