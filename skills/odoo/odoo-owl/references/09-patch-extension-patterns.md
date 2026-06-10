---
name: odoo-owl-patch-extension-patterns
description: Complete guide to the patch() system in Odoo OWL 2 — extending core components, templates, services, and field widgets with safe unpatch in tests.
---

# Patch and Extension Patterns (Odoo OWL 2)

## Decision Tree: When to Use What

```
Need to customize existing Odoo behavior?
│
├─ Modify an OWL component's method/lifecycle?
│   └─ patch(Component.prototype, { ... })
│
├─ Replace or extend an OWL component's template?
│   ├─ Add/remove/modify elements → XML t-inherit xpath (no JS needed)
│   └─ Full template replacement → patch(Component, { template: "new.Name" })
│
├─ Override a field widget (CharField, Many2OneField, etc.)?
│   └─ patch(OriginalWidget.prototype, { ... }) + optionally new template
│
├─ Override a service method?
│   └─ patch(serviceObject, { ... }) — careful: service is a plain object
│
├─ Create a new variant of a component for one context?
│   └─ Subclass (extends) — not patch; use registry to select per context
│
└─ Replace component in registry entirely?
    └─ registry.category("fields").add("key", newWidget, { force: true })
```

---

## 1. Basic Method Patch

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { ListController } from "@web/views/list/list_controller";

patch(ListController.prototype, {
    setup() {
        super.setup();
        this.myExtra = "initialized";
    },

    async openRecord(record) {
        console.log("before open", record.resId);
        await super.openRecord(record);
    },
});
```

Rules:
- Always call `super.method()` unless you intentionally replace the full behavior.
- Patch in `setup()` to wire additional state/services.
- One patch per file for clarity.

---

## 2. Template Extension via XML (Preferred for UI Changes)

Do NOT use JS patch to extend templates when you only need to add/move/remove elements.
Use XML xpath inheritance instead — no JS change needed.

```xml
<!-- my_module/static/src/xml/list_controller_extension.xml -->
<templates xml:space="preserve">
    <t t-name="my_module.ListControllerExtension"
       t-inherit="web.ListController"
       t-inherit-mode="extension">

        <!-- Add a button after the existing control buttons -->
        <xpath expr="//div[hasclass('o_control_panel_actions')]" position="inside">
            <button class="btn btn-primary" t-on-click="openMyAction">
                My Action
            </button>
        </xpath>
    </t>
</templates>
```

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { ListController } from "@web/views/list/list_controller";

patch(ListController.prototype, {
    async openMyAction() {
        await this.action.doAction("my_module.my_action");
    },
});
```

---

## 3. Full Template Replacement

Use only when the inherited template is so different that xpath surgery would be brittle.

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { KanbanRecord } from "@web/views/kanban/kanban_record";

patch(KanbanRecord, {
    template: "my_module.CustomKanbanRecord",
});
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.CustomKanbanRecord">
        <!-- completely new layout — must re-implement all needed slots -->
        <div class="o_kanban_record my_custom_card">
            <span t-esc="props.record.data.name"/>
        </div>
    </t>
</templates>
```

Warning: full replacement breaks if the base component relies on internal template sub-templates.
Prefer xpath extension unless the base template structure conflicts fundamentally.

---

## 4. Patching a Core Field Widget

### Extend CharField display

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { CharField } from "@web/views/fields/char/char_field";

patch(CharField.prototype, {
    setup() {
        super.setup();
        this.myState = useState({ highlighted: false });
    },

    get displayValue() {
        const base = super.displayValue;
        return this.props.record.data.is_vip ? `★ ${base}` : base;
    },
});
```

### Extend Many2OneField with extra button

```xml
<t t-name="my_module.Many2OneFieldExtension"
   t-inherit="web.Many2OneField"
   t-inherit-mode="extension">
    <xpath expr="//div[hasclass('o_field_many2one')]" position="inside">
        <button t-if="!props.readonly"
                class="btn btn-sm btn-secondary ms-1"
                t-on-click="openQuickInfo">
            Info
        </button>
    </xpath>
</t>
```

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { Many2OneField } from "@web/views/fields/many2one/many2one_field";

patch(Many2OneField, {
    template: "my_module.Many2OneFieldExtension",
});

patch(Many2OneField.prototype, {
    setup() {
        super.setup();
        this.dialog = useService("dialog");
    },

    async openQuickInfo() {
        const id = this.props.record.data[this.props.name]?.[0];
        if (!id) return;
        this.dialog.add(QuickInfoDialog, { resId: id });
    },
});
```

---

## 5. Patching a Service

Services in Odoo OWL 2 are plain objects returned from `start()`. Patch the instance, not the definition.

```javascript
/** @odoo-module **/
import { registry } from "@web/core/registry";

const originalNotificationService = registry.category("services").get("notification");

const patchedNotificationService = {
    ...originalNotificationService,
    start(env, deps) {
        const service = originalNotificationService.start(env, deps);
        return {
            ...service,
            add(message, options = {}) {
                // intercept — add custom logging
                console.log("[notification]", message, options.type);
                return service.add(message, options);
            },
        };
    },
};

registry.category("services").add("notification", patchedNotificationService, { force: true });
```

Use `{ force: true }` to overwrite without error.
Avoid patching critical services (`orm`, `rpc`) unless absolutely necessary — prefer a wrapper approach.

---

## 6. Multiple Patches — Chaining Order

```javascript
// File: my_module_a/static/src/js/list_patch.js
patch(ListController.prototype, {
    setup() {
        super.setup();
        this.featureA = true;
    },
});

// File: my_module_b/static/src/js/list_patch.js
patch(ListController.prototype, {
    setup() {
        super.setup(); // calls my_module_a patch → calls original
        this.featureB = true;
    },
});
```

Patch order = asset loading order (manifest order).
Both modules calling `super.setup()` will chain correctly as long as each calls super.
Do NOT assume your patch is first or last — write defensively.

---

## 7. Unpatch in Tests (Critical)

Every patch applied in a test must be unpatched after the test.

```javascript
import { patch } from "@web/core/utils/patch";
import { ListController } from "@web/views/list/list_controller";

let unpatch;

QUnit.module("ListController patch", {
    beforeEach() {
        unpatch = patch(ListController.prototype, {
            setup() {
                super.setup();
                this.testFlag = true;
            },
        });
    },
    afterEach() {
        unpatch();
    },
});

QUnit.test("test flag is set", async (assert) => {
    // ... mount component, assert this.testFlag
});
```

Forgetting `unpatch()` is the most common cause of cross-test pollution in Odoo frontend tests.

---

## 8. Patching KanbanController and KanbanRecord

```javascript
/** @odoo-module **/
import { patch } from "@web/core/utils/patch";
import { KanbanController } from "@web/views/kanban/kanban_controller";
import { KanbanRecord } from "@web/views/kanban/kanban_record";

// Extend controller: add action button
patch(KanbanController.prototype, {
    setup() {
        super.setup();
        this.myService = useService("my_service");
    },

    async runBulkAction() {
        const selectedIds = [...this.model.root.selection].map((r) => r.resId);
        await this.myService.processBatch(selectedIds);
        await this.model.root.load();
        this.render(true);
    },
});

// Extend record card: add status badge
patch(KanbanRecord, {
    template: "my_module.ExtendedKanbanRecord",
});
```

---

## 9. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Patch without calling `super` | Silently drops original behavior | Always call `super.method()` unless replacing |
| Patch `.prototype` for static props (template) | No effect — static props are on the class | `patch(Component, { template: "..." })` |
| Patch class for instance methods | No effect | `patch(Component.prototype, { myMethod() {} })` |
| Forget unpatch in tests | Test pollution, flaky suite | Always unpatch in `afterEach` |
| Use `patch()` when registry override is correct | Tight coupling to internals | Prefer registry `add(..., { force: true })` |
| Chain side effects in patch without checking null | Crash when component mounts in unexpected context | Guard with `if (!this.env.xyz) return` |
| Full template replacement for minor UI changes | Breaks on Odoo upgrades | Use xpath extension instead |
