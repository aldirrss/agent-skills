# CLAUDE.md — Skills Development Project

## Project Overview

Repository ini berisi custom AI Agent Skills untuk Claude Code dan Claude.ai,
dikembangkan oleh Aldi (Odoo engineer di Lema Core Technologies).

**GitHub:** `aldirrss/agent-skills`
**Install skill:** `npx skills add aldirrss/agent-skills --skill <nama-skill> -a claude-code`

---

## Struktur Repository

```
skills-dev/
├── super-brainstorming/        # 6-phase elite ideation engine
│   ├── SKILL.md
│   └── references/
│       ├── decision-frameworks.md
│       └── domain-patterns.md
├── super-odoo18-development/   # Senior Odoo 18 architect layer (standalone)
│   ├── SKILL.md
│   └── references/
│       ├── decision-trees.md
│       ├── pitfalls.md
│       ├── architecture.md
│       ├── debugging.md
│       ├── code-quality.md
│       └── odoo-18-security-guide.md
├── CLAUDE.md                   # Ini
└── AGENTS.md                   # Untuk agent lain (OpenAI, Gemini, dll)
```

---

## Konvensi Skill

### Struktur Setiap Skill

```
<skill-name>/
├── SKILL.md          # Entry point — frontmatter + konten utama
└── references/       # File pendukung, di-load on demand
    └── *.md
```

### Frontmatter SKILL.md (Wajib)

```yaml
---
name: nama-skill
description: >
  Deskripsi lengkap. Ini yang dipakai AI untuk memutuskan kapan skill dipakai.
  Sertakan trigger words yang relevan.
globs: "**/*.{py,xml,csv}"   # File types yang relevan
---
```

### Prinsip Desain Skill

- **Standalone by default** — skill tidak boleh hard-depend ke skill lain
- **Load on demand** — konten berat diletakkan di `references/`, dipanggil saat dibutuhkan
- **Judgment over syntax** — skill mengajarkan *kapan* dan *kenapa*, bukan hanya *apa*
- **Opinionated** — berikan rekomendasi jelas, bukan false balance

---

## Workflow Development

### Membuat Skill Baru

1. Buat folder `<skill-name>/`
2. Buat `SKILL.md` dengan frontmatter yang lengkap
3. Buat folder `references/` untuk konten detail
4. Test skill dengan invoke di Claude Code
5. Push ke GitHub: `aldirrss/agent-skills`

### Mengupdate Skill yang Ada

- Edit file langsung di folder skill
- Jaga konsistensi referensi antar file
- Jangan buat dependency ke skill eksternal jika bisa di-embed

---

## Skills yang Ada

| Skill | Status | Deskripsi |
|-------|--------|-----------|
| `super-brainstorming` | ✅ Di repo | 6-phase elite ideation engine |
| `super-odoo18-development` | ⏳ Pending push | Senior Odoo 18 architect layer, standalone |

---

## Catatan Penting

- GitHub MCP write access perlu diupdate di `github.com/settings/installations`
  sebelum bisa push langsung via MCP
- Skills di-install user via `npx skills add`, bukan dipakai langsung dari repo ini
- File `references/` tidak perlu di-load semua — hanya yang relevan dengan task
