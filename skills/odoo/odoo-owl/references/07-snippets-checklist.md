---
name: odoo-owl-snippets-checklist
description: Reusable snippets and comprehensive pre-merge quality checklist for OWL code in Odoo 16-18.
---

# OWL Snippets and Pre-Merge Checklist

## Snippet: Safe Async Loader with Sequence Guard

```javascript
async loadData() {
    const seq = (this._seq = (this._seq || 0) + 1);
    this.state.loading = true;
    this.state.error = null;
    try {
        const data = await this.orm.searchRead("my.model", [], ["name"], { limit: 50 });
        if (seq !== this._seq) return;
        this.state.rows = data;
    } catch (error) {
        if (seq !== this._seq) return;
        this.state.error = error;
        this.notification.add("Failed to load data", { type: "danger" });
    } finally {
        if (seq === this._seq) this.state.loading = false;
    }
}
```

## Snippet: Action Trigger

```javascript
async openRecord(id) {
    await this.action.doAction({
        type: "ir.actions.act_window",
        res_model: "my.model",
        res_id: id,
        views: [[false, "form"]],
        target: "current",
    });
}
```

## Snippet: Manifest Assets

```python
"assets": {
    "web.assets_backend": [
        "my_module/static/src/js/my_component.js",
        "my_module/static/src/xml/my_component.xml",
        "my_module/static/src/scss/my_component.scss",
    ],
}
```

## Snippet: Version-Safe ORM x2many Commands

```javascript
// Odoo 16 style (community/16 core/orm_service.js)
const cmds16 = {
    unlink: [3, id, false],
    link: [4, id, false],
    clear: [5, false, false],
    set: [6, false, ids],
};

// Odoo 18 style (community/18 core/orm_service.js)
const cmds18 = {
    forget: [3, id, false],
    linkTo: [4, id, false],
    deleteAll: [5, false, false],
    replaceWith: [6, false, ids],
};
```

## Snippet: Safe patch() with Unpatch in Test

```javascript
// Production:
import { patch } from "@web/core/utils/patch";
patch(SomeComponent.prototype, {
    setup() {
        super.setup();
        this.extra = useService("my_service");
    },
});

// Test:
let unpatch;
QUnit.module("SomeComponent", {
    beforeEach() { unpatch = patch(SomeComponent.prototype, { ... }); },
    afterEach()  { unpatch(); },
});
```

## Snippet: Confirmation Before Destructive Action

```javascript
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

async onDelete() {
    this.dialog.add(ConfirmationDialog, {
        title: "Delete",
        body: "This cannot be undone.",
        confirm: async () => {
            await this.orm.unlink("my.model", [this.resId]);
            await this.model.root.load();
        },
        cancel: () => {},
    });
}
```

## Snippet: useBus Cross-Component Event

```javascript
// Emitter:
this.env.bus.trigger("my_module:data_changed", { ids: [1, 2, 3] });

// Listener (in setup()):
useBus(this.env.bus, "my_module:data_changed", async ({ detail }) => {
    await this.loadData();
});
```

## Snippet: Field Widget Read/Write Value

```javascript
// Read
const value = this.props.record.data[this.props.name];

// Write (triggers dirty tracking)
await this.props.record.update({ [this.props.name]: newValue });
```

## Snippet: Template xpath Extension

```xml
<t t-name="my_module.ExtendListController"
   t-inherit="web.ListController"
   t-inherit-mode="extension">
    <xpath expr="//div[hasclass('o_control_panel_actions')]" position="inside">
        <button class="btn btn-primary" t-on-click="myAction">Custom</button>
    </xpath>
</t>
```

---

## Pre-Merge Quality Checklist

### Version & API

- [ ] Target Odoo version identified from `__manifest__.py`
- [ ] Service usage follows version-safe patterns (`useModel` vs `useModelWithSampleData`)
- [ ] ORM x2many command constants match target version (16 vs 18 names differ)
- [ ] No legacy OWL 1 patterns in OWL 2 modules (no `this.rpc`, no `owl.hooks.*`)

### Component Architecture

- [ ] `setup()` used instead of constructor
- [ ] Lifecycle responsibilities clearly separated: wire in setup, async in willStart, DOM in mounted, cleanup in willUnmount
- [ ] Renderer is a pure display component (no service calls, no ORM)
- [ ] Business logic stays in Python; component only handles UI state

### State and Templates

- [ ] State shape uses `{ loading, error, data }` pattern
- [ ] All `t-foreach` loops have stable `t-key`
- [ ] No side effects in template expressions
- [ ] Loading, error, and success branches all present in template

### Service Usage

- [ ] `useService("orm")` used for model CRUD (not raw `rpc` for standard ops)
- [ ] `useService("dialog")` used for confirmation/modal (not `window.confirm`)
- [ ] Errors surfaced to user via `notification` service

### patch() Usage

- [ ] `super.method()` called unless intentionally replacing full behavior
- [ ] Template changes use xpath extension (not full template replacement) unless justified
- [ ] All patches unpatched in `afterEach` of tests

### Field Widgets

- [ ] `props.readonly` checked — both edit and readonly modes implemented
- [ ] Value read via `props.record.data[props.name]`
- [ ] Value written via `props.record.update({ [props.name]: value })`
- [ ] `standardFieldProps` spread into `static props`
- [ ] `supportedTypes` declared in registry entry

### Dialog / Wizard

- [ ] `close` prop NOT passed manually (injected by dialog service)
- [ ] Destructive actions use `ConfirmationDialog`
- [ ] Wizard uses `target: "new"` in doAction for modal behavior
- [ ] `onClose` or `onRecordSaved` callback passed for post-dialog reload

### Bus / Env

- [ ] `useBus` used instead of manual `addEventListener` on bus
- [ ] `useBus` called unconditionally in `setup()` (not inside `if`)
- [ ] Bus event names namespaced with module name (`my_module:event_name`)
- [ ] `useChildSubEnv` used (not `useSubEnv`) when injecting context into subtree only

### Registry and Assets

- [ ] Registry key is unique and module-namespaced
- [ ] Correct registry category used (`fields` vs `actions` vs `views` vs `services`)
- [ ] Asset manifest includes all required JS + XML (+ SCSS if needed)
- [ ] Template names are unique and module-namespaced

### Cleanup and Performance

- [ ] Timers/listeners cleaned up in `onWillUnmount`
- [ ] High-frequency input debounced before triggering server calls
- [ ] No expensive computation inside template expressions
- [ ] Stale async requests guarded with sequence token
