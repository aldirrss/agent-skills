# AGENTS.md — odoo-owl Skill

## Overview

`odoo-owl` is a comprehensive OWL skill for elite Odoo frontend development:
- OWL 1 implementation (Odoo 14-15)
- OWL 2 implementation (Odoo 16-18) — primary track
- patch() extension system for core component customization
- View architecture: Controller, Renderer, Model separation + custom view types
- Advanced field widgets: edit/readonly modes, useX2Many, computed display
- Dialog and wizard patterns: ConfirmationDialog, FormViewDialog, transient wizards
- Bus and env communication: useBus, env.bus, useSubEnv, bus_service WebSocket
- OWL 1 → OWL 2 migration
- OWL 3 compatibility notes for Odoo 19+

## Activation

Use this skill when user requests involve:
- OWL components, hooks, or services
- Client actions and field widgets (including edit/readonly behavior)
- `@odoo-module`, QWeb templates, registries
- Extending or patching core Odoo components (ListController, KanbanRecord, fields, etc.)
- Custom view types (timeline, gantt, calendar, map)
- Dialogs, confirmations, wizards, modal forms
- Cross-component communication, real-time WebSocket updates, env.bus
- Frontend traceback, lifecycle bug, rendering bug
- Legacy `this.rpc` code refactor
- Odoo frontend migration across versions

## File Structure

```text
odoo-owl/
├── SKILL.md
├── CLAUDE.md
├── AGENTS.md
└── references/
    ├── 00-owl-version-matrix.md
    ├── 01-owl-1-guide.md
    ├── 02-owl-2-guide.md
    ├── 03-migration-owl1-owl2.md
    ├── 04-odoo-integration-patterns.md
    ├── 05-debugging-pitfalls.md
    ├── 06-testing-performance.md
    ├── 07-snippets-checklist.md
    ├── 08-owl-3-notes.md
    ├── 09-patch-extension-patterns.md    ← NEW: patch() system
    ├── 10-view-architecture.md           ← NEW: Controller/Renderer/Model
    ├── 11-field-widget-advanced.md       ← NEW: advanced field widgets
    ├── 12-dialog-wizard-patterns.md      ← NEW: dialog and wizard patterns
    └── 13-bus-env-patterns.md            ← NEW: bus and env communication
```

## Loading Strategy

Load only what is needed for the task:

| Task | Primary File | Secondary |
|------|-------------|-----------|
| Identify syntax/API differences | `00-owl-version-matrix.md` | — |
| Build component in Odoo 14/15 | `01-owl-1-guide.md` | — |
| Build component in Odoo 16/17/18 | `02-owl-2-guide.md` | — |
| Upgrade old frontend code | `03-migration-owl1-owl2.md` | `00` |
| Register widgets/actions and assets | `04-odoo-integration-patterns.md` | — |
| Diagnose runtime issues | `05-debugging-pitfalls.md` | — |
| Add test/perf guardrails | `06-testing-performance.md` | — |
| Final pre-merge quality gate | `07-snippets-checklist.md` | — |
| OWL 3 compatibility decisions | `08-owl-3-notes.md` | — |
| Extend/patch core Odoo component | `09-patch-extension-patterns.md` | `02` |
| Custom view type / view extension | `10-view-architecture.md` | `02` |
| Field widget with modes / x2many | `11-field-widget-advanced.md` | `04` |
| Dialog / wizard / modal flow | `12-dialog-wizard-patterns.md` | `02` |
| Cross-component events / real-time | `13-bus-env-patterns.md` | `02` |

## Behavioral Rules

1. Detect Odoo version first — version determines which APIs are safe.
2. Show "bad pattern vs good pattern" when correcting code.
3. For every patch, check: does `super.method()` get called?
4. For every field widget, check: is `props.readonly` handled?
5. For every async flow, check: is there a loading + error state?
6. For every dialog, check: is `close` injected by the service (not passed manually)?
7. For every `useBus` usage, check: is it called unconditionally in `setup()`?
8. Prefer minimal-risk migration with parity first, optimization second.
9. Keep recommendations version-aware and explicit.
10. End every code review with the checklist from `07-snippets-checklist.md`.
