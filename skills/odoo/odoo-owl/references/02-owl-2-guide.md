---
name: odoo-owl-2-guide
description: Deep OWL 2 guide for Odoo 16-18 with source-backed patterns, architecture decisions, pitfalls, and quality gates.
---

# OWL 2 Guide (Odoo 16-18 Primary Track)

This is the default guide for modern Odoo frontend work in this repository context.

## 1. Verified Baseline from Local Source

Observed facts:

1. OWL is exposed as `@odoo/owl` in both trees.
2. both owl bundles expose version `2.8.2`.
3. core web views in both 16 and 18 use OWL imports + hook-driven architecture.

## 2. Architecture Principles for OWL 2 in Odoo

1. **Service-first design**: use `useService("orm" | "rpc" | "action" | "notification" | "dialog")`.
2. **Lifecycle ownership**:
   - setup: wire services/state/refs
   - willStart: async preload
   - mounted: DOM-dependent work
   - unmount: cleanup
3. **State contract**: keep explicit `loading/error/data`.
4. **Template purity**: no side effects in render path.
5. **Registry correctness**: register component in the right category with unique key.

## 3. Canonical OWL 2 Component (Production Shape)

```javascript
/** @odoo-module **/
import {
    Component,
    useState,
    useRef,
    onWillStart,
    onMounted,
    onWillUnmount,
    onWillUpdateProps,
} from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class PartnerPanel extends Component {
    static template = "my_module.PartnerPanel";
    static props = {
        recordId: { type: Number, optional: true },
        domain: { type: Array, optional: true },
    };
    static defaultProps = {
        domain: [],
    };

    setup() {
        this.orm = useService("orm");
        this.action = useService("action");
        this.notification = useService("notification");
        this.inputRef = useRef("searchInput");
        this._seq = 0;
        this._timer = null;

        this.state = useState({
            loading: false,
            error: null,
            rows: [],
            query: "",
        });

        onWillStart(async () => {
            await this.loadRows();
        });

        onWillUpdateProps(async (nextProps) => {
            if (nextProps.recordId !== this.props.recordId) {
                await this.loadRows();
            }
        });

        onMounted(() => {
            this.inputRef.el?.focus();
        });

        onWillUnmount(() => {
            if (this._timer) {
                clearTimeout(this._timer);
            }
        });
    }

    async loadRows() {
        const seq = ++this._seq;
        this.state.loading = true;
        this.state.error = null;
        try {
            const rows = await this.orm.searchRead(
                "res.partner",
                this.props.domain,
                ["name", "email", "phone"],
                { limit: 40 }
            );
            if (seq !== this._seq) return;
            this.state.rows = rows;
        } catch (error) {
            if (seq !== this._seq) return;
            this.state.error = error;
            this.notification.add("Failed to load partners", { type: "danger" });
        } finally {
            if (seq === this._seq) {
                this.state.loading = false;
            }
        }
    }

    async openRecord(partnerId) {
        await this.action.doAction({
            type: "ir.actions.act_window",
            res_model: "res.partner",
            res_id: partnerId,
            views: [[false, "form"]],
            target: "current",
        });
    }
}
```

## 4. Template Standard for OWL 2

```xml
<templates xml:space="preserve">
    <t t-name="my_module.PartnerPanel">
        <div class="o_partner_panel">
            <input t-ref="searchInput" type="search" t-att-value="state.query"/>

            <t t-if="state.loading">
                <div class="o_loading_spinner"/>
            </t>
            <t t-elif="state.error">
                <span class="text-danger" t-esc="state.error.message"/>
            </t>
            <ul t-else="">
                <t t-foreach="state.rows" t-as="row" t-key="row.id">
                    <li>
                        <button class="btn btn-link" t-on-click="() => openRecord(row.id)">
                            <span t-esc="row.name"/>
                        </button>
                    </li>
                </t>
            </ul>
        </div>
    </t>
</templates>
```

Template rules:

1. all loops must have stable keys
2. no inline heavy computation
3. no hidden side effects
4. explicit loading/error/success branch

## 5. Services: When to Use What

| Service | Use for | Avoid |
|--------|---------|-------|
| `orm` | model CRUD/read_group/call | hand-building call_kw when not needed |
| `rpc` | custom HTTP route calls | replacing `orm` for standard model ops |
| `action` | opening views/wizards/reports | manual URL hacks for view navigation |
| `notification` | user feedback | silent failures |
| `dialog` | confirmation and modal flow | ad-hoc window prompts |

## 6. Odoo 16 vs Odoo 18 Nuances (Still OWL 2)

### Observed from source

`community/16/.../list_controller.js`:
- `useModelWithSampleData`
- `useSetupAction`

`community/18/.../list_controller.js`:
- `useModel`
- `useSetupView`

Both are OWL 2-era patterns, but 18 has more modernized view/model hooks.

### ORM x2many helper naming difference

Odoo 16 style:
- `UNLINK`, `LINK`, `CLEAR`, `SET`

Odoo 18 style:
- `FORGET`, `LINK_TO`, `DELETE_ALL`, `REPLACE_WITH`

Do not copy helper names across versions blindly.

## 7. Registries and Integration Patterns

### Field widget registration

```javascript
import { registry } from "@web/core/registry";
import { PartnerPanel } from "./partner_panel";

registry.category("fields").add("my_module.partner_panel", {
    component: PartnerPanel,
    supportedTypes: ["many2one", "char"],
});
```

### Action registration

```javascript
registry.category("actions").add("my_module.partner_panel_action", PartnerPanel);
```

Common mistake: component is valid but attached to wrong registry category.

## 8. Asset Loading and Manifest Hygiene

```python
"assets": {
    "web.assets_backend": [
        "my_module/static/src/js/**/*.js",
        "my_module/static/src/xml/**/*.xml",
        "my_module/static/src/scss/**/*.scss",
    ],
}
```

Checklist:

- JS path exists
- XML template path exists
- template names are unique and namespaced
- no duplicate asset entries causing order issues

## 9. Anti-Patterns You Should Block in Review

1. `this.render(true)` used as a default reaction to state issues.
2. direct model/business rules in component code.
3. missing error branch in async flows.
4. `rpc` used for all model CRUD instead of `orm`.
5. no cleanup for listener/timer resources.
6. unstable keys in list rendering.
7. massive component that mixes data orchestration + presentation + routing.

## 10. Debugging Workflow for OWL 2 Incidents

1. reproduce with smallest route and smallest dataset
2. inspect browser console stack before server logs
3. classify issue:
   - lifecycle timing
   - stale request race
   - missing asset/template
   - wrong registry key/category
   - service payload mismatch
4. verify bundle includes the expected JS/XML
5. verify imported module is same one you register

## 11. Testing Matrix for OWL 2 Components

### Contract tests

- props accepted/rejected as expected
- state transitions (`loading -> data`, `loading -> error`)
- click handlers call correct service methods

### Integration tests

- registry entry appears in intended context
- action opens right view target
- ORM payload shape is correct

### Regression tests

- rapid repeated input actions
- unmount during in-flight request
- permission failure path from backend

## 12. Performance Guardrails

1. debounce high-frequency user input
2. batch reads (`searchRead`, `readGroup`) instead of chatty calls
3. keep state small and normalized
4. avoid expensive transforms in template
5. avoid broad forced rerender patterns

## 13. OWL 2 Quality Gate (Pre-Merge)

- [ ] target Odoo version identified
- [ ] service usage follows version-safe patterns
- [ ] lifecycle responsibilities are cleanly separated
- [ ] templates are deterministic and keyed
- [ ] errors are surfaced to users
- [ ] registry keys are unique and correct category is used
- [ ] assets are correctly wired
- [ ] no legacy OWL 1 leftovers unless explicitly required

