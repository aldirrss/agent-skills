---
name: odoo-owl-integration-patterns
description: Odoo integration patterns for assets, registries, client actions, field widgets, and services.
---

# Odoo Integration Patterns for OWL

## Asset Registration

```python
# __manifest__.py
{
    "assets": {
        "web.assets_backend": [
            "my_module/static/src/js/**/*.js",
            "my_module/static/src/xml/**/*.xml",
            "my_module/static/src/scss/**/*.scss",
        ],
    },
}
```

Rules:
1. Keep JS/XML/SCSS under `static/src`.
2. Ensure template files are included in bundles.
3. Avoid duplicate paths across bundles unless intentional.

## Source-Verified Integration Notes

From local Odoo sources:

- `community/16/addons/web/static/src/views/onboarding_banner.js` uses inline `xml` template + service wiring.
- `community/16/addons/web/static/src/views/list/list_controller.js` uses OWL imports and view hooks.
- `community/18/addons/web/static/src/views/list/list_controller.js` keeps OWL imports but updates view/model hook stack.

This means custom modules should follow `@odoo/owl` + `@web/*` integration style for both 16 and 18.

## Registry Patterns

```javascript
/** @odoo-module **/
import { registry } from "@web/core/registry";
import { PartnerPanel } from "./partner_panel";

registry.category("actions").add("my_module.partner_panel_action", PartnerPanel);
```

Common categories:
- `actions`
- `fields`
- `views`
- `services`

Practical check before shipping:
1. Registry key is unique and namespaced (`my_module.*`).
2. Correct category (`fields` vs `actions`) is used.
3. Asset bundle actually contains JS + XML (and SCSS if needed).

## Field Widget Pattern

```javascript
registry.category("fields").add("my_widget", {
    component: PartnerPanel,
    supportedTypes: ["char", "many2one"],
});
```

## Service Usage Pattern

```javascript
import { useService } from "@web/core/utils/hooks";

setup() {
    this.orm = useService("orm");
    this.action = useService("action");
    this.dialog = useService("dialog");
    this.notification = useService("notification");
}
```

## Integration Anti-Patterns

- Registering a component in wrong category.
- Asset path exists but missing in manifest bundle.
- Calling model methods from UI that should be server actions.
- Hardcoding URLs where service/ORM abstractions exist.
- Copying Odoo 16 helper names into Odoo 18 `orm_service` commands.
