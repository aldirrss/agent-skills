# CLAUDE.md — odoo-owl Skill

## About

This skill provides elite-level guidance for OWL development in Odoo across OWL 1, OWL 2, and OWL 3 direction.
Covers the full frontend stack: components, services, registries, patch system, view architecture,
advanced field widgets, dialog/wizard flows, and inter-component bus communication.

## Invocation

```text
Skill("odoo-owl")
```

## Recommended Usage Flow

1. Inspect `__manifest__.py` to determine Odoo version → load `00-owl-version-matrix.md`.
2. Load primary OWL guide by version:
   - Odoo 14-15 → `01-owl-1-guide.md`
   - Odoo 16-18 → `02-owl-2-guide.md`
3. Load additional guides based on task:
   - Extending core component → `09-patch-extension-patterns.md`
   - Custom view type or view extension → `10-view-architecture.md`
   - Field widget with edit/readonly modes → `11-field-widget-advanced.md`
   - Dialog, confirmation, or wizard → `12-dialog-wizard-patterns.md`
   - Cross-component events or real-time → `13-bus-env-patterns.md`
   - Legacy to modern upgrade → `03-migration-owl1-owl2.md`
   - Asset/registry wiring → `04-odoo-integration-patterns.md`
4. Validate before shipping: `05-debugging-pitfalls.md` + `07-snippets-checklist.md`.

## Decision Shortcuts

| User describes | Load first |
|---|---|
| "extend / override ListController / KanbanRecord / form view" | `09-patch-extension-patterns.md` |
| "custom view type / timeline / gantt / map view" | `10-view-architecture.md` |
| "field widget / custom widget / Many2One extension" | `11-field-widget-advanced.md` |
| "confirmation dialog / wizard / modal / popup" | `12-dialog-wizard-patterns.md` |
| "components not talking / real-time / websocket / broadcast" | `13-bus-env-patterns.md` |
| "migration / upgrade from OWL 1 / this.rpc" | `03-migration-owl1-owl2.md` |
| "white screen / template not found / asset missing" | `05-debugging-pitfalls.md` |

## Principles

- Correctness over novelty — prefer battle-tested Odoo patterns.
- Every patch must call `super` unless explicitly replacing full behavior.
- Renderer is always a pure display component; all service calls belong in Controller or Model.
- Edit mode and readonly mode must both be implemented in every field widget.
- `useBus` is the correct way to listen to `env.bus` — never use `addEventListener` on bus manually.
- End with a concrete checklist-based quality gate from `07-snippets-checklist.md`.
