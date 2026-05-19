---
name: odoo-oca-workflow
description: OCA search workflow before development, how to depend on OCA modules, and OCA pattern integration.
---

# OCA Workflow — Search Before Build

## Principle: Don't Reinvent the Wheel

**Before developing anything**, perform these searches in order:

### 1. Search in Odoo Core
```
github.com/odoo/odoo/tree/{version}.0/addons
github.com/odoo/enterprise (if you have access)
```

### 2. Search in OCA
```
# Browse all OCA repos:
github.com/orgs/OCA/repositories

# Search by keyword:
github.com/OCA?q={keyword}&type=repositories

# Examples:
github.com/OCA?q=sale+discount&type=repositories
github.com/OCA?q=stock+barcode&type=repositories
```

### 3. Decision

```
Found in Odoo core?
  → Inherit/extend, DO NOT duplicate

Found in OCA + compatible version?
  → Depend on OCA module, or use as pattern reference

Found but different version?
  → Port or inherit carefully

Not found?
  → Develop from scratch
```

---

## OCA Repositories per Domain

| Domain | Repository |
|--------|-----------|
| Accounting | `OCA/account-financial-reporting`, `OCA/account-financial-tools` |
| Stock/Warehouse | `OCA/stock-logistics-workflow`, `OCA/stock-logistics-warehouse` |
| Sale | `OCA/sale-workflow` |
| Purchase | `OCA/purchase-workflow` |
| HR | `OCA/hr`, `OCA/payroll` |
| POS | `OCA/pos` |
| Website/Portal | `OCA/website` |
| Server Tools | `OCA/server-tools`, `OCA/server-ux` |
| Reporting | `OCA/reporting-engine` |
| Connector | `OCA/connector`, `OCA/connector-ecommerce` |
| Product | `OCA/product-attribute` |
| Project | `OCA/project` |
| CRM | `OCA/crm` |
| Manufacturing | `OCA/manufacture` |
| Localization ID | `OCA/l10n-indonesia` |

---

## How to Depend on OCA Modules

### 1. Install via pip (development)
```bash
pip install odoo14-addon-sale_discount_display_amount
# or
pip install odoo-addon-sale_discount_display_amount==16.0.*
```

### 2. Via requirements.txt
```
# requirements.txt
odoo-addon-sale-discount-display-amount==16.0.1.0.0
odoo-addon-stock-picking-back2draft==16.0.1.0.0
```

### 3. Manifest dependency
```python
{
    'name': 'My Module',
    'version': '16.0.1.0.0',
    'depends': [
        'base',
        'sale',
        'sale_discount_display_amount',  # OCA module
    ],
}
```

---

## Using OCA as a Pattern Reference

Even without directly depending on it, OCA code is the best reference for:

```
# Good patterns to learn from OCA:
- OCA/server-tools: base_setup_* modules
- OCA/sale-workflow: sale_order_* for order workflow patterns
- OCA/account-financial-tools: account_* for accounting patterns
- OCA/stock-logistics-workflow: stock_* for inventory patterns
```

---

## OCA Code Standards (if contributing)

```python
# License header required
# Copyright YYYY Author Name <email>
# License LGPL-3.0 or later (https://www.gnu.org/licenses/lgpl-3.0)

# README.rst required in OCA format
# No print() statements
# pre-commit hooks: black, isort, flake8, prettier

# Test coverage minimum 80%
# All strings translatable: _()
```

---

## Useful OCA Tools

```bash
# OCA-port: helps porting modules to new versions
pip install click-odoo-contrib

# Manifestoo: manage Odoo manifest dependencies
pip install manifestoo

# pre-commit OCA config
pip install pre-commit
# set up .pre-commit-config.yaml with OCA hooks
```

---

## Example: Search Before Building "barcode scanning"

```
1. Search: github.com/OCA?q=barcode&type=repositories
   → Found: OCA/stock-logistics-barcode

2. Check version: is there a 16.0 branch? ✅
   → github.com/OCA/stock-logistics-barcode/tree/16.0

3. Relevant modules: stock_barcodes, stock_barcodes_gs1

4. Decision:
   a. If features are sufficient → depend directly on the OCA module
   b. If customization needed → inherit from the OCA module
   c. If too different → build your own but study OCA patterns
```
