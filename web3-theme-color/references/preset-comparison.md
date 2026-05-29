# Preset Comparison — Which One to Pick?

## Quick Decision Matrix

| If the product is... | Pick |
|---|---|
| A general DApp, wallet, DEX, or you're unsure | **Solana** (default) |
| Enterprise DeFi, institutional, infrastructure dashboard | **Polygon** |
| NFT marketplace, social DApp, GameFi, anything playful | **Uniswap** |

## Detailed Comparison

### Solana — Energetic & Iconic (DEFAULT)

**Primary**: `#9945FF` (Purple) → `#14F195` (Mint Green)

**Strengths**
- The most recognizable "Web3 gradient" — users instantly read it as crypto
- High-contrast pairing works well on dark and light
- Two distinct accent colors give designers room to differentiate primary vs secondary CTAs

**Weaknesses**
- Green-purple combo may feel "loud" for serious financial products
- Mint green is hard to use on light backgrounds without desaturation

**Pick when**: General-purpose Web3 product, broad consumer audience, you want the design to feel unmistakably Web3.

---

### Polygon — Premium & Serious

**Primary**: `#8247E5` (Violet)

**Strengths**
- Single-color base is easier to scale into a 50-900 ramp
- Violet reads as "tech premium" without being aggressive
- Works for products where users transact with significant amounts

**Weaknesses**
- Less visually distinctive — many tech brands use violet
- No built-in secondary accent; you'll need to add one for variation

**Pick when**: Institutional DeFi, infrastructure tooling, B2B dashboards, products targeting users 35+.

---

### Uniswap — Bold & Playful

**Primary**: `#FF007A` (Hot Pink)

**Strengths**
- Stands out in a sea of blue/purple Web3 apps
- Pink + purple secondary creates a memorable identity
- Energetic, attention-grabbing — good for marketing-heavy products

**Weaknesses**
- May feel unserious for fintech use cases
- Pink-on-light requires significant darkening (we ship `#D81B60`)
- Can fatigue users in long sessions; use sparingly as accent, not surface

**Pick when**: NFT, gaming, social, creator economy, any product where personality > formality.

---

## Mixing Presets

You can pull tokens from multiple presets. Common pattern:

- **Solana base** + **Uniswap `--accent-tertiary`** for special CTAs (e.g., "Mint NFT" button)
- **Polygon base** + **Solana `--accent-mint`** for success states

When mixing, override only the specific tokens you need in a separate file loaded **after** the base preset.

```css
/* Load order matters */
@import "./presets/solana.css";
@import "./overrides/special-cta.css";  /* overrides --accent-tertiary */
```
