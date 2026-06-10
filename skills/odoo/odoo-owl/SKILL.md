---
name: odoo-owl
description: >
  ELITE Odoo OWL frontend skill for OWL 1 (Odoo 14-15) and OWL 2 (Odoo 16-18),
  with OWL 3 direction notes (Odoo 19+). Covers component architecture, hooks,
  services, registries, view architecture (Controller/Renderer/Model), patch()
  extension system, advanced field widgets (edit/readonly/x2many), dialog and
  wizard patterns, bus/env inter-component communication, client actions, asset
  management, debugging, performance, and test strategy.
  Triggers on: @odoo-module, owl, Component, useState, useService, useSetupView,
  useModel, useX2Many, useBus, useSubEnv, useChildSubEnv, patch(), registry,
  web.assets_backend, field widget, standardFieldProps, client action, this.rpc,
  orm service, onWillStart, onMounted, onWillUnmount, t-foreach, t-key,
  t-inherit, Dialog, ConfirmationDialog, FormViewDialog, env.bus, bus_service,
  KanbanRecord, ListController, FormController, OWL migration, view architecture.
globs: "**/static/src/**/*.{js,ts,xml,scss}"
---

# Odoo OWL Skill — Master Index

This skill gives practical guidance to write correct, production-grade OWL code across Odoo versions.

## Scope

- **OWL 1**: Odoo 14-15
- **OWL 2**: Odoo 16-18 (primary track)
- **OWL 3**: Migration direction for Odoo 19+

## Quick Reference

| Need | File |
|------|------|
| Version-aware API differences | `references/00-owl-version-matrix.md` |
| OWL 1 patterns (v14-15) | `references/01-owl-1-guide.md` |
| OWL 2 patterns (v16-18) — canonical component, services, registries | `references/02-owl-2-guide.md` |
| OWL 1 → OWL 2 migration playbook | `references/03-migration-owl1-owl2.md` |
| Assets, registry categories, field widget registration | `references/04-odoo-integration-patterns.md` |
| Debugging workflow and pitfall catalog | `references/05-debugging-pitfalls.md` |
| Testing and performance strategy | `references/06-testing-performance.md` |
| Copy-paste snippets and pre-merge checklist | `references/07-snippets-checklist.md` |
| OWL 3 guardrails and migration notes | `references/08-owl-3-notes.md` |
| **patch() system — extend core components, templates, services, widgets** | `references/09-patch-extension-patterns.md` |
| **View architecture — Controller/Renderer/Model, custom view type, usePager** | `references/10-view-architecture.md` |
| **Advanced field widgets — edit/readonly, standardFieldProps, useX2Many** | `references/11-field-widget-advanced.md` |
| **Dialog and wizard patterns — ConfirmationDialog, FormViewDialog, wizards** | `references/12-dialog-wizard-patterns.md` |
| **Bus and env patterns — useBus, env.bus, useSubEnv, bus_service WebSocket** | `references/13-bus-env-patterns.md` |

## Mandatory Workflow

1. Detect target Odoo version from `__manifest__.py`.
2. Load version matrix (`00`).
3. Apply OWL guide for the matching version (`01` or `02`).
4. If the task involves extending core components → load `09` (patch).
5. If the task involves building a custom view type → load `10` (view architecture).
6. If the task involves field widgets → load `11` (field widget advanced).
7. If the task involves dialogs/wizards → load `12` (dialog patterns).
8. If the task involves cross-component events or real-time → load `13` (bus/env).
9. If legacy/modern code mix exists → load `03` (migration).
10. Validate with `05` (debugging) + `07` (checklist) before shipping.

## Version Dispatch

```text
Odoo 14-15 -> OWL 1   (guides 01, 03)
Odoo 16-18 -> OWL 2   (guide 02, plus 09-13 for extended topics)
Odoo 19+   -> OWL 3   (guide 08 for direction; 02 still applies until full OWL 3)
```

## Source-Verified Facts (community/16 and community/18)

1. `addons/web/static/lib/owl/owl.js` in both Odoo 16 and 18 reports `const version = "2.8.2"`.
2. Both expose OWL as `@odoo/owl` through `addons/web/static/lib/owl/odoo_module.js`.
3. Odoo 16 web code already uses OWL 2 style imports/hooks/services in core modules.
4. `patch()` is the canonical Odoo extension mechanism — imported from `@web/core/utils/patch`.
5. Odoo 18 uses `useModel` / `useSetupView`; Odoo 16 uses `useModelWithSampleData` / `useSetupAction`.

## Golden Rules

1. Use `setup()` instead of constructors.
2. Keep templates deterministic (`t-key` on loops, no side-effect expressions).
3. Prefer `useService("orm")` / `useService("rpc")` in OWL 2+.
4. Keep business logic in Python models, not in OWL components.
5. Register components in the correct registry category with unique namespaced keys.
6. Always clean up listeners/timers in unmount lifecycle hooks — `useBus` cleans up automatically.
7. Use `patch()` + `super.method()` for extending core components; always unpatch in tests.
8. Separate view layers: Controller orchestrates, Renderer displays, Model loads data.
9. Respect `props.readonly` in every field widget — always implement both modes.
10. Use `env.bus` + `useBus` for cross-component events; never use global variables.
