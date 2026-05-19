---
name: odoo-owl-1-guide
description: Comprehensive OWL 1 guide for legacy Odoo 14-15 codebases and mixed-version migration scenarios.
---

# OWL 1 Guide (Odoo 14-15 Legacy Track)

This guide is intentionally detailed for teams maintaining legacy modules while moving toward OWL 2.

> Scope boundary:
> local source verification in this workspace shows Odoo 16 and 18 are OWL 2 baseline.
> Use this guide for true OWL 1 code only (typically Odoo 14/15 legacy modules).

## 1. How to Confirm You Are Really in OWL 1

You are in OWL 1 territory when most of these are true:

1. module wrapper is `odoo.define(...)`
2. global `owl` object is used (`const { Component } = owl`)
3. hooks are accessed from `owl.hooks`
4. request layer uses `this.rpc(...)` pattern heavily
5. code does not follow `@web/*` service-first conventions consistently

If file imports look like this:

```javascript
import { Component, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
```

then you should default to OWL 2 guidance.

## 2. Recommended OWL 1 Module Layout

```text
my_module/
└── static/src/
    ├── js/
    │   └── my_widget.js
    ├── xml/
    │   └── my_widget.xml
    └── scss/
        └── my_widget.scss
```

Manifest snippet:

```python
"assets": {
    "web.assets_backend": [
        "my_module/static/src/js/my_widget.js",
        "my_module/static/src/xml/my_widget.xml",
        "my_module/static/src/scss/my_widget.scss",
    ],
}
```

## 3. Baseline OWL 1 Component Pattern

```javascript
odoo.define("my_module.MyWidget", function (require) {
    "use strict";

    const { Component } = owl;
    const { useState, onMounted, onWillUnmount } = owl.hooks;
    const rpc = require("web.rpc");

    class MyWidget extends Component {
        setup() {
            this.state = useState({
                loading: false,
                error: null,
                rows: [],
                query: "",
            });
            this._isDestroyed = false;
        }

        async willStart() {
            await this.loadRows();
        }

        async loadRows() {
            this.state.loading = true;
            this.state.error = null;
            try {
                const rows = await rpc.query({
                    model: "my.model",
                    method: "search_read",
                    args: [[["active", "=", true]], ["name", "state"]],
                });
                if (!this._isDestroyed) {
                    this.state.rows = rows;
                }
            } catch (error) {
                if (!this._isDestroyed) {
                    this.state.error = error;
                }
            } finally {
                if (!this._isDestroyed) {
                    this.state.loading = false;
                }
            }
        }

        onInput(ev) {
            this.state.query = ev.target.value || "";
        }
    }

    MyWidget.template = "my_module.MyWidget";
    MyWidget.props = ["*"];
    return MyWidget;
});
```

## 4. Lifecycle Rules That Prevent Most Bugs

1. `setup()` initializes state and local flags only.
2. async data prefetch should happen in `willStart` / `onWillStart`.
3. direct DOM access belongs in `onMounted`.
4. remove listeners/timers in `onWillUnmount`.
5. never run heavy async side effects from template expressions.

## 5. Template Discipline (Legacy but Safe)

```xml
<templates xml:space="preserve">
    <t t-name="my_module.MyWidget">
        <div class="o_my_widget">
            <input type="text" t-on-input="onInput"/>

            <t t-if="state.loading">
                <span>Loading...</span>
            </t>
            <t t-elif="state.error">
                <span t-esc="state.error.message or 'Unknown error'"/>
            </t>
            <ul t-else="">
                <t t-foreach="state.rows" t-as="row" t-key="row.id">
                    <li>
                        <span t-esc="row.name"/>
                    </li>
                </t>
            </ul>
        </div>
    </t>
</templates>
```

Hard rules:

- always use `t-key` in loops
- keep template pure (no side-effecting calls)
- keep conditional branches explicit for loading/error/success

## 6. Data and RPC Patterns in OWL 1

### Safer pattern

1. one method per request intent (`loadRows`, `saveRecord`)
2. normalize response before state assignment
3. track destruction flag to avoid stale updates

### Anti-pattern

- making RPC calls directly in click handlers without state protection
- mutating deeply nested state without clear update contract
- mixing UI formatting and server payload mapping in one function

## 7. Common OWL 1 Failure Modes

| Symptom | Typical Root Cause | Fix |
|--------|---------------------|-----|
| double render/flicker | no explicit loading state | model `{loading,error,data}` |
| memory leaks | timers/listeners not removed | cleanup in unmount hook |
| stale data overwrite | old promise resolves last | request token or destroy guard |
| random row mismatch | missing/unstable `t-key` | use deterministic key |
| brittle migration | too many implicit globals | isolate wrappers/helpers now |

## 8. OWL 1 Code Review Checklist

- [ ] module has clear namespace and one main responsibility
- [ ] state shape is explicit and initialized once
- [ ] lifecycle responsibilities are separated
- [ ] no business-critical validation only in JS
- [ ] templates use stable keys
- [ ] cleanup path exists
- [ ] error state is user-visible

## 9. Minimal Test Matrix for Legacy OWL 1

1. initial mount with valid data
2. server error on first load
3. rapid repeated user input
4. component unmount during pending request
5. long list rendering with stable key behavior

## 10. Preparing OWL 1 Code for Migration

Do this before touching framework APIs:

1. split huge components into smaller intent-based units
2. isolate request logic behind helper/service facade
3. remove direct DOM mutations where possible
4. remove hidden global dependencies
5. write parity scenarios (what must not change after migration)

Migration-ready OWL 1 code is easier and safer to port than a tightly coupled legacy blob.

