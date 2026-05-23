# Common Violations and Fixes

Quick reference for reviewing an existing `static/description/index.html`.

## JavaScript-related violations

| Symptom | Violation | Fix |
|---|---|---|
| `<script src="...">` anywhere | JavaScript not allowed | Remove the tag entirely |
| `<script>...</script>` inline | JavaScript not allowed | Remove the tag entirely |
| `onclick`, `onload`, `onmouseover`, etc. on any element | Inline JS handlers not allowed | Strip the attribute; if the element is a tab/button toggle, replace with anchor links or `<details>` |
| `data-bs-toggle="tab"` or `data-bs-toggle="modal"` | Requires Bootstrap JS bundle | Flatten tabs into linear sections; replace modals with `<details>` or expanded content |
| `data-bs-ride="carousel"` outside the Related Products block | Bootstrap JS reliance not allowed for content tabs/sliders | Replace the offending area with a static `row` of cards. Related Products is the documented exception — `lm_ai_summary` ships the carousel and was accepted by the validator |

## External resource violations

| Symptom | Violation | Fix |
|---|---|---|
| `<link rel="stylesheet" href="https://cdn...">` | External CSS forbidden | Remove; rely on Odoo's built-in Bootstrap 4 |
| `<link href="fonts.googleapis.com/...">` | External font forbidden | Remove; use system font stack via inline `font-family` |
| `<link href=".../font-awesome/...">` | External icon CSS forbidden | Replace icons with inline SVG under `assets/icons/` |
| `<iframe src="...">` | Iframes not allowed | Remove; if it was a YouTube video, replace with a canonical YouTube link |
| Link to `vimeo.com`, `loom.com`, `drive.google.com`, etc. | Only YouTube canonical + Teams + mailto + skype allowed | Remove the link or rehost the asset under `static/description/assets/` |
| Link to Twitter, LinkedIn (personal), Facebook, Instagram | Social media generally not allowed | Remove. LinkedIn company pages have been accepted in practice but may still be flagged — keep email-only contact as the safe default |

## QWeb / Odoo template violations

| Symptom | Violation | Fix |
|---|---|---|
| `<t t-call="...">` | Static tag not allowed | Inline the referenced template content directly |
| `t-if`, `t-set`, `t-foreach`, `t-out`, `t-esc` | QWeb attributes not allowed | Remove and inline the result |
| `<field name="...">` | Odoo widget not allowed | Remove |

## Style violations

| Symptom | Violation | Fix |
|---|---|---|
| `<style>` block defining global `body`, `html`, `*` selectors | Can leak into Odoo UI | Move properties to inline `style="..."` on the element, scoped only to your section |
| `position: absolute/fixed` in inline style | Risks breaking Odoo layout | Replace with flexbox via Bootstrap classes |
| `transform`, `animation`, `transition` | Can interfere with Odoo | Remove |
| `z-index` | Can collide with Odoo overlays | Remove |
| `!important` | Overrides Odoo styles aggressively | Remove |

## Content violations

| Symptom | Violation | Fix |
|---|---|---|
| Indonesian, Vietnamese, French copy in rendered text | English-only requirement | Translate to English |
| "Buy now", "Discount", "Promo", "Sale 50% off" | Promotions/ads forbidden | Remove the promotional language; describe the feature factually |
| "Available also on <other marketplace>" | Cross-marketplace link forbidden | Remove |
| Feature claimed but not in the module | Misleading | Remove from description or implement the feature |

## Asset path violations

| Symptom | Violation | Fix |
|---|---|---|
| `<img src="/web/image/...">` | Internal Odoo URL, not portable | Move the image into `static/description/assets/` and use a relative path |
| `<img src="https://example.com/foo.png">` | External image hotlink | Download the image into `static/description/assets/` |
| Broken local path (404 on validator) | Asset missing | Add the asset to the module or remove the reference |
