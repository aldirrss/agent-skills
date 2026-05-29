# AGENTS.md — super-odoo18-development Skill

## Overview

This is a **standalone** senior Odoo 18 architect skill.
No external skill dependencies required — all references are bundled in `references/`.

## Activation

This skill activates when the user is working on Odoo 18 and needs:
- Architectural decisions (which pattern to use)
- Performance diagnosis (N+1, slow queries)
- Debugging (tracebacks, transaction errors, OWL errors)
- Security review (ACL, record rules, SQL injection, XSS)
- Code quality review

**Trigger keywords:** `__manifest__`, `models/`, `views/`, `ir.rule`, `@api.depends`,
`@api.onchange`, `fields.Many2one`, `search_read`, `sudo()`, `with_context()`,
`OWL`, `N+1`, `UniqueViolation`, `InFailedSqlTransaction`

## File Structure

```
super-odoo18-development/
├── SKILL.md                        # Main entry point — read this first
├── CLAUDE.md                       # Claude Code specific instructions
├── AGENTS.md                       # This file
└── references/
    ├── decision-trees.md           # Decision trees for decorators, field types, auth
    ├── pitfalls.md                 # Common mistakes — N+1, transactions, OWL, security
    ├── architecture.md             # Module structure, service layer, scalable design
    ├── debugging.md                # Systematic approach to errors and tracebacks
    ├── code-quality.md             # Review checklist, naming, anti-patterns
    └── odoo-18-security-guide.md   # Complete security reference (ACL, rules, pitfalls)
```

## Loading Strategy

Load `references/` files **on demand**, not all at once:

| User asks about... | Load |
|--------------------|------|
| Which decorator / field type to use | `references/decision-trees.md` |
| Slow code / N+1 queries | `references/pitfalls.md` |
| Module structure / service layer | `references/architecture.md` |
| Error / traceback / crash | `references/debugging.md` |
| Code review | `references/code-quality.md` |
| ACL / record rules / SQL injection / XSS | `references/odoo-18-security-guide.md` |

## Behavioral Guidelines

- Give **opinionated recommendations** — avoid presenting all options as equal
- Focus on **judgment** (when and why), not syntax reference
- Target audience: senior Odoo developers — skip basic explanations
- Always show the bad pattern alongside the correct fix
- End debugging sessions with root cause + prevention, not just the fix
