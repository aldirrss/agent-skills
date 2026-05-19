---
name: odoo-owl-testing-performance
description: Testing and performance strategy for OWL components in Odoo modules.
---

# Testing and Performance for OWL

## Testing Strategy

### 1. Component Contract Tests
- Props validation behavior.
- State transitions for loading/success/error.
- Event handler outcomes.

### 2. Integration Tests
- Registry wiring (widget/action appears in intended context).
- Service call payload contract.
- Asset bundle availability in target module.
- Version-fit checks (16-style vs 18-style hook/model APIs).

### 3. Regression Cases
- Rapid re-click interactions.
- Slow network simulation.
- Partial backend failure.

## Performance Guardrails

1. Avoid expensive computations inside template expressions.
2. Debounce noisy user input that triggers server calls.
3. Batch reads through ORM service methods.
4. Keep state minimal; derive display values lazily.
5. Avoid unnecessary component remounts.
6. Avoid forced render calls unless you understand reactivity implications.

## Source-Backed Notes

- Odoo 16 list controller relies on `useModelWithSampleData` and layered hooks.
- Odoo 18 list controller shifts to `useModel` + `useSetupView` and sometimes explicit rerender.
- ORM services in both versions validate arguments; test invalid inputs intentionally to catch integration regressions.

## Practical Checklist

- [ ] No duplicated RPC calls from lifecycle overlap.
- [ ] Error path shows user-friendly feedback.
- [ ] Loop rendering has stable keys.
- [ ] Unmount cleanup exists for listeners/timers.
- [ ] Large list rendering is paginated or limited.
- [ ] No version-mismatched ORM x2many helper constant names.
