# dev-skills

A curated collection of Claude Code / Claude Agent SDK skills, organized by domain. Each skill is a self-contained folder with a `SKILL.md` manifest and any supporting references, examples, or assets.

## Repository Layout

Skills are kept **flat at the repo root** and grouped by a **category prefix** in the folder name. This keeps installers (which usually scan only the root for `SKILL.md`) working while still grouping related skills together alphabetically.

```
dev-skills/
├── crypto-futures/                    # Exchange integration, safety rules, risk sizing
├── crypto-futures-strategies/         # 6 trading strategies + price structure (SMC/ICT)
├── crypto-futures-bot-architecture/   # Process topology, Redis schema, worker lifecycle
├── crypto-futures-bot-db-schema/      # PostgreSQL models, migrations, query patterns
├── crypto-futures-bot-engine/         # Bot engine components (asyncio)
├── crypto-futures-bot-api/            # FastAPI server, auth, WebSocket relay
├── crypto-futures-bot-monitoring/     # Metrics, health checks, Telegram alerts
├── crypto-futures-bot-dashboard/      # Next.js dashboard, charts, position panel
│
├── odoo-16/                           # Odoo 16 development reference
├── odoo-17/                           # Odoo 17 development reference
├── odoo-18/                           # Odoo 18 development reference
├── odoo-19/                           # Odoo 19 development reference
├── odoo-owl/                          # OWL frontend framework guidance
├── odoo-senior-developer/             # Senior-level Odoo architect (all versions)
├── odoo-super-18-development/         # Elite Odoo 18 guidance
├── odoo-lema-indexhtml/               # Odoo App Store description page generator
│
├── web-typescript/                    # TypeScript best practices
├── web-nestjs-clean/                  # Clean NestJS API development
├── web-web3-theme-color/              # Web3 color theme system for Next.js / React
│
├── lang-python/                       # Python best practices
│
├── devops-docker/                     # Docker containerization
├── devops-cicd/                       # CI/CD pipelines and DevOps workflows
├── devops-git-workflow/               # Git conventions and branching strategy
│
├── general-brainstorming/             # Pre-implementation discovery and design
├── general-clean-architecture/        # Clean Architecture patterns
├── general-code-review/               # Code review reception and verification gates
│
└── docs/                              # Project bootstrap templates (not skills)
    ├── architectures/crypto-futures/  # ARCHITECTURE.md template
    ├── memory/crypto-futures/         # CLAUDE.md template
    ├── prompts/crypto-futures/        # Step-by-step build prompts (Phase 1)
    └── roadmap/crypto-futures/        # ROADMAP.md template
```

### Categories

| Prefix | Purpose |
| --- | --- |
| `crypto-futures-*` | Crypto futures trading bot (exchange, strategies, engine, API, dashboard, monitoring) |
| `odoo-*` | Odoo ERP development (versioned references, OWL, App Store) |
| `web-*` | Web / frontend / backend frameworks and theming |
| `lang-*` | General-purpose programming languages |
| `devops-*` | Containerization, CI/CD, version control |
| `general-*` | Cross-cutting practices (review, architecture, ideation) |

---

## Installation

### Install a single skill

```bash
git clone https://github.com/aldirrss/dev-skills.git
cd dev-skills

# User-level — available across all projects
cp -r odoo-18 ~/.claude/skills/

# Project-level — only this project
cp -r web-typescript .claude/skills/
```

### Install a skill collection

Some skills are designed to work together. Install the whole group at once:

```bash
# All crypto-futures skills (recommended if building a futures bot)
cp -r crypto-futures crypto-futures-strategies \
      crypto-futures-bot-architecture crypto-futures-bot-db-schema \
      crypto-futures-bot-engine crypto-futures-bot-api \
      crypto-futures-bot-monitoring crypto-futures-bot-dashboard \
      ~/.claude/skills/

# All odoo skills
cp -r odoo-16 odoo-17 odoo-18 odoo-19 odoo-owl \
      odoo-senior-developer odoo-super-18-development odoo-lema-indexhtml \
      ~/.claude/skills/
```

### Clone everything

If you want every skill available at once:

```bash
git clone https://github.com/aldirrss/dev-skills.git ~/.claude/skills/dev-skills
```

> Claude scans subfolders of `~/.claude/skills/` for `SKILL.md`. Because every skill folder sits at the top level of this repo, all of them will be picked up.

### Stay in sync with symlinks

```bash
git clone https://github.com/aldirrss/dev-skills.git ~/repos/dev-skills

# Symlink only the skills you want
ln -s ~/repos/dev-skills/odoo-18             ~/.claude/skills/odoo-18
ln -s ~/repos/dev-skills/crypto-futures      ~/.claude/skills/crypto-futures
ln -s ~/repos/dev-skills/devops-docker       ~/.claude/skills/devops-docker
```

Pull updates with `git pull` inside `~/repos/dev-skills`.

---

## Using a Skill

After installation, Claude Code auto-loads any skill whose `description:` matches the current task. You can also invoke a skill explicitly:

```
/crypto-futures
/odoo-18
/devops-docker
/general-code-review
```

To inspect what a skill does, read its `SKILL.md` — the frontmatter holds `name:` and `description:` (Claude uses this to decide when to load it), and the body contains the actual guidance.

---

## Project Bootstrap (crypto-futures)

The `docs/` folder contains copy-paste templates for starting a new project
built on the `crypto-futures-*` skill set:

| Template | Copy to | Purpose |
| --- | --- | --- |
| `docs/architectures/crypto-futures/ARCHITECTURE.md` | `docs/ARCHITECTURE.md` | System topology, data flows, design decisions |
| `docs/roadmap/crypto-futures/ROADMAP.md` | `docs/ROADMAP.md` | 4-phase roadmap with checklists |
| `docs/memory/crypto-futures/CLAUDE.md` | `CLAUDE.md` | Mandatory rules, skills map, Redis conventions |
| `docs/prompts/crypto-futures/` | Use in Claude Code | Step-by-step build prompts (Phase 1, 8 phases) |

---

## Skill Structure

Each skill follows this layout:

```
<skill-name>/
├── SKILL.md            # required — frontmatter + guidance body
├── references/         # optional — long-form reference docs
├── examples/           # optional — code snippets, templates
└── assets/             # optional — images, icons, binary files
```

Minimum `SKILL.md` frontmatter:

```markdown
---
name: <kebab-case-name-matching-folder>
description: One sentence describing when Claude should load this skill.
---

# <Skill Title>

<body content...>
```

---

## Contributing

1. Fork and clone the repo.
2. Create a new folder using the appropriate category prefix (`crypto-futures-*`, `odoo-*`, `web-*`, `lang-*`, `devops-*`, `general-*`).
3. Add a `SKILL.md` with `name:` matching the folder name.
4. Open a pull request.

Keep the `description:` field precise — it is the only field Claude reads to decide whether to load your skill.

## License

MIT. See [LICENSE](LICENSE).
