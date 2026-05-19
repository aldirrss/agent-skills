---
name: odoo-owl-version-matrix
description: Version mapping and API compatibility for OWL 1, OWL 2, and OWL 3 migration notes.
---

# OWL Version Matrix (Odoo 14-19+)

## Mapping

| Odoo | OWL | Migration Status |
|------|-----|------------------|
| 14 | OWL 1 | Legacy |
| 15 | OWL 1 | Legacy but common in production |
| 16 | OWL 2 | Modern baseline |
| 17 | OWL 2 | Modern baseline |
| 18 | OWL 2 | Modern baseline |
| 19+ | OWL 3 | Forward compatibility target |

## Source Verification from Local Odoo Code

The following files exist in both trees:

- `community/16/addons/web/static/lib/owl/owl.js`
- `community/18/addons/web/static/lib/owl/owl.js`
- `community/16/addons/web/static/lib/owl/odoo_module.js`
- `community/18/addons/web/static/lib/owl/odoo_module.js`

Both OWL bundles expose:

```javascript
const version = "2.8.2";
```

and both register:

```javascript
odoo.define("@odoo/owl", ...);
```

So the practical baseline for Odoo 16 and 18 in these sources is OWL 2.x.

## API Differences (Practical)

| Topic | OWL 1 (14-15) | OWL 2 (16-18) | OWL 3 Notes (19+) |
|------|----------------|---------------|-------------------|
| Module format | mixed legacy + ES modules | ES modules | ES modules |
| RPC usage | `this.rpc(...)` common | `useService("rpc")` or `useService("orm")` | service-first |
| Hooks import | often via `owl.hooks` object | direct imports from `@odoo/owl` | hook-heavy + functional direction |
| Component style | class components | class components | class still possible, functional emphasized |
| Registry usage | available but less uniform | consistent and central | consistent and central |
| Template style | QWeb/OWL template mix | QWeb with OWL conventions | stricter reactive conventions |

## Odoo 16 Reality Check

In `community/16/addons/web/static/src/views/list/list_controller.js`, Odoo imports OWL directly:

```javascript
import { Component, onMounted, onWillPatch, onWillRender, onWillStart, useEffect, useRef, useState, useSubEnv } from "@odoo/owl";
```

and uses services:

```javascript
this.actionService = useService("action");
this.dialogService = useService("dialog");
```

This is OWL 2 style, not OWL 1 legacy style.

## Safe Compatibility Rules

1. Prefer `@odoo-module` for all new JS files.
2. Do not introduce new `this.rpc` in OWL 2 code.
3. Keep component state in `useState`; avoid ad-hoc mutable globals.
4. Always add `t-key` on `t-foreach`.
5. Keep DOM access behind `useRef` and lifecycle hooks.
6. Keep side effects in lifecycle hooks, not template expressions.

## Version Detection Hint

From `__manifest__.py`, parse:

```python
# Example: 'version': '16.0.1.0.0'
# First number -> Odoo major version (16)
```
