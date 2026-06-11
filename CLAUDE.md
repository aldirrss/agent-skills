# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## What This Repo Is

A curated collection of Claude Code / Claude Agent SDK skills, published as the `@aldirrss/skills` npm package. Skills are self-contained folders installed into `~/.claude/skills/` so Claude Code can auto-load them by matching `description:` against the current task.

**Important:** `bin/skills.js` fetches from the GitHub repo `aldirrss/agent-skills` (not `dev-skills`). The `REPO` constant in [bin/skills.js](bin/skills.js) controls this.

## CLI Commands

```bash
# Development
node bin/skills.js list               # list all skills
node bin/skills.js list odoo          # list by category
node bin/skills.js add odoo-18        # install a skill
node bin/skills.js add odoo           # install a whole category
node bin/skills.js add --all          # install everything
node bin/skills.js add odoo-18 --target .claude/skills  # project-level install
node bin/skills.js remove odoo-16     # uninstall
node bin/skills.js info odoo-18       # preview SKILL.md

# Via npx (production)
npx @aldirrss/skills list
npx @aldirrss/skills add odoo-18
```

Set `GITHUB_TOKEN` to avoid GitHub API rate limits when running `list`, `add`, or `info`.

## Repository Layout

```
skills/<category>/<skill-name>/   # skills grouped by category
bin/skills.js                     # zero-dependency CLI
docs/                             # crypto-futures project bootstrap templates
graphify-out/                     # knowledge graph (do not edit manually)
```

### Skill Categories

| Category | Contents |
|----------|----------|
| `crypto/` | Futures trading bot (architecture, engine, API, dashboard, monitoring, DB schema, strategies) |
| `odoo/` | Odoo 16–19 development references, OWL, senior/super roles |
| `web/` | TypeScript, NestJS, Web3 theme |
| `web3/` | Solana (architecture, engine, scanner, monitor, execution, risk, strategy, DB schema, agent) |
| `lang/` | Python best practices |
| `devops/` | Docker, CI/CD, Git workflow |
| `general/` | Brainstorming, clean architecture, code review |

## Skill Structure

Every skill must have a `SKILL.md` with this frontmatter:

```markdown
---
name: <kebab-case — must match folder name>
description: >
  One sentence describing when Claude should auto-load this skill.
globs: "**/*.{py,xml}"   # optional — file patterns that trigger auto-load
---
```

Optional subdirectories: `references/` (long-form docs), `examples/` (code snippets), `assets/` (binary files).

## Adding a New Skill

1. Create `skills/<category>/<skill-name>/SKILL.md` with valid frontmatter.
2. `name:` must exactly match the folder name.
3. Keep `description:` specific enough that Claude loads it only when truly relevant.
4. Large reference material goes in `references/` and is linked from `SKILL.md` — do not dump everything into the main body.

## docs/ Bootstrap Templates

`docs/` is **not** skills — it contains copy-paste project starters for the `crypto-futures-*` skill family:

| Template | Purpose |
|----------|---------|
| `docs/architectures/crypto-futures/ARCHITECTURE.md` | System topology and data flows |
| `docs/roadmap/crypto-futures/ROADMAP.md` | 4-phase build roadmap |
| `docs/memory/crypto-futures/CLAUDE.md` | Mandatory rules and Redis conventions for new projects |
| `docs/prompts/crypto-futures/` | Step-by-step Claude Code build prompts |
