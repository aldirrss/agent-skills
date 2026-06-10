---
name: odoo-owl-migration-1-to-2
description: Full migration playbook from OWL 1 legacy modules to OWL 2 architecture with phased rollout and rollback safety.
---

# Migration Playbook — OWL 1 to OWL 2

This guide is for real migrations, not superficial syntax replacement.

## 1. Migration Objective

Primary goal:
- preserve business behavior while upgrading frontend architecture

Secondary goal:
- align with service-first OWL 2 patterns used by Odoo 16-18 core code

## 2. What Changes and What Must Not Change

### Must change

1. module style and import conventions
2. service and request abstractions
3. lifecycle/hook usage style
4. registry and integration consistency

### Must not change

1. business outcomes seen by users
2. access/security behavior
3. route payload contracts unless planned
4. functional acceptance criteria

## 3. Migration Phases (Recommended)

### Phase 0 — Discovery

Build inventory table for each component:

| Component | Current style | RPC touchpoints | Registry key | Risk |
|----------|----------------|-----------------|-------------|------|
| `A` | OWL 1 | `this.rpc` x3 | `fields.x` | medium |

Also capture:

- template dependencies
- CSS coupling
- hidden globals
- extension/inheritance points

### Phase 1 — Stabilize Before Refactor

Create parity scenarios:

1. happy path
2. validation error path
3. permission-denied path
4. fast repeated user actions
5. unmount while request in-flight

If behavior is not documented first, migration risk explodes.

### Phase 2 — Mechanical Upgrade

1. convert file/module wrappers to modern module style
2. normalize imports from `@odoo/owl` and `@web/*`
3. move setup concerns into `setup()` + hooks
4. replace ad-hoc RPC usage with service-first design where applicable
5. add explicit state model and error branch

### Phase 3 — Integration Upgrade

1. re-check manifest assets
2. re-register in correct registry category
3. verify template namespace uniqueness
4. verify action/widget wiring in real UI entry points

### Phase 4 — Hardening

1. add race guards for async loaders
2. add cleanup for listeners/timers/subscriptions
3. remove temporary compatibility shims
4. run parity scenarios and regression matrix

## 4. Pattern Mapping (Detailed)

| OWL 1 Pattern | OWL 2 Direction | Notes |
|---------------|------------------|-------|
| `odoo.define(...)` | `/** @odoo-module **/` + ES imports | do per file, keep behavior identical |
| `owl.hooks.useState` | `useState` import from `@odoo/owl` | same concept, cleaner imports |
| global request helpers | `useService("orm"/"rpc")` | choose by operation type |
| implicit props shape | explicit `static props` | catches integration mistakes early |
| mixed lifecycle logic | explicit hook ownership | reduces timing bugs |
| unkeyed loops | `t-key` everywhere | mandatory for stable patching |

## 5. Migration Axis #2 (16-style to 18-style Modernization)

Even after OWL 1 -> OWL 2, you may still need in-OWL2 modernization:

| Area | Odoo 16 style | Odoo 18 style |
|------|----------------|---------------|
| list model hook | `useModelWithSampleData(...)` | `useModel(...)` |
| view setup hook | `useSetupAction(...)` | `useSetupView(...)` |
| orm x2many commands | `UNLINK/LINK/CLEAR/SET` | `FORGET/LINK_TO/DELETE_ALL/REPLACE_WITH` |

Treat this as a separate migration task to reduce blast radius.

## 6. Code Transformation Example (Before/After)

### Before (legacy style)

```javascript
odoo.define("my_module.MyWidget", function (require) {
    const { Component } = owl;
    const { useState } = owl.hooks;

    class MyWidget extends Component {
        setup() {
            this.state = useState({ rows: [] });
        }
        async willStart() {
            this.state.rows = await this.rpc({
                model: "my.model",
                method: "search_read",
                args: [[], ["name"]],
            });
        }
    }
    return MyWidget;
});
```

### After (OWL 2 style, parity-focused)

```javascript
/** @odoo-module **/
import { Component, onWillStart, useState } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";

export class MyWidget extends Component {
    static template = "my_module.MyWidget";

    setup() {
        this.orm = useService("orm");
        this.state = useState({ loading: false, error: null, rows: [] });
        onWillStart(async () => {
            this.state.loading = true;
            try {
                this.state.rows = await this.orm.searchRead("my.model", [], ["name"]);
            } catch (error) {
                this.state.error = error;
            } finally {
                this.state.loading = false;
            }
        });
    }
}
```

## 7. High-Risk Zones

1. component relies on jQuery DOM mutation outside lifecycle
2. component relies on hidden globals from legacy boot scripts
3. templates reused with same `t-name` across modules
4. registry key collisions during parallel refactors
5. old and new request styles mixed in one component
6. broad rewrites that combine migration + feature changes

## 8. Safe Rollout Strategy

### Recommended

1. migrate one feature slice at a time
2. ship behind clear enablement path if possible
3. keep rollback-ready branch until parity verified

### Avoid

- full frontend rewrite in one PR
- migration and product redesign in one step
- deleting legacy fallback before parity evidence exists

## 9. Validation Gates

A migration batch is complete only when:

- [ ] parity scenarios pass
- [ ] no new console/runtime errors
- [ ] registry resolution works in real screens
- [ ] assets load correctly in target bundles
- [ ] error states are visible and recoverable
- [ ] no stale-request overwrite issues
- [ ] reviewers can map each legacy behavior to new implementation

## 10. Rollback Plan (Must Exist Before Merge)

Prepare:

1. list of changed entry points
2. known data/action side effects
3. exact commit range to revert
4. operator check script to verify rollback health

Rollback trigger examples:

- critical flow broken in production
- unresolved permission or routing regressions
- memory/performance regressions above acceptable threshold

## 11. Anti-Pattern Watchlist During Migration

1. replacing `this.rpc` with raw HTTP fetches everywhere
2. introducing large utility abstractions before parity
3. skipping state/error model because “temporary”
4. patching symptoms with forced `render` calls
5. mixing multiple versions of the same component contract

## 12. Final Migration Checklist

- [ ] version target is explicit (14/15 -> 16/18)
- [ ] migration scope excludes unrelated feature work
- [ ] mapping table exists for each migrated component
- [ ] request layer is service-first where applicable
- [ ] lifecycle responsibilities are explicit
- [ ] templates are keyed and deterministic
- [ ] integration (registry/assets/actions) is verified
- [ ] rollback path is documented and tested

