---
name: odoo-owl-view-architecture
description: Odoo OWL 2 view architecture — Controller, Renderer, Model separation, custom view type from scratch, useSetupView, usePager, and ControlPanel integration.
---

# View Architecture Patterns (Odoo OWL 2)

## Odoo View Layer Architecture

```
View Definition (registry)
    │
    ▼
Controller (OWL Component)
    ├─ owns search model, action service, pager
    ├─ uses useSetupView / useSetupAction
    ├─ wires Model to Renderer via props
    │
    ├─► Renderer (OWL Component)
    │       └─ receives records/groups as props
    │       └─ emits events upward (no direct service calls)
    │
    └─► Model (plain class or hook)
            └─ loads data from ORM
            └─ exposes reactive state upward
```

**Design rule**: Renderer is a pure display component. All service calls (ORM, action, notification) happen in Controller or Model.

---

## 1. Decision Tree: Custom View or Extension?

```
Need custom view behavior?
│
├─ Change how existing list/kanban/form looks or behaves?
│   └─ Patch Controller/Renderer (see 09-patch-extension-patterns.md)
│
├─ Add extra panel alongside existing view?
│   └─ Use t-inherit to extend ControlPanel or add slots
│
├─ New view type for a specific model (e.g., Gantt, Map, Timeline)?
│   └─ Register new view type in "views" registry — full Controller+Renderer+Model
│
└─ Replace view for one specific action?
    └─ Set arch type in the XML view definition + register that type in views registry
```

---

## 2. Minimal Custom View Type (Odoo 16/18 Compatible)

### 2a. Model (data layer)

```javascript
/** @odoo-module **/
import { reactive } from "@odoo/owl";

export class TimelineModel {
    constructor(config) {
        this.orm = config.services.orm;
        this.state = reactive({
            loading: false,
            error: null,
            records: [],
        });
    }

    async load(searchParams) {
        const { domain, context } = searchParams;
        this.state.loading = true;
        this.state.error = null;
        try {
            this.state.records = await this.orm.searchRead(
                "project.task",
                domain,
                ["name", "date_start", "date_end", "user_ids"],
                { context }
            );
        } catch (error) {
            this.state.error = error;
        } finally {
            this.state.loading = false;
        }
    }
}
```

### 2b. Renderer (display layer)

```javascript
/** @odoo-module **/
import { Component } from "@odoo/owl";

export class TimelineRenderer extends Component {
    static template = "my_module.TimelineRenderer";
    static props = {
        records: { type: Array },
        openRecord: { type: Function },
    };
}
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.TimelineRenderer">
        <div class="o_timeline_renderer">
            <t t-if="props.records.length === 0">
                <div class="o_view_nocontent">No records found.</div>
            </t>
            <t t-foreach="props.records" t-as="record" t-key="record.id">
                <div class="o_timeline_item" t-on-click="() => props.openRecord(record.id)">
                    <span t-esc="record.name"/>
                </div>
            </t>
        </div>
    </t>
</templates>
```

### 2c. Controller (orchestration layer)

```javascript
/** @odoo-module **/
import { Component, onWillStart, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
import { useSetupView } from "@web/views/view_hook";
import { TimelineModel } from "./timeline_model";
import { TimelineRenderer } from "./timeline_renderer";

export class TimelineController extends Component {
    static template = "my_module.TimelineController";
    static components = { TimelineRenderer };
    static props = ["*"];

    setup() {
        this.action = useService("action");
        this.model = new TimelineModel({
            services: { orm: useService("orm") },
        });

        useSetupView({
            rootRef: useRef("root"),
        });

        onWillStart(() => this.model.load(this.props.domain
            ? { domain: this.props.domain, context: this.props.context || {} }
            : { domain: [], context: {} }
        ));
    }

    async openRecord(resId) {
        await this.action.doAction({
            type: "ir.actions.act_window",
            res_model: this.props.resModel,
            res_id: resId,
            views: [[false, "form"]],
            target: "current",
        });
    }
}
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.TimelineController">
        <div t-ref="root" class="o_timeline_view">
            <t t-if="model.state.loading">
                <div class="o_loading_spinner"/>
            </t>
            <t t-elif="model.state.error">
                <div class="o_view_error" t-esc="model.state.error.message"/>
            </t>
            <TimelineRenderer t-else=""
                records="model.state.records"
                openRecord.bind="openRecord"/>
        </div>
    </t>
</templates>
```

### 2d. View Registration

```javascript
/** @odoo-module **/
import { registry } from "@web/core/registry";
import { TimelineController } from "./timeline_controller";

registry.category("views").add("timeline", {
    type: "timeline",
    display_name: "Timeline",
    icon: "fa fa-clock-o",
    multiRecord: true,
    Controller: TimelineController,
});
```

### 2e. XML View Definition

```xml
<record id="view_task_timeline" model="ir.ui.view">
    <field name="name">project.task.timeline</field>
    <field name="model">project.task</field>
    <field name="arch" type="xml">
        <timeline/>
    </field>
</record>
```

---

## 3. useSetupView vs useSetupAction

| Hook | Odoo Version | Use When |
|------|-------------|----------|
| `useSetupAction` | 16 | Controller is rendered as a full client action |
| `useSetupView` | 16, 18 | Controller is a view inside the action service (preferred) |

In Odoo 18, `useSetupView` is more prominent. Use it for all custom views on 16 and 18.

```javascript
import { useSetupView } from "@web/views/view_hook";

setup() {
    useSetupView({
        rootRef: useRef("root"),
        getLocalState: () => ({ scrollTop: this.scrollTop }),
        setLocalState: (state) => { this.scrollTop = state.scrollTop; },
    });
}
```

---

## 4. usePager Integration

For views that paginate records:

```javascript
/** @odoo-module **/
import { usePager } from "@web/search/pager_hook";

setup() {
    // ...
    usePager(() => ({
        offset: this.model.state.offset,
        limit: this.model.state.limit,
        total: this.model.state.total,
        onUpdate: ({ offset, limit }) => {
            this.model.state.offset = offset;
            this.model.state.limit = limit;
            this.model.load(this.props.domain);
        },
    }));
}
```

The pager renders in the ControlPanel automatically when wired through `usePager`.

---

## 5. ControlPanel and Search Integration

The ControlPanel is injected by the View layer. Your Controller receives search state via props:

```javascript
// Props available to Controller (provided by the View layer):
// props.domain        — computed domain from search
// props.groupBy       — active group-by fields
// props.context       — active context
// props.orderBy       — active sort order
// props.resModel      — target model name

// Re-load model when search state changes:
onWillUpdateProps(async (nextProps) => {
    if (nextProps.domain !== this.props.domain) {
        await this.model.load({
            domain: nextProps.domain,
            context: nextProps.context,
        });
    }
});
```

---

## 6. View with useModel (Odoo 18 Pattern)

In Odoo 18, the preferred way to use a relational model is `useModel`:

```javascript
/** @odoo-module **/
import { useModel } from "@web/model/model";
import { RelationalModel } from "@web/model/relational_model/relational_model";

setup() {
    this.model = useModel(RelationalModel, {
        resModel: this.props.resModel,
        fields: this.props.fields,
        activeFields: this.props.activeFields,
    });
    // model.root is a reactive Record/Group tree
}
```

Odoo 16 equivalent is `useModelWithSampleData` — do not mix versions.

---

## 7. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| ORM calls in Renderer | Tight coupling, no re-use | Move all data calls to Controller or Model |
| No `onWillUpdateProps` for domain/search | View does not react to search changes | Always handle prop updates in Controller |
| Skipping `useSetupView` | Pager / breadcrumb / view state don't work | Always call `useSetupView` in custom Controllers |
| Model as OWL component | Model lifecycle tied to mount/unmount | Keep Model as a plain class or hook |
| Mixing Odoo 16 `useModelWithSampleData` in Odoo 18 | Runtime error or incorrect model shape | Check version, use `useModel` in 18 |
| Renderer emitting DOM events up to Controller | Fragile coupling | Pass callback props (`openRecord.bind="openRecord"`) |
