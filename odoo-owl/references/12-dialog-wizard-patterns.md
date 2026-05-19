---
name: odoo-owl-dialog-wizard-patterns
description: Dialog and wizard patterns in Odoo OWL 2 — useService("dialog"), Component dialogs, model-backed wizards, confirmation flows, and nested dialogs.
---

# Dialog and Wizard Patterns (Odoo OWL 2)

## Decision Tree: Which Dialog Pattern?

```
Need to show a modal to the user?
│
├─ Simple yes/no confirmation?
│   └─ ConfirmationDialog from @web/core/confirmation_dialog/confirmation_dialog
│
├─ Display read-only info in a modal?
│   └─ Custom Component wrapped in Dialog base
│
├─ Collect input from user (no model save)?
│   └─ Custom Component + Dialog base + local useState
│
├─ Wizard backed by a transient model (res.TransientModel)?
│   └─ FormViewDialog or doAction with target: "new"
│
└─ Open a full form view as a modal?
    └─ action.doAction with target: "new"
```

---

## 1. Dialog Service Basics

```javascript
setup() {
    this.dialog = useService("dialog");
}

// Open a dialog:
this.dialog.add(MyDialogComponent, props, {
    onClose: () => this.reload(),
});
```

`dialog.add` returns a close function:

```javascript
const close = this.dialog.add(MyDialogComponent, { title: "Info" });
// programmatic close:
close();
```

---

## 2. Confirmation Dialog

```javascript
/** @odoo-module **/
import { useService } from "@web/core/utils/hooks";
import { ConfirmationDialog } from "@web/core/confirmation_dialog/confirmation_dialog";

// In setup():
this.dialog = useService("dialog");

// Usage:
async onDeleteClick() {
    this.dialog.add(ConfirmationDialog, {
        title: "Delete Record",
        body: "This action cannot be undone. Continue?",
        confirm: async () => {
            await this.orm.unlink("my.model", [this.props.recordId]);
            this.notification.add("Record deleted", { type: "success" });
        },
        cancel: () => {},
    });
}
```

---

## 3. Custom Info Dialog (Read-only)

```javascript
/** @odoo-module **/
import { Component } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class PartnerInfoDialog extends Component {
    static template = "my_module.PartnerInfoDialog";
    static components = { Dialog };
    static props = {
        close: { type: Function },    // injected by dialog service
        partner: { type: Object },
    };
}
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.PartnerInfoDialog">
        <Dialog title="'Partner Info'" size="'md'">
            <div class="o_partner_info">
                <p><strong>Name:</strong> <t t-esc="props.partner.name"/></p>
                <p><strong>Email:</strong> <t t-esc="props.partner.email"/></p>
            </div>
            <!-- Footer slot -->
            <t t-set-slot="footer">
                <button class="btn btn-secondary" t-on-click="props.close">Close</button>
            </t>
        </Dialog>
    </t>
</templates>
```

```javascript
// Open it:
this.dialog.add(PartnerInfoDialog, {
    partner: { name: "Acme Corp", email: "info@acme.com" },
});
```

The `close` prop is **injected automatically** by the dialog service — do not pass it manually.

---

## 4. Input Dialog (Collect Data)

```javascript
/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";

export class RenameDialog extends Component {
    static template = "my_module.RenameDialog";
    static components = { Dialog };
    static props = {
        close: { type: Function },
        currentName: { type: String },
        onConfirm: { type: Function },
    };

    setup() {
        this.state = useState({ name: this.props.currentName });
    }

    async confirm() {
        if (!this.state.name.trim()) return;
        await this.props.onConfirm(this.state.name.trim());
        this.props.close();
    }
}
```

```xml
<t t-name="my_module.RenameDialog">
    <Dialog title="'Rename'" size="'sm'">
        <div class="o_rename_form">
            <label>New Name</label>
            <input class="form-control"
                   t-model="state.name"
                   t-on-keydown="(ev) => ev.key === 'Enter' && confirm()"/>
        </div>
        <t t-set-slot="footer">
            <button class="btn btn-primary" t-on-click="confirm">Save</button>
            <button class="btn btn-secondary ms-1" t-on-click="props.close">Cancel</button>
        </t>
    </Dialog>
</t>
```

```javascript
// Open it:
this.dialog.add(RenameDialog, {
    currentName: record.name,
    onConfirm: async (newName) => {
        await this.orm.write("my.model", [record.id], { name: newName });
        await this.model.root.load();
    },
});
```

---

## 5. Wizard Backed by Transient Model

For complex wizards with server-side state, open a FormView targeting the wizard model:

```javascript
async openImportWizard() {
    await this.action.doAction({
        type: "ir.actions.act_window",
        res_model: "my.import.wizard",
        views: [[false, "form"]],
        target: "new",                  // opens as modal dialog
        context: {
            default_partner_id: this.props.record.resId,
        },
    });
}
```

The wizard's form view renders inside a dialog. On save/close, the dialog closes automatically.

---

## 6. FormViewDialog (Direct Component Usage)

For cases where you need to embed a full form view inside a dialog programmatically:

```javascript
/** @odoo-module **/
import { useService } from "@web/core/utils/hooks";
import { FormViewDialog } from "@web/views/view_dialogs/form_view_dialog";

setup() {
    this.dialog = useService("dialog");
}

openPartnerForm(partnerId) {
    this.dialog.add(FormViewDialog, {
        resModel: "res.partner",
        resId: partnerId,
        title: "Edit Partner",
        onRecordSaved: async () => {
            await this.model.root.load();
        },
    });
}
```

---

## 7. Select Dialog (List in Modal)

```javascript
import { SelectCreateDialog } from "@web/views/view_dialogs/select_create_dialog";

openPartnerSelector() {
    this.dialog.add(SelectCreateDialog, {
        resModel: "res.partner",
        title: "Select Partner",
        multiSelect: false,
        onSelected: async (records) => {
            const [selected] = records;
            await this.props.record.update({
                partner_id: [selected.id, selected.display_name],
            });
        },
    });
}
```

---

## 8. Dialog Size Options

```xml
<!-- Available sizes for Dialog component -->
<Dialog size="'sm'"/>    <!-- small -->
<Dialog size="'md'"/>    <!-- medium (default) -->
<Dialog size="'lg'"/>    <!-- large -->
<Dialog size="'xl'"/>    <!-- extra large (full-ish) -->
```

---

## 9. Nested Dialogs

Avoid nesting dialogs more than 2 levels deep. If a dialog needs to trigger another dialog, inject the dialog service into the child component via props or subEnv:

```javascript
// Pass dialog service down via subEnv
import { useChildSubEnv } from "@odoo/owl";

setup() {
    useChildSubEnv({ dialog: useService("dialog") });
}
```

Or pass an `onTriggerChild` callback prop from the parent dialog.

---

## 10. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Manually pass `close` prop when calling `dialog.add` | `close` is injected — causes duplicate/conflicting close calls | Never pass `close` manually |
| Use `window.confirm()` / `window.alert()` | Blocks JS thread, looks non-native in Odoo | Use `ConfirmationDialog` |
| Open wizard with `target: "current"` expecting modal | Replaces the current view instead of modal | Use `target: "new"` for wizard modals |
| Dialog component without `Dialog` base wrapper | No Odoo styling, no backdrop, no focus trap | Always wrap in `Dialog` component |
| Use dialog for destructive actions without confirmation | Bad UX | Always use `ConfirmationDialog` for destructive actions |
| Forget `onClose` callback for post-dialog reload | Parent view stays stale after dialog closes | Always pass `onClose` or `onRecordSaved` |
