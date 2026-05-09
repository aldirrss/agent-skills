# AGENTS.md — Skills Development Project

## Project Context

This repository contains custom AI Agent Skills for Claude Code and Claude.ai.
Skills are reusable guidance modules that AI agents load on demand to provide
expert-level assistance in specific domains.

**Owner:** Aldi (Odoo engineer, Lema Core Technologies)
**GitHub:** `aldirrss/agent-skills`

---

## Repository Structure

```
skills-dev/
├── super-brainstorming/        # Elite ideation engine skill
│   ├── SKILL.md                # Skill entry point
│   └── references/             # Supporting reference files
├── super-odoo18-development/   # Senior Odoo 18 architect skill (standalone)
│   ├── SKILL.md
│   └── references/
├── CLAUDE.md                   # Claude Code specific instructions
└── AGENTS.md                   # This file
```

---

## Skill File Format

Every skill has a `SKILL.md` entry point with required YAML frontmatter:

```yaml
---
name: skill-name
description: >
  Full description used by AI to decide when to activate this skill.
  Include domain keywords and trigger phrases.
globs: "**/*.{py,xml}"   # Relevant file patterns
---

# Skill Title

[Skill content here]
```

Reference files in `references/` are loaded on demand — not all at once.

---

## Design Principles

1. **Standalone** — skills must not hard-depend on other skills
2. **Judgment-focused** — teach *when* and *why*, not just *what*
3. **Load on demand** — heavy content goes in `references/`, loaded only when needed
4. **Opinionated** — give clear recommendations, avoid false balance
5. **No duplication** — if content exists in a reference file, link to it rather than repeat

---

## Available Skills

| Skill | Description |
|-------|-------------|
| `super-brainstorming` | 6-phase structured ideation engine with decision matrices |
| `super-odoo18-development` | Senior Odoo 18 architect layer — decision trees, pitfalls, architecture, debugging, security |

---

## Task Guidelines for Agents

When working in this repository:

- **Creating a new skill:** Create `<skill-name>/SKILL.md` + `references/` folder
- **Updating a skill:** Edit files directly; maintain reference consistency
- **Do not** create external skill dependencies — embed necessary content instead
- **Do not** add files outside skill folders without explicit instruction
- **Do not** push to GitHub without confirming write access is configured

---

## Deployment

Skills are distributed via npm registry and installed by users:

```bash
npx skills add aldirrss/agent-skills --skill <skill-name> -a claude-code
```

Changes in this repo must be pushed to `aldirrss/agent-skills` on GitHub to be available.
