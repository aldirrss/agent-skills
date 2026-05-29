# dev-skills

A curated collection of Claude Code / Claude Agent SDK skills, organized by domain. Each skill is a self-contained folder with a `SKILL.md` manifest and any supporting references, examples, or assets.

## Repository Layout

Skills are kept **flat at the repo root** and grouped by a **category prefix** in the folder name. This keeps installers (which usually scan only the root for `SKILL.md`) working while still grouping related skills together alphabetically.

```
dev-skills/
├── odoo-16/                       # Odoo 16 development reference
├── odoo-17/                       # Odoo 17 development reference
├── odoo-18/                       # Odoo 18 development reference
├── odoo-19/                       # Odoo 19 development reference
├── odoo-owl/                      # OWL frontend framework guidance
├── odoo-senior-developer/         # Senior-level Odoo architect (all versions)
├── odoo-super-18-development/     # Elite Odoo 18 guidance
├── odoo-lema-indexhtml/           # Odoo App Store description page generator
│
├── web-typescript/                # TypeScript best practices
├── web-nestjs-clean/              # Clean NestJS API development
├── web-web3-theme-color/          # Web3 color theme system for Next.js / React
│
├── lang-python/                   # Python best practices
│
├── devops-docker/                 # Docker containerization
├── devops-cicd/                   # CI/CD pipelines and DevOps workflows
├── devops-git-workflow/           # Git conventions and branching strategy
│
├── general-brainstorming/         # Pre-implementation discovery and design
├── general-clean-architecture/    # Clean Architecture patterns
└── general-code-review/           # Code review reception and verification gates
```

### Categories

| Prefix      | Purpose                                                      |
| ----------- | ------------------------------------------------------------ |
| `odoo-*`    | Odoo ERP development (versioned references, OWL, App Store)  |
| `web-*`     | Web / frontend / backend frameworks and theming              |
| `lang-*`    | General-purpose programming languages                        |
| `devops-*`  | Containerization, CI/CD, version control                     |
| `general-*` | Cross-cutting practices (review, architecture, ideation)     |

## Installation

### Option 1 — Per-skill copy (recommended)

Copy only the skills you need into your Claude skills directory:

```bash
git clone https://github.com/aldirrss/dev-skills.git
cd dev-skills

# User-level (available across all projects)
mkdir -p ~/.claude/skills
cp -r odoo-18 ~/.claude/skills/

# Project-level (only this project)
mkdir -p .claude/skills
cp -r web-typescript .claude/skills/
```

Claude Code will discover the skill on its next session start.

### Option 2 — Clone everything

If you want every skill available at once:

```bash
git clone https://github.com/aldirrss/dev-skills.git ~/.claude/skills/dev-skills
```

> Claude scans subfolders of `~/.claude/skills/` for `SKILL.md`. Because every folder in this repo sits at the top level, all of them will be picked up.

### Option 3 — Symlink (stay in sync with `git pull`)

```bash
git clone https://github.com/aldirrss/dev-skills.git ~/repos/dev-skills

# Symlink only the skills you want
ln -s ~/repos/dev-skills/odoo-18        ~/.claude/skills/odoo-18
ln -s ~/repos/dev-skills/devops-docker  ~/.claude/skills/devops-docker
```

Pull updates with `git pull` inside `~/repos/dev-skills`.

## Using a Skill

After installation, Claude Code auto-loads any skill whose `description:` matches the current task. You can also invoke a skill explicitly:

```
/odoo-18
/devops-docker
/general-code-review
```

To inspect what a skill does, read its `SKILL.md` — the frontmatter holds `name:` and `description:` (Claude uses this to decide when to load it), and the body contains the actual guidance.

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

## Contributing

1. Fork and clone the repo.
2. Create a new folder using the appropriate category prefix (`odoo-*`, `web-*`, `lang-*`, `devops-*`, `general-*`).
3. Add a `SKILL.md` with `name:` matching the folder name.
4. Open a pull request.

Keep the `description:` field precise — it is the only field Claude reads to decide whether to load your skill.

## License

MIT. See [LICENSE](LICENSE).
