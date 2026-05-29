---
name: odoo-version-matrix
description: Critical API differences table for Odoo versions 14 through 19. Load this first when version is detected.
---

# Odoo Version Matrix — Critical Differences v14–v19

## Python & Core

| Aspect | v14 | v15 | v16 | v17 | v18 | v19 |
|--------|-----|-----|-----|-----|-----|-----|
| Python | 3.8 | 3.8–3.9 | 3.10 | 3.11 | 3.12 | 3.12+ |
| PostgreSQL | 10–13 | 13 | 14 | 15 | 16 | 16+ |
| OWL version | 1.x | 1.x | 2.x | 2.x | 2.x | 3.x |

---

## Views & XML

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| List view tag | `<tree>` | `<tree>` | `<tree>` | `<tree>` | `<list>` | `<list>` |
| Dynamic visibility | `attrs=` | `attrs=` | `attrs=` | `attrs=`/inline | inline | inline |
| Dynamic readonly | `attrs=` | `attrs=` | `attrs=` | `attrs=`/inline | inline | inline |
| Dynamic required | `attrs=` | `attrs=` | `attrs=` | `attrs=`/inline | inline | inline |
| Status bar | `widget="statusbar"` | same | same | same | same | same |
| Chatter position | `<div class="oe_chatter">` | same | same | `<chatter/>` | `<chatter/>` | `<chatter/>` |

### View Syntax Examples Per Version

```xml
<!-- v14, v15, v16: MUST use attrs -->
<field name="date_end" attrs="{'invisible': [('state', '!=', 'done')], 'required': [('state', '=', 'done')]}"/>

<!-- v17: transition — both are valid -->
<field name="date_end" attrs="{'invisible': [('state', '!=', 'done')]}"/>
<field name="date_end" invisible="state != 'done'"/>  <!-- also valid -->

<!-- v18, v19: inline directly -->
<field name="date_end" invisible="state != 'done'" required="state == 'done'"/>
```

---

## ORM & Python API

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| `@api.multi` | deprecated | **REMOVED** | — | — | — | — |
| `@api.model_create_multi` | yes | yes | yes | yes | yes | yes |
| `@api.ondelete` | — | yes | yes | yes | yes | yes |
| `_read_group` (new API) | — | — | — | yes | yes | yes |
| `read_group` return | list of dicts | same | same | same | same | same |
| `flush_recordset` | — | — | ada | ada | ada | ada |
| `env.flush_all()` | — | — | ada | ada | ada | ada |

### create() Pattern

```python
# v14+: single dict (legacy, still works)
record = self.env['model'].create({'name': 'x'})

# v15+: @api.model_create_multi (preferred, handles batch)
@api.model_create_multi
def create(self, vals_list):
    # vals_list is a list of dicts
    return super().create(vals_list)
```

---

## SQL & Database

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| Raw SQL | `cr.execute("...", (p,))` | same | same | `SQL()` class available | `SQL()` preferred | same |
| `SQL()` helper | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `execute_query_dict` | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `cr.dictfetchall()` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

```python
# v14, v15, v16 — ONLY way:
self.env.cr.execute("SELECT id FROM sale_order WHERE state = %s", ('done',))
rows = self.env.cr.dictfetchall()

# v17+ — new way (safer):
from odoo.tools import SQL
self.env.cr.execute(SQL("SELECT id FROM sale_order WHERE state = %s", 'done'))
rows = self.env.cr.dictfetchall()
```

---

## Fields

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| `group_operator` | ✅ | ✅ | ✅ | ✅ | `aggregator=` | `aggregator=` |
| `Html` field | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `Json` field | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `Properties` field | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| `Image` field | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Security

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| `ir.model.access.csv` | required | required | required | required | required | required |
| `@api.ondelete` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `unlink()` override | ✅ | still valid | still valid | less recommended | less recommended | less recommended |

---

## Controllers

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| `@http.route` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `type='json'` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `make_json_response` | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| `request.make_response` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## OWL / JavaScript

| Feature | v14 | v15 | v16 | v17 | v18 | v19 |
|---------|-----|-----|-----|-----|-----|-----|
| OWL version | 1.x | 1.x | 2.x | 2.x | 2.x | 3.x |
| `this.rpc()` | ✅ | ✅ | deprecated | ❌ | ❌ | ❌ |
| `useService('rpc')` | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `useState` hook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `useRef` hook | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Class components | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Functional components | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Asset bundles | legacy | new system | new system | new system | new system | new system |

---

## Migration Folder Naming

```
v14: migrations/14.0.x.x.x/
v15: migrations/15.0.x.x.x/
v16: migrations/16.0.x.x.x/
v17: migrations/17.0.x.x.x/
v18: migrations/18.0.x.x.x/
v19: migrations/19.0.x.x.x/
```

---

## Quick Version Identification from manifest

```python
# __manifest__.py
{
    'version': '16.0.1.0.0',  # → Odoo 16
    'version': '18.0.2.1.0',  # → Odoo 18
}
```
