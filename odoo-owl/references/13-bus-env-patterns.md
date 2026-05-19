---
name: odoo-owl-bus-env-patterns
description: useBus, env.bus, useEnv, useSubEnv, and bus_service WebSocket patterns in Odoo OWL 2 for inter-component communication and real-time updates.
---

# Bus, Env, and Real-Time Patterns (Odoo OWL 2)

## Decision Tree: Which Communication Pattern?

```
Need components to communicate?
│
├─ Parent → Child?
│   └─ Props (the only correct answer)
│
├─ Child → Parent?
│   └─ Callback prop passed down (not DOM events bubbling up)
│
├─ Sibling / Distant components (same session)?
│   └─ env.bus with useBus hook — scoped to current browser tab
│
├─ Component needs shared service state?
│   └─ useService() — services are singletons per env
│
├─ Real-time server push (WebSocket)?
│   └─ useService("bus_service") — Odoo's WebSocket bus
│
└─ Inject context into a subtree?
    └─ useSubEnv / useChildSubEnv
```

---

## 1. env.bus — In-App Event Bus

`env.bus` is a `EventBus` instance shared across all components in the same OWL environment.
Use it for lightweight cross-component events within the same tab.

```javascript
/** @odoo-module **/
import { useBus } from "@web/core/utils/hooks";
import { useEnv } from "@odoo/owl";

// ─── Emitter component ───
export class RefreshButton extends Component {
    static template = "my_module.RefreshButton";

    setup() {
        this.env = useEnv();
    }

    triggerRefresh() {
        this.env.bus.trigger("my_module:refresh_needed", { source: "button" });
    }
}

// ─── Listener component ───
export class DataPanel extends Component {
    static template = "my_module.DataPanel";

    setup() {
        this.orm = useService("orm");
        this.state = useState({ rows: [] });

        useBus(this.env.bus, "my_module:refresh_needed", async (event) => {
            console.log("refresh triggered by", event.detail.source);
            await this.loadRows();
        });

        onWillStart(() => this.loadRows());
    }

    async loadRows() { /* ... */ }
}
```

`useBus` automatically unregisters the listener when the component is destroyed — no manual cleanup needed.

---

## 2. useBus Signature

```javascript
import { useBus } from "@web/core/utils/hooks";

// useBus(bus, eventName, callback)
// - bus: any EventBus instance (env.bus, service bus, custom bus)
// - eventName: string
// - callback: called with the CustomEvent (event.detail = payload)
```

The callback runs in the component's lifecycle context.
Do NOT put `useBus` inside conditional blocks — hooks must run unconditionally in `setup()`.

---

## 3. useEnv and useChildSubEnv

### useEnv — Read the current environment

```javascript
import { useEnv } from "@odoo/owl";

setup() {
    const env = useEnv();
    // env.bus, env.services, env.isSmall, env.debug, etc.
    console.log("debug mode:", env.debug);
}
```

### useChildSubEnv — Inject context for a subtree

```javascript
import { useChildSubEnv } from "@odoo/owl";

// In a parent component:
setup() {
    useChildSubEnv({
        currentProject: { id: 42, name: "My Project" },
    });
    // All children can now access env.currentProject
}

// In a child component:
setup() {
    const env = useEnv();
    console.log("project:", env.currentProject.name);
}
```

### useSubEnv (self + children)

```javascript
import { useSubEnv } from "@odoo/owl";

// Replaces env for the current component AND its children
setup() {
    useSubEnv({ customFlag: true });
}
```

Use `useChildSubEnv` when you want to inject context but not affect the current component's own env reads.

---

## 4. bus_service — WebSocket / Server Push

For real-time notifications from the Odoo server:

```javascript
/** @odoo-module **/
import { useService } from "@web/core/utils/hooks";
import { useBus } from "@web/core/utils/hooks";

export class LiveDashboard extends Component {
    static template = "my_module.LiveDashboard";

    setup() {
        this.busService = useService("bus_service");
        this.state = useState({ alerts: [] });

        // Subscribe to a channel
        onMounted(() => {
            this.busService.subscribe("my_module.alerts", (notification) => {
                this.state.alerts.unshift(notification.payload);
                if (this.state.alerts.length > 50) {
                    this.state.alerts.pop();
                }
            });
            this.busService.start();
        });
    }
}
```

Channels are subscribed server-side via `res.users` bus groups or custom channel logic.

---

## 5. Custom EventBus for a Subsystem

When a service or a complex widget needs its own scoped bus (not app-wide):

```javascript
/** @odoo-module **/
import { EventBus } from "@odoo/owl";
import { registry } from "@web/core/registry";

const cartService = {
    start() {
        const bus = new EventBus();
        const state = { items: [] };

        return {
            bus,
            addItem(item) {
                state.items.push(item);
                bus.trigger("cart:updated", { items: [...state.items] });
            },
            getItems() {
                return state.items;
            },
        };
    },
};

registry.category("services").add("cart_service", cartService);
```

```javascript
// Consumer component:
setup() {
    this.cartService = useService("cart_service");
    useBus(this.cartService.bus, "cart:updated", ({ detail }) => {
        this.state.items = detail.items;
    });
}
```

---

## 6. Scoped Sub-Environment for Multi-Instance Components

When mounting the same component type multiple times and each needs isolated context:

```javascript
export class BoardWidget extends Component {
    static template = "my_module.BoardWidget";
    static props = { boardId: Number };

    setup() {
        // Inject boardId into env for all children of this widget
        useChildSubEnv({ boardId: this.props.boardId });
    }
}

// Child component — no prop drilling needed:
export class BoardCard extends Component {
    setup() {
        const env = useEnv();
        this.boardId = env.boardId;
    }
}
```

---

## 7. Communicating Between Action Components

When a client action needs to signal the action manager or other top-level services:

```javascript
// Trigger action-level bus event:
setup() {
    this.env = useEnv();
}

onDone() {
    this.env.bus.trigger("my_module:action_done", { result: this.result });
    this.action.doAction({ type: "ir.actions.act_window_close" });
}
```

---

## 8. Common Bus Event Naming Convention

```text
"module_name:event_type"

Examples:
  "pos:order_completed"
  "inventory:stock_updated"
  "project:task_state_changed"
```

Always namespace with your module name to avoid collision with Odoo core events.

---

## 9. Anti-Patterns

| Anti-Pattern | Problem | Fix |
|---|---|---|
| Manual `addEventListener` on `env.bus` | Listener leaks on unmount | Use `useBus` — it cleans up automatically |
| Global variable for cross-component state | Breaks multi-instance components, no reactivity | Use a service with reactive state + bus events |
| `useSubEnv` instead of `useChildSubEnv` | Changes env for current component too, may break service lookups | Use `useChildSubEnv` for injection into subtree only |
| Put `useBus` inside `if` block | React hook rule violation — OWL hooks must be called unconditionally | Move `useBus` to top of `setup()` |
| Overload `env.bus` with high-frequency events (e.g., mouse move) | Performance degradation for all listeners | Throttle/debounce before triggering, or use local state |
| Subscribe to `bus_service` without `start()` call | No connection, no notifications | Always call `this.busService.start()` after subscribing |
