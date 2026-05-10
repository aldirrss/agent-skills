---
name: odoo-migration
description: Migration scripts, upgrade paths, dan breaking changes antar versi Odoo 14-19.
---

# Migration Guide — v14 to v19

## Migration Script Structure

```python
# migrations/16.0.1.1.0/pre-migrate.py
def migrate(cr, version):
    """Jalankan SEBELUM module di-load (pre-migrate)"""
    if not version:
        return  # fresh install, skip
    # Rename column, hapus constraint lama, dll
    cr.execute("ALTER TABLE my_model RENAME COLUMN old_field TO new_field")

# migrations/16.0.1.1.0/post-migrate.py
from odoo import api, SUPERUSER_ID

def migrate(cr, version):
    """Jalankan SETELAH module di-load (post-migrate)"""
    if not version:
        return
    env = api.Environment(cr, SUPERUSER_ID, {})
    # Isi data, recompute, update records
    records = env['my.model'].search([('new_field', '=', False)])
    records.write({'new_field': 'default_value'})
```

---

## Breaking Changes Per Versi

### v14 → v15

```python
# @api.multi DIHAPUS (sudah deprecated di v14)
# ❌ v14 masih jalan:
@api.multi
def action_do(self):
    for rec in self:
        pass

# ✅ v15+: tanpa decorator
def action_do(self):
    for rec in self:
        pass

# create() — ganti ke model_create_multi
@api.model_create_multi
def create(self, vals_list):
    return super().create(vals_list)

# OWL: pindah ke v15 module system
# Ganti: odoo.define('module.Widget', ...) 
# Ke: /** @odoo-module **/ + import statements
```

### v15 → v16

```python
# Python upgrade: 3.8/3.9 → 3.10
# OWL upgrade: 1.x → 2.x

# OWL 2: hooks cara pakai berubah
# v15 (OWL 1):
const { useState, useRef } = owl.hooks;
# v16 (OWL 2):
import { useState, useRef } from "@odoo/owl";

# this.rpc deprecated di v16
# ❌ v15 style:
await this.rpc({ model: 'x', method: 'y', args: [] });
# ✅ v16+:
const rpc = useService("rpc");
await rpc("/web/dataset/call_kw", {...});
# Atau lebih clean:
const orm = useService("orm");
await orm.call("x", "y", []);

# @api.ondelete tersedia stabil di v15+
@api.ondelete(at_uninstall=False)
def _unlink_check(self):
    if self.state != 'draft':
        raise UserError("...")

# make_json_response tersedia di v16+
return request.make_json_response({'result': data})
```

### v16 → v17

```python
# SQL() class tersedia
from odoo.tools import SQL
query = SQL("SELECT id FROM table WHERE name = %s", name)

# Json dan Properties field baru
json_data = fields.Json(string='Data')
properties = fields.Properties(string='Properties',
                               definition='model_id.property_definition')

# _read_group API baru (lebih powerful)
groups = self.env['my.model']._read_group(
    domain=[],
    groupby=['partner_id'],
    aggregates=['amount_total:sum', '__count'],
)

# View: transisi ke inline attrs (kedua masih valid)
# Chatter: mulai pakai <chatter/> tag
```

### v17 → v18

```python
# <list> tag menggantikan <tree>
# ❌ v17-:
# <tree string="Records">
# ✅ v18+:
# <list string="Records">

# aggregator= menggantikan group_operator=
# ❌:
amount = fields.Float(group_operator='sum')
# ✅:
amount = fields.Float(aggregator='sum')

# Inline attrs DIANJURKAN (attrs= masih valid tapi deprecated)
# ✅ v18 style:
# <field name="date_end" invisible="state != 'done'" required="state == 'done'"/>

# Chatter: WAJIB pakai <chatter/> tag (bukan <div class="oe_chatter">)
```

### v18 → v19

```python
# OWL 3.x: functional components tersedia
# Class components masih valid tapi deprecated

# OWL 3 functional component:
import { Component, useState } from "@odoo/owl";

function MyWidget(props) {
    const state = useState({ count: 0 });
    return <div onClick={() => state.count++}>{state.count}</div>;
}

# Python: 3.12+ features tersedia
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

### Add Column dengan Default
```python
def migrate(cr, version):
    # Cek apakah column sudah ada (idempotent)
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

    # Bulk update via SQL (lebih cepat untuk banyak records)
    cr.execute("""
        UPDATE my_model
        SET new_state = CASE
            WHEN old_state = 'open' THEN 'confirmed'
            WHEN old_state = 'closed' THEN 'done'
            ELSE 'draft'
        END
    """)

    # Atau via ORM untuk trigger compute/onchange
    records = env['my.model'].search([('state', '=', False)])
    records.write({'state': 'draft'})
```

### Drop Constraint Lama
```python
def migrate(cr, version):
    # Drop constraint sebelum ubah column
    cr.execute("""
        ALTER TABLE my_model
        DROP CONSTRAINT IF EXISTS my_model_name_uniq
    """)
    # Nanti di model baru akan ada constraint baru
```

---

## Checklist Upgrade

- [ ] Baca official upgrade notes di odoo.com/documentation
- [ ] Cek OpenUpgrade (OCA) untuk script community
- [ ] Test di staging DULU sebelum production
- [ ] Backup database sebelum upgrade
- [ ] Cek semua custom module dependencies
- [ ] Update `version` di manifest ke versi baru
- [ ] Update syntax yang deprecated (lihat breaking changes di atas)
- [ ] Jalankan: `odoo-bin -u my_module -d mydb`
- [ ] Jalankan semua tests: `odoo-bin test -d mydb --test-tags my_module`
