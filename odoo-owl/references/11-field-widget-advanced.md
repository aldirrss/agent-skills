---
name: odoo-owl-field-widget-advanced
description: Advanced field widget patterns in Odoo OWL 2 — edit/readonly modes, standardFieldProps, useX2Many, custom Many2Many tags, computed display, and widget registration.
---

# Advanced Field Widget Patterns (Odoo OWL 2)

## Decision Tree: Which Widget Base to Use?

```
Building a custom field widget?
│
├─ Display/edit a scalar value (Char, Integer, Float, Boolean)?
│   └─ Implement standalone Component + register in "fields" registry
│
├─ Display/edit a Many2one relationship?
│   └─ Patch Many2OneField or subclass via registry override
│
├─ Display/edit Many2many / One2many?
│   └─ Use useX2Many hook inside your Component
│
├─ Need edit mode vs readonly mode to differ?
│   └─ Check props.readonly in template — conditionally render input vs display
│
└─ Replace existing widget for a model/field combo?
    └─ Use widget="my_module.my_widget" in form view XML
```

---

## 1. Standard Field Props Contract

Every field widget receives these props from the Odoo form/list view:

```javascript
import { standardFieldProps } from "@web/views/fields/standard_field_props";

export class MyWidget extends Component {
    static props = {
        ...standardFieldProps,
        // add your own extra props below:
        customOption: { type: Boolean, optional: true },
    };
}
```

Key props from `standardFieldProps`:

| Prop | Type | Description |
|------|------|-------------|
| `name` | String | Field name on the record |
| `record` | Object | The relational record proxy |
| `readonly` | Boolean | Whether field is read-only in current context |
| `required` | Boolean | Whether field is required |
| `string` | String | Field label |

Reading and writing the value:

```javascript
// Read current value
const value = this.props.record.data[this.props.name];

// Write new value (triggers form dirty state)
await this.props.record.update({ [this.props.name]: newValue });
```

---

## 2. Canonical Field Widget — Edit + Readonly Modes

```javascript
/** @odoo-module **/
import { Component, useState } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

export class ColorPickerField extends Component {
    static template = "my_module.ColorPickerField";
    static props = {
        ...standardFieldProps,
    };

    setup() {
        this.state = useState({ open: false });
    }

    get currentColor() {
        return this.props.record.data[this.props.name] || "#ffffff";
    }

    async selectColor(color) {
        await this.props.record.update({ [this.props.name]: color });
        this.state.open = false;
    }
}

registry.category("fields").add("color_picker", {
    component: ColorPickerField,
    supportedTypes: ["char"],
    extractProps: ({ attrs }) => ({
        customOption: attrs.custom_option === "1",
    }),
});
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.ColorPickerField">
        <div class="o_field_color_picker">
            <!-- READONLY mode -->
            <t t-if="props.readonly">
                <span class="o_color_swatch"
                      t-attf-style="background-color: #{currentColor}"/>
            </t>

            <!-- EDIT mode -->
            <t t-else="">
                <button class="btn btn-sm o_color_button"
                        t-attf-style="background-color: #{currentColor}"
                        t-on-click="() => state.open = !state.open">
                    Pick
                </button>
                <t t-if="state.open">
                    <div class="o_color_palette">
                        <t t-foreach="['#ff0000','#00ff00','#0000ff']"
                           t-as="c" t-key="c">
                            <span class="o_color_option"
                                  t-attf-style="background-color: #{c}"
                                  t-on-click="() => selectColor(c)"/>
                        </t>
                    </div>
                </t>
            </t>
        </div>
    </t>
</templates>
```

---

## 3. useX2Many — Many2many / One2many Fields

`useX2Many` is the canonical hook for managing x2many field state in a widget.

```javascript
/** @odoo-module **/
import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";
import { useX2Many } from "@web/views/fields/x2many/x2many_hook";
import { standardFieldProps } from "@web/views/fields/standard_field_props";

export class TagsWidget extends Component {
    static template = "my_module.TagsWidget";
    static props = {
        ...standardFieldProps,
        colorField: { type: String, optional: true },
    };

    setup() {
        this.list = useX2Many({
            record: this.props.record,
            fieldName: this.props.name,
        });
    }

    get tags() {
        return this.list.records;
    }

    async removeTag(tagRecord) {
        await this.list.delete(tagRecord);
    }
}

registry.category("fields").add("custom_tags", {
    component: TagsWidget,
    supportedTypes: ["many2many"],
});
```

```xml
<templates xml:space="preserve">
    <t t-name="my_module.TagsWidget">
        <div class="o_field_tags">
            <t t-foreach="tags" t-as="tag" t-key="tag.id">
                <span class="badge o_tag">
                    <t t-esc="tag.data.name"/>
                    <t t-if="!props.readonly">
                        <button class="o_delete" t-on-click="() => removeTag(tag)">×</button>
                    </t>
                </span>
            </t>
        </div>
    </t>
</templates>
```

---

## 4. extractProps — Passing XML Attrs to Widget

When the widget is used in a form view with custom attributes:

```xml
<!-- form view arch -->
<field name="tag_ids" widget="custom_tags" color_field="color"/>
```

Extract and forward attrs to component props:

```javascript
registry.category("fields").add("custom_tags", {
    component: TagsWidget,
    supportedTypes: ["many2many"],
    extractProps: ({ attrs, field }) => ({
        colorField: attrs.color_field || null,
    }),
});
```

---

## 5. Widget for List View — Minimal Cell Widget

Widgets used in list columns need to work in a condensed cell. Always ensure:
- readonly mode is compact
- no expanding UI elements that break the list row

```javascript
export class StatusBadgeField extends Component {
    static template = "my_module.StatusBadgeField";
    static props = { ...standardFieldProps };

    get badgeClass() {
        const map = { draft: "bg-secondary", open: "bg-primary", done: "bg-success" };
        return map[this.props.record.data[this.props.name]] || "bg-secondary";
    }
}

registry.category("fields").add("status_badge", {
    component: StatusBadgeField,
    supportedTypes: ["selection", "char"],
    listEditableComponent: StatusBadgeField,
});
```

```xml
<t t-name="my_module.StatusBadgeField">
    <span t-attf-class="badge #{badgeClass}"
          t-esc="props.record.data[props.name]"/>
</t>
```

---

## 6. Computed Display Value Pattern

For widgets that transform the raw value before display:

```javascript
get formattedValue() {
    const raw = this.props.record.data[this.props.name];
    if (!raw) return "";
    // Example: format as currency
    return new Intl.NumberFormat("id-ID", {
        style: "currency",
        currency: "IDR",
    }).format(raw);
}
```

Never compute in the template directly — keep template expressions simple.

---

## 7. Field Widget with Async Autocomplete

```javascript
export class SmartInputField extends Component {
    static template = "my_module.SmartInputField";
    static props = { ...standardFieldProps };

    setup() {
        this.orm = useService("orm");
        this.state = useState({ query: "", suggestions: [], loading: false });
    }

    async onInput(event) {
        this.state.query = event.target.value;
        if (this.state.query.length < 2) return;

        this.state.loading = true;
        try {
            this.state.suggestions = await this.orm.call(
                "res.partner",
                "name_search",
                [this.state.query],
                { limit: 5 }
            );
        } finally {
            this.state.loading = false;
        }
    }

    async select(id, name) {
        await this.props.record.update({ [this.props.name]: [id, name] });
        this.state.suggestions = [];
        this.state.query = name;
    }
}
```

---

## 8. Using Widget in Views

```xml
<!-- Form view -->
<field name="color_code" widget="color_picker"/>

<!-- List view (column) -->
<field name="state" widget="status_badge"/>

<!-- With custom attrs -->
<field name="tag_ids" widget="custom_tags" color_field="color" options="{}"/>
```

---

## 9. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Mutate `props.record.data` directly | Bypasses form dirty tracking | Use `props.record.update(...)` |
| No readonly mode handling | Broken UI in list/readonly views | Always check `props.readonly` |
| `useX2Many` but ignore returned `list.records` | Stale data | Use `list.records` as the source of truth |
| Expensive computation in template | Render performance | Move to a getter or `useState` |
| Register widget without `supportedTypes` | Widget never matched | Always declare `supportedTypes` |
| Use `props.record.fields[name].value` instead of `props.record.data[name]` | Wrong API | Always use `props.record.data` |
