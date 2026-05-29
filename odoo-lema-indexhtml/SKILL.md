---
name: odoo-lema-indexhtml
description: Generate Odoo app store description pages (static/description/index.html) that comply with the official Odoo Apps Store guidelines. Use when creating, editing, or reviewing the static/description/index.html of a Lema Core Odoo module. Produces a tabless, JavaScript-free, Bootstrap 4 compliant page with Hero, Brand Banner, Demo Preview, Screenshots, Features, Architecture, Changelog, FAQ, Related Products, and Footer sections.
---

# Lema Odoo App Description Page (index.html)

You are an expert in writing Odoo Apps Store description pages for Lema Core Technologies modules. Every page you generate must pass Odoo's automated validator and manual review on the first submission.

## When to use this skill

Trigger this skill when the user asks to:
- Create a new `static/description/index.html` for an Odoo module
- Rewrite or migrate an existing index.html to comply with Odoo guidelines
- Review an index.html for guideline violations
- Add or restructure Hero / Screenshots / Features / Architecture / Changelog / FAQ sections in a module description page

The skill also applies whenever the working file path matches `*/static/description/index.html` inside any `addons/lema/**` module.

## Hard Rules (Odoo Apps Store Validator)

These rules are NOT negotiable. The Odoo automated checker rejects any submission that violates them.

### Content
- **English only.** The full page, including comments inside HTML, must be in English regardless of the originating country or language. Never include Indonesian, Vietnamese, or other languages in the rendered page.
- **No promotions, no advertisements, no links to other app stores or external platforms.** Do not reference competing marketplaces, do not include affiliate links, do not promise discounts.
- **Accurate, non-misleading feature claims.** Every feature listed must match what the module actually ships.

### Allowed links
Only the following external link forms are permitted. Anything else gets invalidated by the validator.

| Allowed | Form |
|---|---|
| Local resources | `assets/...`, `icon.png`, paths inside `static/description/` |
| YouTube | Canonical URLs only (`https://www.youtube.com/watch?v=...` or `https://youtu.be/...`) |
| Microsoft Teams | Full Teams meeting links |
| Email | `mailto:address@example.com` |
| Skype | `skype:username?call` |

Everything else — Google Drive, Vimeo, Loom, app marketplaces, third-party blogs, social media (LinkedIn, X, Facebook, Instagram) — is forbidden as a link target.

### Forbidden HTML / CSS
- **No JavaScript.** No `<script>` tags. No inline `onclick=`, `onload=`, or any event handler attributes.
- **No static tags, static widgets, or modals.** Do not use Odoo's `<t t-call=...>`, `<t t-set=...>`, or any QWeb syntax. Do not use Bootstrap modal components (`data-bs-toggle="modal"`).
- **No iframes, no embeds, no external stylesheet links.** Do not include `<link rel="stylesheet" href="https://cdn...">`. All styling must be inline or via Bootstrap 4 classes that are already available.
- **No external font loaders** (no Google Fonts `<link>`). Use the system stack.
- **No `<style>` blocks with selectors that can leak** (`*`, `body`, `html`, attribute selectors targeting Odoo elements). Only minimal scoped rules if absolutely necessary.

### Allowed style attributes

The Apps Store sanitizer strictly limits inline style attributes. **Empirical evidence from deployed Lema modules** (lm_indonesia_bank_statement_import, May 2026) confirms the following behavior:

**Confirmed allowed (survives the sanitizer):**

- `color` — text color
- `background-color` (longhand only) — solid background color
- `font-*` (font-size, font-weight, font-family, font-style)
- `margin-*` (margin, margin-top, margin-right, margin-bottom, margin-left)
- `padding-*`
- `border-*` (border, border-radius, border-color, border-width, border-style, border-top/right/bottom/left)
- Bootstrap 4 utility classes (`row`, `col-*`, `mt-*`, `mb-*`, `p-*`, `text-center`, `d-flex`, `align-items-*`, `justify-content-*`, `flex-wrap`, `gap-*`, `g-*`)

**Confirmed stripped by the sanitizer — DO NOT USE:**

- `background:` (shorthand) — **always converted to nothing**. Even `background:#fff` solid color is stripped. Use `background-color:#fff` instead.
- `background-image:` — stripped (no gradients, no images via CSS)
- `linear-gradient(...)`, `radial-gradient(...)` — stripped entirely
- `box-shadow` — stripped (do not rely on shadows for visual hierarchy)
- `transform`, `transition`, `animation` — stripped
- `position: absolute/fixed`, `z-index` — stripped

**Untested / best-effort (use sparingly):**

- `width`, `height` — generally fine on `<img>` and small containers; avoid on layout wrappers
- `display`, `text-align`, `text-transform`, `letter-spacing`, `line-height`, `vertical-align`, `list-style`, `text-decoration` — appear in the reference template and render correctly in current deployments, but the sanitizer rules may change without notice

**The critical rule:** if a property is not in the "Confirmed allowed" list above, assume it will be stripped at upload time. The Apps Store does not warn you — your page just renders without that style. Always use `background-color:` longhand, never `background:` shorthand.

## Required Page Structure

Always produce these sections in this order. Section headings must be in English and visual styling must follow the Lema Core brand palette (see "Brand Tokens" below).

1. **Hero** — module name, one-paragraph value proposition, compatibility tags, primary contact buttons (Email Us, LinkedIn), deployment tags (Community / Enterprise / Odoo.sh / On-Premise). LinkedIn must be `https://www.linkedin.com/company/lemacore` — note: LinkedIn is not in the explicitly allowed list above, so if the validator rejects it, fall back to email-only contact buttons.
2. **Brand Banner** — `assets/brand.png` plus a short company description of Lema Core Technologies.
3. **Demo Preview** — a single demo image or animated GIF inside a monitor-style frame (`assets/video.gif` or `assets/screenshots/demo.png`).
4. **Screenshots** — multiple titled screenshot blocks. Each block has a centered title (two-color split), a descriptive caption, and one or more images.
5. **Features** — grouped tiles describing tools/capabilities. Group cards by color band (primary purple, secondary blue, accent green) and prefix each group with a small uppercase eyebrow label.
6. **Architecture** — system architecture diagram (built with flexbox + Font Awesome icons or static SVG/PNG), transport modes, technical specifications, and an optional dark-themed "production config" code preview.
7. **Changelog** — timeline-style list of versions, newest first, each version with a colored timeline dot, version number, month/year, and a row of tagged feature chips.
8. **FAQ** — collapsible Q&A using native `<details><summary>` elements (no JavaScript needed).
9. **Related Products** — Bootstrap 5 carousel block of 3–6 other Lema modules with module name and icon, linking to `https://apps.odoo.com/apps/modules/18.0/<module_technical_name>`. Use the exact markup shipped in `lm_ai_summary` / `lm_mcp_server` (already approved by the Odoo Apps Store validator): a `<section class="oe_container mt32">` wrapper with an `oe_slogan` heading, then `<div id="demo" class="row carousel slide" data-bs-ride="carousel">` containing two `carousel-item` slides of three `col-md-4` cards each, plus `carousel-control-prev` / `carousel-control-next` anchors. The Odoo Apps Store is the *source* platform, so internal apps.odoo.com links are acceptable; never link to non-Odoo marketplaces.
10. **Footer** — brand logo, version line (`Module Name v18.0 · OPL-1 License · © <year> Lema Core Technologies`), email and (optionally) LinkedIn.

A reference template implementing all ten sections in compliance mode is included at `references/template.html`. Use it as the starting point and only change copy, colors at the brand-token level, and section content.

## Key adaptations from the lm_mcp_server reference

The legacy `lm_mcp_server/static/description/index.html` was written before Lema enforced strict compliance. It uses **Bootstrap 5**, **jQuery**, **Owl Carousel**, **Google Fonts**, **Font Awesome via CDN**, and **JavaScript-driven tabs**. The compliant version must:

| Legacy (rejected) | Compliant rewrite |
|---|---|
| Bootstrap 5 CDN link | No external CSS — rely on Odoo's built-in Bootstrap 4 |
| `<script src="bootstrap.bundle.min.js">` | Remove entirely |
| jQuery `<script>` | Remove entirely |
| Owl Carousel `<script>` and CSS | Drop the Owl library; for Related Products use Bootstrap 5 carousel markup (`data-bs-ride="carousel"`) per the proven `lm_ai_summary` template — apps.odoo.com loads Bootstrap JS site-wide so the carousel animates without any local script |
| Google Fonts `<link href="fonts.googleapis.com">` | Remove — use system font stack via inline `font-family` |
| Font Awesome CDN | Replace icons with inline SVG inside `assets/icons/*.svg` OR omit icons; never depend on a remote CSS file |
| `<ul class="nav nav-tabs">` with `data-bs-toggle="tab"` | Flatten tabs into linear sections separated by horizontal rules and anchor links (`<a href="#features">`) |
| `data-bs-toggle="modal"` | Forbidden — use `<details><summary>` for expandable content |
| Owl Carousel for Related Products | Bootstrap 5 carousel (`<div class="carousel slide" data-bs-ride="carousel">`) with two `carousel-item` slides — same pattern shipped in `lm_ai_summary` and accepted by the Apps Store validator |
| `<script>` block at end of file | Remove entirely |

## Brand Tokens (Lema Core)

Use these color values consistently across the page:

- Primary purple: `#5b4da0`
- Primary dark: `#3f3274`
- Heading dark: `#16122a` / `#121212`
- Body muted: `#64728f`
- Surface light: `#f3f0ff` / `#fafafa`
- Border light: `#e0d9f5` / `#f0edf9`
- Accent blue: `#1565c0`
- Accent green: `#2e7d32`
- Accent teal: `#00897b`
- Accent warning: `#e65100`
- Accent danger: `#c62828`

Fonts: rely on the system stack — `font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;`. Never load a webfont.

### Icon convention

Card titles in the **Features** and **Technical Specifications** sections carry a small icon for visual rhythm. **Icons must be referenced as `<img src="assets/icons/...">`, never as inline `<svg>` elements** — Odoo's HTML sanitizer strips inline SVG when rendering the description in the Apps browser, leaving a blank space.

Use this convention:

| Location | Icon file | Title color | Size |
|---|---|---|---|
| Feature group 1 (Core / Primary, 3 cards) | `assets/icons/star-purple.svg` | `#3f3274` | 14×14 |
| Feature group 2 (Secondary, 3 cards) | `assets/icons/star-blue.svg` | `#0d47a1` | 14×14 |
| Feature group 3 (Accent, 3 cards) | `assets/icons/star-green.svg` | `#1b5e20` | 14×14 |
| All 4 tech spec cards (Dependencies / Deployment / Performance / Security) | `assets/icons/gear-purple.svg` | `#121212` (title), icon `#5b4da0` | 16×16 |

The exact markup is:

```html
<img src="assets/icons/star-purple.svg" alt="" width="14" height="14" style="vertical-align:-2px; margin-right:6px;"/>
```

The four SVG files (`star-purple.svg`, `star-blue.svg`, `star-green.svg`, `gear-purple.svg`) ship with this skill under `lema-odoo-indexhtml/assets/icons/` and are listed in the canonical assets table — copy them into the target module's `<module>/static/description/assets/icons/` folder during generation.

Invariants when extending or modifying icons:

- One consistent shape across the whole Features section (only the color varies by group)
- One consistent shape across the whole Tech Specs section
- Never inline an `<svg>` — Odoo sanitizer will strip it; always reference a file via `<img>`
- Color must be baked into the SVG `<path fill="...">` because `<img>`-referenced SVG cannot inherit `currentColor` from the parent

## Folder layout

Each module must keep description assets under:

```
<module>/static/description/
├── icon.png                       # 140×140 module icon (per-module)
├── index.html                     # this file
└── assets/
    ├── brand.png                  # ← COPY FROM lema-odoo-indexhtml/assets/brand.png (do not regenerate)
    ├── email.svg                  # ← COPY FROM lema-odoo-indexhtml/assets/email.svg (do not regenerate)
    ├── video.gif                  # demo animation (optional, per-module)
    ├── icons/
    │   ├── star-purple.svg        # ← COPY FROM lema-odoo-indexhtml/assets/icons/star-purple.svg
    │   ├── star-blue.svg          # ← COPY FROM lema-odoo-indexhtml/assets/icons/star-blue.svg
    │   ├── star-green.svg         # ← COPY FROM lema-odoo-indexhtml/assets/icons/star-green.svg
    │   └── gear-purple.svg        # ← COPY FROM lema-odoo-indexhtml/assets/icons/gear-purple.svg
    ├── screenshots/               # all screenshot PNGs (per-module)
    └── modules/                   # related-products thumbnails (1.png, 2.png, ...) (per-module)
```

Files marked **COPY FROM** are canonical assets bundled with this skill — see "Bundled canonical assets" below. Everything else is per-module content the developer prepares.

Only reference paths that exist in `static/description/`. The validator follows local image URLs and rejects broken paths.

## Pre-submission checklist

Before declaring the file ready, mentally walk through:

- [ ] Every `background-color:` is in longhand form — `grep "background:" index.html` must return 0 results (shorthand is silently stripped)
- [ ] No `linear-gradient(...)` or `box-shadow:` in any inline style
- [ ] Page renders without any external CSS/JS loaded
- [ ] No `<script>` tag anywhere in the file
- [ ] No `<iframe>`, `<embed>`, `<object>`, `<form>` tags
- [ ] No `data-bs-toggle` attributes that require JS
- [ ] No QWeb syntax (`t-*` attributes, `<t>` elements)
- [ ] Every external link is either `mailto:`, `skype:`, a canonical YouTube link, a Microsoft Teams link, or an `https://apps.odoo.com/...` Lema-module link
- [ ] All copy is English
- [ ] All image paths resolve inside `static/description/`
- [ ] FAQ uses `<details>` / `<summary>`, not modals or accordion JS
- [ ] Related Products uses the approved Bootstrap 5 carousel markup from `lm_ai_summary` (no separate `<script>` tag — Apps Store loads Bootstrap JS globally)
- [ ] Footer year and version match the module's `__manifest__.py`

## Generating the file

When the user asks for a new index.html:

1. Ask for the module's display name, technical name, one-paragraph value proposition, primary feature list, and Odoo version target if not already in the conversation context.
2. Copy the bundled canonical assets into the target module's `static/description/assets/`:
   - `lema-odoo-indexhtml/assets/brand.png` → `<module>/static/description/assets/brand.png`
   - `lema-odoo-indexhtml/assets/email.svg` → `<module>/static/description/assets/email.svg`
   - `lema-odoo-indexhtml/assets/icons/star-purple.svg` → `<module>/static/description/assets/icons/star-purple.svg`
   - `lema-odoo-indexhtml/assets/icons/star-blue.svg` → `<module>/static/description/assets/icons/star-blue.svg`
   - `lema-odoo-indexhtml/assets/icons/star-green.svg` → `<module>/static/description/assets/icons/star-green.svg`
   - `lema-odoo-indexhtml/assets/icons/gear-purple.svg` → `<module>/static/description/assets/icons/gear-purple.svg`
3. Start from `references/template.html` and write it to `<module>/static/description/index.html`.
4. Replace placeholders marked with `{{MODULE_NAME}}`, `{{MODULE_TAGLINE}}`, `{{MODULE_VERSION}}`, `{{ODOO_VERSION}}`, etc.
5. Drop sections that have no real content rather than padding them with filler — accuracy is required.
6. Confirm the per-module assets the developer must still supply (`icon.png`, screenshots under `assets/screenshots/`, optional `video.gif`, related-module thumbnails under `assets/modules/`).
7. Run through the pre-submission checklist before reporting completion.

When reviewing an existing file:

1. Read the file end-to-end.
2. Produce a violations table: location → rule broken → fix.
3. Offer to apply fixes inline.

## Reference files

- `references/template.html` — full compliant skeleton implementing all ten sections.
- `references/guidelines.md` — verbatim copy of the Odoo Apps Store guidelines for quick lookup.
- `references/violations-cheatsheet.md` — common review findings and their fixes.

## Bundled canonical assets

The skill ships brand assets that must be reused as-is across every Lema Core module — do not regenerate or substitute them.

| Skill path | Purpose | Copy to (in target module) |
|---|---|---|
| `assets/brand.png` | Lema Core Technologies brand banner used in Hero Banner (section 2) and Footer (section 10) | `<module>/static/description/assets/brand.png` |
| `assets/email.svg` | Email icon used in Hero contact button and Footer | `<module>/static/description/assets/email.svg` |
| `assets/icons/star-purple.svg` | Title icon for Features group 1 (3 cards) | `<module>/static/description/assets/icons/star-purple.svg` |
| `assets/icons/star-blue.svg` | Title icon for Features group 2 (3 cards) | `<module>/static/description/assets/icons/star-blue.svg` |
| `assets/icons/star-green.svg` | Title icon for Features group 3 (3 cards) | `<module>/static/description/assets/icons/star-green.svg` |
| `assets/icons/gear-purple.svg` | Title icon for all 4 Technical Specifications cards | `<module>/static/description/assets/icons/gear-purple.svg` |

**When generating a new module's description page:**

1. Copy `lema-odoo-indexhtml/assets/brand.png` → `<module>/static/description/assets/brand.png`
2. Copy `lema-odoo-indexhtml/assets/email.svg` → `<module>/static/description/assets/email.svg`
3. Create `<module>/static/description/assets/icons/` and copy all four icon SVGs (`star-purple.svg`, `star-blue.svg`, `star-green.svg`, `gear-purple.svg`) into it
4. Render the template with these paths already wired (the template already references `assets/brand.png`, `assets/email.svg`, and `assets/icons/*.svg` — no edits needed)

**Do not:**

- Re-export `brand.png` from a different source — the bundled file is the master copy approved for Apps Store use
- Replace `email.svg` with a Font Awesome `<i class="fa fa-envelope">` — that brings back the forbidden external CSS dependency
- Add new "canonical" assets directly into modules without first depositing them in this skill's `assets/` folder

If a future module needs an additional shared asset (e.g., a new `linkedin.svg`, `phone.svg`, or product-line logo), add it to `lema-odoo-indexhtml/assets/` first, then reference it from the template and from this table — that is how the convention propagates.
