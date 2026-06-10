# CLAUDE.md — super-odoo18-development Skill

## About This Skill

This skill is a **standalone senior architect layer** for Odoo 18.
No additional skills required — all references are available inside the `references/` folder.

## How to Use

Invoke via the Skill tool in Claude Code:
```
Skill("super-odoo18-development")
```

Or the user types `/super-odoo18-development` in Claude Code.

## File Structure

```
super-odoo18-development/
├── SKILL.md                        # Entry point — read this first
├── CLAUDE.md                       # This file
├── AGENTS.md                       # Instructions for other agents
└── references/
    ├── decision-trees.md           # Decision trees for decorators, field types, auth
    ├── pitfalls.md                 # Common traps — N+1, transactions, OWL, security
    ├── architecture.md             # Module architecture patterns
    ├── debugging.md                # Systematic debugging approach
    ├── code-quality.md             # Code review checklist
    └── odoo-18-security-guide.md   # Complete Odoo 18 security guide
```

## When to Load references/ Files

Do not load all at once. Load only when needed:

| User asks about... | Load this file |
|--------------------|----------------|
| Choose decorator / field type | `references/decision-trees.md` |
| Slow code / N+1 | `references/pitfalls.md` |
| Module structure / service layer | `references/architecture.md` |
| Error / traceback | `references/debugging.md` |
| Code review | `references/code-quality.md` |
| ACL / record rules / XSS / injection | `references/odoo-18-security-guide.md` |

## Core Principles

- Give **opinionated recommendations** — avoid false balance
- Focus on **judgment** (when and why), not syntax reference
- Use the same language as the user (Indonesian if user uses Indonesian)
- This skill targets **senior developers** — skip basic explanations
