---
name: odoo-owl-components
description: OWL component patterns per versi — OWL 1.x (v14-v15), OWL 2.x (v16-v18), OWL 3.x (v19).
---

# OWL Components — Per Version

## Version Matrix OWL

| Feature | v14 (OWL 1) | v15 (OWL 1) | v16-18 (OWL 2) | v19 (OWL 3) |
|---------|------------|------------|----------------|-------------|
| `this.rpc()` | ✅ | ✅ | deprecated | ❌ |
| `useService('rpc')` | ❌ | ✅ | ✅ | ✅ |
| `useState` | ✅ | ✅ | ✅ | ✅ |
| `useRef` | ✅ | ✅ | ✅ | ✅ |
| `onWillStart` | ✅ | ✅ | ✅ | ✅ |
| `onMounted` | ✅ | ✅ | ✅ | ✅ |
| Class components | ✅ | ✅ | ✅ | deprecated |
| Functional components | ❌ | ❌ | ❌ | ✅ |
| `useComponent` | ❌ | ❌ | ❌ | ✅ |

---

## OWL 2.x Component (v16, v17, v18)

```javascript
/** @odoo-module **/
import { Component, useState, useRef, onWillStart, onMounted } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { registry } from "@web/core/registry";

export class MyWidget extends Component {
    static template = "my_module.MyWidget";
    static props = {
        record: { type: Object },
        readonly: { type: Boolean, optional: true },
    };

    setup() {
        this.rpc = useService("rpc");
        this.orm = useService("orm");
        this.notification = useService("notification");
        this.dialog = useService("dialog");

        this.state = useState({
            isLoading: false,
            data: [],
        });

        this.inputRef = useRef("myInput");

        onWillStart(async () => {
            await this._loadData();
        });

        onMounted(() => {
            // DOM ready
            if (this.inputRef.el) {
                this.inputRef.el.focus();
            }
        });
    }

    async _loadData() {
        this.state.isLoading = true;
        try {
            // Cara 1: orm service (lebih type-safe)
            this.state.data = await this.orm.searchRead(
                "my.model",
                [["state", "=", "active"]],
                ["name", "amount"],
                { limit: 10 }
            );

            // Cara 2: rpc langsung ke method
            const result = await this.rpc("/web/dataset/call_kw", {
                model: "my.model",
                method: "get_summary",
                args: [],
                kwargs: { context: {} },
            });
        } catch (error) {
            this.notification.add("Failed to load data", { type: "danger" });
        } finally {
            this.state.isLoading = false;
        }
    }

    async onButtonClick() {
        const result = await this.orm.call(
            "my.model",
            "action_do_something",
            [this.props.record.id],
        );
        if (result.type === "ir.actions.act_window") {
            // handle action
        }
    }
}

// Register sebagai field widget
registry.category("fields").add("my_widget", {
    component: MyWidget,
    supportedTypes: ["char", "many2one"],
});

// Register sebagai action
registry.category("actions").add("my_action", MyWidget);
```

---

## OWL Template (XML)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<templates xml:space="preserve">
    <t t-name="my_module.MyWidget">
        <div class="my-widget">
            <!-- Loading state -->
            <t t-if="state.isLoading">
                <div class="o_loading_spinner"/>
            </t>

            <!-- Content -->
            <t t-else="">
                <div class="my-widget-header">
                    <h3 t-esc="props.record.data.name"/>
                </div>

                <!-- List rendering -->
                <ul>
                    <t t-foreach="state.data" t-as="item" t-key="item.id">
                        <li>
                            <span t-esc="item.name"/>
                            <span t-esc="item.amount"/>
                        </li>
                    </t>
                </ul>

                <!-- Event binding -->
                <button class="btn btn-primary" t-on-click="onButtonClick">
                    Action
                </button>

                <!-- Input dengan ref -->
                <input t-ref="myInput" type="text" class="o_input"/>

                <!-- Conditional class -->
                <div t-attf-class="badge {{ state.isActive ? 'bg-success' : 'bg-danger' }}">
                    <t t-esc="state.isActive ? 'Active' : 'Inactive'"/>
                </div>
            </t>
        </div>
    </t>
</templates>
```

---

## OWL 1.x (v14, v15) — Perbedaan

```javascript
// v14: legacy import
odoo.define('my_module.MyWidget', function(require) {
    const { Component } = owl;
    const { useState } = owl.hooks;

    class MyWidget extends Component {
        // ...
        async _loadData() {
            // v14-v15: this.rpc masih valid
            const result = await this.rpc({
                model: 'my.model',
                method: 'get_data',
                args: [],
            });
        }
    }
    return MyWidget;
});

// v15: sudah pakai module system tapi masih OWL 1
/** @odoo-module **/
import { Component, useState, hooks } from "@odoo/owl";
const { useRef, onMounted } = hooks;  // v15: hooks dari hooks object

// RPC di v15
import { useService } from "@web/core/utils/hooks";
// this.rpc = useService("rpc");  ← v15 sudah ada ini
```

---

## Asset Registration (v15+)

```python
# __manifest__.py
{
    'assets': {
        'web.assets_backend': [
            'my_module/static/src/js/my_widget.js',
            'my_module/static/src/xml/my_widget.xml',
            'my_module/static/src/scss/my_widget.scss',
        ],
        'web.assets_frontend': [
            'my_module/static/src/js/portal_widget.js',
        ],
    },
}
```

---

## ORM Service (v16+)

```javascript
// orm service — lebih clean dari raw rpc
const orm = useService("orm");

// search
const records = await orm.search("my.model", [["state", "=", "draft"]]);

// searchRead
const data = await orm.searchRead(
    "my.model",
    [["active", "=", true]],
    ["name", "state", "partner_id"],
    { limit: 50, order: "date desc" }
);

// create
const id = await orm.create("my.model", [{ name: "New" }]);

// write
await orm.write("my.model", [id], { state: "confirmed" });

// unlink
await orm.unlink("my.model", [id]);

// call method
const result = await orm.call("my.model", "action_confirm", [[id]]);

// read_group
const groups = await orm.readGroup(
    "my.model",
    [],
    ["partner_id", "amount_total:sum"],
    ["partner_id"]
);
```
