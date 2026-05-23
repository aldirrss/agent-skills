---
name: lema-odoo-indexhtml
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
The validator strictly limits inline style attributes to the following families. Anything else may be stripped or trigger a rejection.

- `color`, `background`, `background-color`, `background-image`
- `font-*` (font-size, font-weight, font-family, font-style)
- `margin-*` (margin, margin-top, margin-right, margin-bottom, margin-left)
- `padding-*`
- `border-*` (border, border-radius, border-color, border-width, border-style)
- Bootstrap 4 utility classes for layout (`row`, `col-*`, `mt-*`, `mb-*`, `p-*`, `text-center`, `d-flex`, `align-items-*`, `justify-content-*`, `flex-wrap`, `gap-*`, `g-*`)

Other rules such as `width`, `height`, `display`, `box-shadow`, `text-transform`, `letter-spacing`, `line-height`, `list-style`, `text-decoration` are commonly accepted in practice (they appear in the reference template), but treat them as best-effort and avoid combining them with anything that could be interpreted as harmful (positioning, transforms, animations, z-index manipulation).

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

Card titles in the **Features** and **Technical Specifications** sections carry a small inline-SVG icon for visual rhythm. Use the following convention:

| Location | Icon shape | Color rule | Size |
|---|---|---|---|
| All 9 feature cards (`<h6>`) | Filled star | `fill="currentColor"` — inherits the per-group title color (#3f3274 purple, #0d47a1 blue, #1b5e20 green) | 14×14 |
| All 4 tech spec cards (`<h5>` for Dependencies / Deployment / Performance / Security) | Filled gear (Material settings) | Fixed `fill="#5b4da0"` to match the eyebrow heading | 16×16 |

Both icons are inline `<svg>` with `xmlns`, `viewBox="0 0 24 24"`, and inline `style="vertical-align:-2px; margin-right:6px;"` — no external CSS, no font icon library. Copy the exact markup from `references/template.html`; do not swap in Font Awesome classes.

If you ever change icon shape, keep these invariants:

- One consistent shape across the whole Features section (do not vary icons per card)
- One consistent shape across the whole Tech Specs section
- Always `fill="currentColor"` when you want the icon to match its group color, or a hardcoded hex when you want it fixed regardless of context

## Folder layout

Each module must keep description assets under:

```
<module>/static/description/
├── icon.png              # 140×140 module icon
├── index.html            # this file
└── assets/
    ├── brand.png         # Lema Core brand image
    ├── email.svg         # inline-safe icon
    ├── linkedin.svg
    ├── video.gif         # demo animation (optional)
    ├── icons/            # optional SVG icons replacing Font Awesome
    ├── screenshots/      # all screenshot PNGs
    └── modules/          # related-products thumbnails (1.png, 2.png, ...)
```

Only reference paths that exist in `static/description/`. The validator follows local image URLs and rejects broken paths.

## Pre-submission checklist

Before declaring the file ready, mentally walk through:

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
2. Start from `references/template.html`.
3. Replace placeholders marked with `{{MODULE_NAME}}`, `{{MODULE_TAGLINE}}`, `{{MODULE_VERSION}}`, `{{ODOO_VERSION}}`, etc.
4. Drop sections that have no real content rather than padding them with filler — accuracy is required.
5. Run through the pre-submission checklist before reporting completion.

When reviewing an existing file:

1. Read the file end-to-end.
2. Produce a violations table: location → rule broken → fix.
3. Offer to apply fixes inline.

## Reference files

- `references/template.html` — full compliant skeleton implementing all ten sections.
- `references/guidelines.md` — verbatim copy of the Odoo Apps Store guidelines for quick lookup.
- `references/violations-cheatsheet.md` — common review findings and their fixes.
