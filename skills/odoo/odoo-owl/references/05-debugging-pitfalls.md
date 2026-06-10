---
name: odoo-owl-debugging-pitfalls
description: Debug workflow and pitfall catalog for OWL runtime issues in Odoo.
---

# OWL Debugging and Pitfalls

## Fast Debug Workflow

1. Reproduce with the smallest possible interaction.
2. Read browser console first (stack traces are often clearer there).
3. Isolate whether failure is:
   - lifecycle timing,
   - service call error,
   - template rendering issue,
   - registry/asset loading issue.
4. Confirm bundle includes expected JS/XML.
5. Confirm target registry key exists exactly once.

## Source-Backed Hotspots (16/18)

1. **Service call path mismatch**:
   both versions rely heavily on `useService("rpc")` and `useService("orm")` in core views.
2. **Lifecycle + manual render interactions**:
   Odoo 18 list controller contains explicit `this.render(true)` with a reactivity comment.
   If you emulate this pattern carelessly, you can create duplicate render/update loops.
3. **Version-specific ORM command names**:
   command constants differ between 16 and 18 in `core/orm_service.js`.

## Pitfalls and Fixes

### 1) Missing `t-key` in loops
- Symptom: unstable rerender, wrong row updates.
- Fix: add deterministic key from stable identifier.

### 2) Side effects in render path
- Symptom: repeated requests, flickering state.
- Fix: move side effects to lifecycle hooks.

### 3) No error state
- Symptom: blank UI without feedback.
- Fix: explicit `{ loading, error, data }` state model.

### 4) Stale async race
- Symptom: old request overwrites newer data.
- Fix: track request token or sequence and ignore stale responses.

### 5) Registry collision
- Symptom: component not used or silently overridden.
- Fix: unique registry keys and consistent module namespace.

### 6) Leaking listeners/timers
- Symptom: memory growth, duplicated callbacks after navigation.
- Fix: cleanup in unmount hooks.

## Migration Note to OWL 3

- Avoid tightly coupling code to class internals where functional composition is possible.
- Keep component side effects explicit and isolated.
- Keep custom abstractions around services thin so OWL 3 transition remains mostly adapter-level.
