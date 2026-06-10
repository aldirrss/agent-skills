# dev-skills

A curated collection of Claude Code / Claude Agent SDK skills, organized by domain. Each skill is a self-contained folder with a `SKILL.md` manifest and any supporting references, examples, or assets.

## Repository Layout

Skills live under `skills/<category>/<skill-name>/`. The CLI installer flattens them into `~/.claude/skills/<skill-name>/` so Claude Code can pick them up.

```
dev-skills/
├── skills/
│   ├── crypto/
│   │   ├── crypto-futures/                   # Exchange integration, safety rules, risk sizing
│   │   ├── crypto-futures-strategies/        # 6 trading strategies + price structure (SMC/ICT)
│   │   ├── crypto-futures-bot-architecture/  # Process topology, Redis schema, worker lifecycle
│   │   ├── crypto-futures-bot-db-schema/     # PostgreSQL models, migrations, query patterns
│   │   ├── crypto-futures-bot-engine/        # Bot engine components (asyncio)
│   │   ├── crypto-futures-bot-api/           # FastAPI server, auth, WebSocket relay
│   │   ├── crypto-futures-bot-monitoring/    # Metrics, health checks, Telegram alerts
│   │   └── crypto-futures-bot-dashboard/     # Next.js dashboard, charts, position panel
│   │
│   ├── odoo/
│   │   ├── odoo-16/                          # Odoo 16 development reference
│   │   ├── odoo-17/                          # Odoo 17 development reference
│   │   ├── odoo-18/                          # Odoo 18 development reference
│   │   ├── odoo-19/                          # Odoo 19 development reference
│   │   ├── odoo-owl/                         # OWL frontend framework guidance
│   │   ├── odoo-senior-developer/            # Senior-level Odoo architect (all versions)
│   │   ├── odoo-super-18-development/        # Elite Odoo 18 guidance
│   │   └── odoo-lema-indexhtml/              # Odoo App Store description page generator
│   │
│   ├── web/
│   │   ├── web-typescript/                   # TypeScript best practices
│   │   ├── web-nestjs-clean/                 # Clean NestJS API development
│   │   └── web-web3-theme-color/             # Web3 color theme system for Next.js / React
│   │
│   ├── lang/
│   │   └── lang-python/                      # Python best practices
│   │
│   ├── devops/
│   │   ├── devops-docker/                    # Docker containerization
│   │   ├── devops-cicd/                      # CI/CD pipelines and DevOps workflows
│   │   └── devops-git-workflow/              # Git conventions and branching strategy
│   │
│   └── general/
│       ├── general-brainstorming/            # Pre-implementation discovery and design
│       ├── general-clean-architecture/       # Clean Architecture patterns
│       └── general-code-review/              # Code review reception and verification gates
│
├── bin/
│   └── skills.js                             # CLI tool (zero dependencies)
├── package.json
└── docs/                                     # Project bootstrap templates (not skills)
    ├── architectures/crypto-futures/
    ├── memory/crypto-futures/
    ├── prompts/crypto-futures/
    └── roadmap/crypto-futures/
```

---

## Installation

### via npx (recommended)

```bash
# List all available skills
npx @aldirrss/skills list

# Install a single skill
npx @aldirrss/skills add odoo-18

# Install an entire category
npx @aldirrss/skills add odoo
npx @aldirrss/skills add crypto

# Install everything
npx @aldirrss/skills add --all

# Install to project-level instead of user-level
npx @aldirrss/skills add odoo-18 --target .claude/skills

# Remove a skill
npx @aldirrss/skills remove odoo-16

# Preview a skill's content
npx @aldirrss/skills info odoo-18
```

> Set `GITHUB_TOKEN` to avoid GitHub API rate limits on large installs.

### via npm global install

```bash
npm install -g @aldirrss/skills

skills list
skills add odoo-18
skills add --all
```

### Manual (git clone)

```bash
git clone https://github.com/aldirrss/dev-skills.git
cp -r dev-skills/skills/odoo/odoo-18 ~/.claude/skills/
```

---

## Using a Skill

After installation, Claude Code auto-loads any skill whose `description:` matches the current task. You can also invoke explicitly:

```
/odoo-18
/crypto-futures-bot-api
/devops-docker
/general-code-review
```

---

## Skill Structure

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
```

---

## Project Bootstrap (crypto-futures)

The `docs/` folder contains copy-paste templates for starting a new project built on the `crypto-futures-*` skill set:

| Template | Copy to | Purpose |
| --- | --- | --- |
| `docs/architectures/crypto-futures/ARCHITECTURE.md` | `docs/ARCHITECTURE.md` | System topology, data flows, design decisions |
| `docs/roadmap/crypto-futures/ROADMAP.md` | `docs/ROADMAP.md` | 4-phase roadmap with checklists |
| `docs/memory/crypto-futures/CLAUDE.md` | `CLAUDE.md` | Mandatory rules, skills map, Redis conventions |
| `docs/prompts/crypto-futures/` | Use in Claude Code | Step-by-step build prompts (Phase 1, 8 phases) |

---

## Contributing

1. Fork and clone the repo.
2. Create a folder under the matching category: `skills/<category>/<skill-name>/`.
3. Add a `SKILL.md` with `name:` matching the folder name.
4. Open a pull request.

## License

MIT.
