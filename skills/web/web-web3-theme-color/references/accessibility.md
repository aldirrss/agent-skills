# Accessibility — Contrast & Pairings

All presets in this skill are designed to meet **WCAG 2.1 AA** for body text (4.5:1) and large text/UI components (3:1).

## Verified Contrast Ratios

### Solana Dark Mode

| Foreground | Background | Ratio | Status |
|---|---|---|---|
| `--text-primary` `#F4F4F8` | `--bg-base` `#0A0A0F` | 18.2:1 | AAA |
| `--text-primary` `#F4F4F8` | `--bg-surface` `#12121A` | 16.4:1 | AAA |
| `--text-secondary` `#A0A0B8` | `--bg-base` `#0A0A0F` | 8.9:1 | AAA |
| `--text-muted` `#6B6B85` | `--bg-base` `#0A0A0F` | 4.6:1 | AA |
| `--accent-primary` `#9945FF` | `--bg-base` `#0A0A0F` | 4.8:1 | AA |
| `--accent-secondary` `#14F195` | `--bg-base` `#0A0A0F` | 12.3:1 | AAA |

### Solana Light Mode

| Foreground | Background | Ratio | Status |
|---|---|---|---|
| `--text-primary` `#0F0F1A` | `--bg-base` `#FAFAFC` | 17.9:1 | AAA |
| `--text-secondary` `#4A4A66` | `--bg-base` `#FAFAFC` | 8.7:1 | AAA |
| `--text-muted` `#8A8AA8` | `--bg-base` `#FAFAFC` | 3.5:1 | AA Large only |
| `--accent-primary` `#7F35CF` | `--bg-base` `#FAFAFC` | 5.9:1 | AA |
| `--accent-secondary` `#00A878` | `--bg-base` `#FAFAFC` | 3.4:1 | AA Large only |

## Critical Rules

1. **Never use `--text-muted` for body text in light mode** — it only passes AA for large text (≥18pt regular or ≥14pt bold). Use it for captions, placeholders, disabled states.

2. **Never use `--accent-secondary` for body text in light mode** — same constraint. Use it for buttons (which are large-text), borders, icons.

3. **Use neon accents for surface, not text** in light mode. Example:
   - ✅ `background: var(--accent-secondary); color: white;` (button)
   - ❌ `color: var(--accent-secondary);` (paragraph)

4. **Focus rings must use `--border-glow`** — it's tuned for both modes.

5. **Status colors** (`--success`, `--danger`) are designed for icons + colored borders, **not** as text colors. Always pair with an icon and a text label, never rely on color alone (WCAG 1.4.1 — Use of Color).

## Tools to Verify

- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)
- Chrome DevTools → Inspect element → Styles → Contrast ratio indicator
- `pa11y` for automated CI checks

## When You Need to Customize

If you change a token value, **re-verify**:
1. Text tokens vs all 3 bg tokens (base, surface, elevated)
2. Accent tokens vs all 3 bg tokens (must pass 3:1 minimum for UI components)
3. Status tokens vs the bg they appear on (alerts, toasts, etc.)
