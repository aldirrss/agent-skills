# Odoo Apps Store — Description Page Guidelines

Source: Odoo Apps Store submission guidelines for `static/description/index.html`.

## Content rules

- The app's description and screenshots must be in **English**, regardless of the originating country or language of the app.
- The description of a module may **not** mention promotions, advertisements, or links to another app store or external platform.
- Information about features must be **accurate** and cannot be misleading.

## Allowed external resources

You can link against resources provided in your `static/description/` folder.

You can use:

- **YouTube** links — must be canonical URLs
- **Microsoft Teams** links
- `mailto:` prefix for email addresses
- `skype:` prefix for Skype contact

Any other external link will be invalidated.

## Forbidden in HTML

- No static tags
- No static widgets
- No modals
- No harmful styles
- No JavaScript

## Allowed style attributes

Use Bootstrap 4 classes plus the following inline CSS attribute families:

- `color`
- `font-*`
- `margin-*`
- `padding-*`
- `border-*`

Combine these with Bootstrap 4 layout utility classes (rows, columns, spacing, alignment).
