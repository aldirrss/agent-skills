---
name: web3-theme-color
description: Web3 color theme system for Next.js / React TypeScript projects with full dark & light mode support. Provides production-ready CSS Variables tokens, three brand-inspired presets (Solana, Polygon, Uniswap), glassmorphism and neon glow utilities, and integration patterns with Tailwind CSS v4 and next-themes. Use whenever the user wants to build a Web3 / crypto / DeFi / NFT interface, set up dark/light theming for a Next.js or React app with a Web3 aesthetic, or needs a color palette that evokes a blockchain product feel.
---

# Web3 Theme Color System

Production-ready color system for Web3, crypto, DeFi, and NFT interfaces built with **Next.js / React + TypeScript**. Ships with full dark & light mode parity, three brand-inspired presets, and modern CSS techniques (glassmorphism, neon glow, gradient signature).

## When to use this skill

Trigger when the user asks to:

- Build a Web3 / crypto / DeFi / NFT / blockchain UI
- Set up dark/light theme for a Next.js or React TypeScript project with a "Web3 vibe"
- Pick a color palette for a wallet, DEX, marketplace, or DApp interface
- Apply glassmorphism, neon glow, or cyberpunk-style visual effects
- Integrate theme tokens with Tailwind CSS v4 or next-themes
- Migrate an existing app from generic Tailwind colors to a Web3 design language

Also trigger when the working file matches `app/globals.css`, `styles/theme*.css`, or `tailwind.config.*` in a project that imports `wagmi`, `viem`, `ethers`, `@solana/web3.js`, or `next-themes`.

## Core Principles

### 1. CSS Variables First (not SCSS)
- **Use native CSS Variables** in `:root` and `[data-theme="dark"]` selectors
- SCSS variables are compile-time only and cannot be toggled at runtime
- CSS Variables work seamlessly with `next-themes`, Tailwind v4 `@theme`, and SSR
- Never introduce `sass`/`scss` dependency unless the user explicitly requires it

### 2. One Token Name, Two Values
- Every semantic token (`--bg-base`, `--accent-primary`, `--text-primary`) must exist in **both** dark and light scopes with the same name
- Components reference token names only — never raw hex
- This guarantees instant theme switching with zero component changes

### 3. Semantic Naming Over Literal
- Use `--accent-primary`, not `--purple-500`
- Use `--bg-surface`, not `--gray-900`
- Literal names lock the palette; semantic names allow preset swaps

### 4. Accessibility Is Non-Negotiable
- Text vs background contrast must meet **WCAG AA (4.5:1)** for body text, **3:1** for large text
- Neon colors on light backgrounds usually fail — desaturate them in the light preset
- Never use pure neon as text color; reserve it for accents, borders, glows

### 5. Web3 Visual Signature
Web3 interfaces are recognizable by:
- **Gradient hero/CTA** (linear or conic, multi-stop)
- **Glow effects** (colored box-shadow, not gray)
- **Glassmorphism** (`backdrop-filter: blur()` + translucent surface + 1px border)
- **Monospace numerals** (JetBrains Mono, Geist Mono) for hashes, addresses, amounts

## Presets

Three presets ship with this skill. **Solana is the default** because its purple→mint gradient is the most "Web3-coded" visual signature.

| Preset | File | Vibe | Best For |
|---|---|---|---|
| **Solana** (default) | [presets/solana.css](presets/solana.css) | Purple → Mint gradient, energetic | DEX, wallet, general DApp |
| **Polygon** | [presets/polygon.css](presets/polygon.css) | Violet mono, premium/serious | Enterprise DeFi, infrastructure |
| **Uniswap** | [presets/uniswap.css](presets/uniswap.css) | Hot pink, bold/playful | NFT marketplace, social DApp, game |

User can also combine: e.g. Solana base + Uniswap accent for CTAs.

## Token Catalog

Every preset exposes the same token names. Components only reference these.

### Background
- `--bg-base` — page background
- `--bg-surface` — cards, panels
- `--bg-elevated` — modals, dropdowns, popovers
- `--bg-overlay` — backdrop scrim (with alpha)

### Border
- `--border-subtle` — barely-visible dividers
- `--border-default` — standard component borders
- `--border-glow` — accent-tinted, for focus rings & hover

### Text
- `--text-primary` — body, headings
- `--text-secondary` — supporting copy
- `--text-muted` — captions, placeholders, disabled

### Accent
- `--accent-primary` — primary CTA, brand
- `--accent-secondary` — secondary actions, links
- `--accent-tertiary` — highlight, badges
- `--accent-gold` — premium tier, rewards (crypto gold)
- `--accent-mint` — success-adjacent, confirmation

### Status
- `--success`, `--warning`, `--danger`, `--info`

### Gradient (signature)
- `--gradient-hero` — multi-stop, for hero sections & primary CTAs
- `--gradient-card` — subtle, for card backgrounds
- `--gradient-glow` — radial, for ambient lighting effects

### Shadow / Glow
- `--shadow-sm`, `--shadow-md`, `--shadow-lg` — neutral elevation
- `--glow-primary`, `--glow-secondary` — colored glow for hover/focus

## Workflow

### Step 1 — Pick a preset
Ask the user which vibe they want, or default to **Solana**. Reference [references/preset-comparison.md](references/preset-comparison.md) if they're unsure.

### Step 2 — Install the tokens
Copy the chosen preset CSS into `app/globals.css` (Next.js App Router) or `styles/globals.css` (Pages Router). Tokens must be the **first** import after Tailwind directives.

### Step 3 — Wire up `next-themes`
```bash
npm install next-themes
```
Wrap the app root with `<ThemeProvider attribute="data-theme" defaultTheme="dark">`. The presets target `[data-theme="dark"]` and `[data-theme="light"]` selectors.

See [examples/next-themes-setup.tsx](examples/next-themes-setup.tsx).

### Step 4 — Integrate with Tailwind v4 (optional but recommended)
Use `@theme` to expose CSS Variables as Tailwind utilities:

```css
@theme {
  --color-bg-base: var(--bg-base);
  --color-accent-primary: var(--accent-primary);
  /* ... */
}
```

Then `bg-bg-base`, `text-accent-primary` work as utilities. See [examples/tailwind-v4-integration.css](examples/tailwind-v4-integration.css).

### Step 5 — Apply effects
- Glassmorphism cards → [examples/glassmorphism.css](examples/glassmorphism.css)
- Neon glow buttons → [examples/neon-glow.css](examples/neon-glow.css)
- Gradient hero → [examples/gradient-hero.css](examples/gradient-hero.css)

## Hard Rules

1. **Never hardcode hex values in components.** All colors must reference CSS Variables.
2. **Never set color on the `<body>` without also setting it under both `[data-theme="dark"]` and `[data-theme="light"]`.** Half-themed pages flash on theme switch.
3. **Never use pure neon (`#00FFA3`, `#FF2E93`) as text color in light mode.** Use the desaturated light-mode variants from the preset.
4. **Always set `color-scheme: dark` / `light`** on the html element under each theme scope so native form controls match.
5. **Never use SCSS variables (`$primary`) for theming.** They cannot be runtime-switched. Use CSS Variables (`var(--primary)`).
6. **Always test contrast.** Run text colors through a WCAG checker against both bg surfaces before shipping.
7. **Suppress hydration mismatch** when using `next-themes` — add `suppressHydrationWarning` to the `<html>` tag.

## References

- [references/preset-comparison.md](references/preset-comparison.md) — When to pick which preset
- [references/brand-inspiration.md](references/brand-inspiration.md) — Why these brand colors work for Web3
- [references/accessibility.md](references/accessibility.md) — Contrast tables and accessible pairings

## Examples

- [examples/next-themes-setup.tsx](examples/next-themes-setup.tsx) — Theme provider wiring
- [examples/theme-toggle.tsx](examples/theme-toggle.tsx) — Dark/light toggle button
- [examples/tailwind-v4-integration.css](examples/tailwind-v4-integration.css) — Tailwind v4 `@theme`
- [examples/glassmorphism.css](examples/glassmorphism.css)
- [examples/neon-glow.css](examples/neon-glow.css)
- [examples/gradient-hero.css](examples/gradient-hero.css)
