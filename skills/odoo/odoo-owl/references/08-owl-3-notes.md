---
name: odoo-owl-3-notes
description: Where OWL 3 guidance should be written and how to prepare OWL 2 code for Odoo 19+ migration.
---

# OWL 3 Notes (Odoo 19+)

## Where OWL 3 Should Be Written in This Skill

Write OWL 3 guidance in this file:

`odoo-owl/references/08-owl-3-notes.md`

Use it as the single entry point for OWL 3 transition decisions.

## Current Scope Boundary

- This repository currently validates OWL implementation against local Odoo 16 and 18 trees.
- OWL 3 here is documented as migration direction and compatibility guardrails.
- If Odoo 19 source tree is added locally, this file should be expanded with source-verified examples.

## OWL 2 -> OWL 3 Preparation Rules

1. Keep components side-effect free outside lifecycle hooks.
2. Keep service access centralized and testable.
3. Avoid deep class inheritance chains in custom components.
4. Isolate rendering helpers to ease functional refactors later.
5. Keep template logic declarative and key-stable.

## Upgrade Checklist Placeholder (to fill when 19 source is available)

- [ ] Confirm OWL bundle version in Odoo 19 local source.
- [ ] Confirm canonical import patterns from `@odoo/owl`.
- [ ] Confirm lifecycle/hook compatibility changes.
- [ ] Confirm registry and service integration differences.
- [ ] Add working examples copied from core modules.

