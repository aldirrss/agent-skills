---
name: odoo-oca-workflow
description: Workflow pencarian OCA sebelum develop, cara depend ke OCA module, dan integrasi OCA patterns.
---

# OCA Workflow — Search Before Build

## Prinsip: Don't Reinvent the Wheel

**Sebelum develop apapun**, lakukan pencarian ini secara berurutan:

### 1. Cari di Odoo Core
```
github.com/odoo/odoo/tree/{version}.0/addons
github.com/odoo/enterprise (jika ada akses)
```

### 2. Cari di OCA
```
# Browse semua repo OCA:
github.com/orgs/OCA/repositories

# Search by keyword:
github.com/OCA?q={keyword}&type=repositories

# Contoh:
github.com/OCA?q=sale+discount&type=repositories
github.com/OCA?q=stock+barcode&type=repositories
```

### 3. Keputusan

```
Ditemukan di Odoo core?
  → Inherit/extend, JANGAN duplikasi

Ditemukan di OCA + versi kompatibel?
  → Depend ke OCA module, atau gunakan sebagai referensi pattern

Ditemukan tapi versi beda?
  → Port atau inherit dengan hati-hati

Tidak ditemukan?
  → Baru develop dari scratch
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

## Cara Depend ke OCA Module

### 1. Install via pip (development)
```bash
pip install odoo14-addon-sale_discount_display_amount
# atau
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

## Cara Gunakan OCA sebagai Pattern Reference

Bahkan jika tidak depend langsung, OCA code adalah referensi terbaik untuk:

```
# Pola yang bagus untuk dipelajari dari OCA:
- OCA/server-tools: base_setup_* modules
- OCA/sale-workflow: sale_order_* untuk order workflow
- OCA/account-financial-tools: account_* untuk accounting patterns
- OCA/stock-logistics-workflow: stock_* untuk inventory patterns
```

---

## OCA Code Standards (jika kontribusi)

```python
# License header wajib
# Copyright YYYY Author Name <email>
# License LGPL-3.0 or later (https://www.gnu.org/licenses/lgpl-3.0)

# README.rst wajib dengan format OCA
# Tidak ada print() statement
# pre-commit hooks: black, isort, flake8, prettier

# Test coverage minimum 80%
# Semua string translatable: _()
```

---

## OCA Tools yang Berguna

```bash
# OCA-port: bantu porting module ke versi baru
pip install click-odoo-contrib

# Manifestoo: manage Odoo manifest dependencies
pip install manifestoo

# pre-commit OCA config
pip install pre-commit
# setup .pre-commit-config.yaml dengan OCA hooks
```

---

## Contoh: Cari Sebelum Build "barcode scanning"

```
1. Search: github.com/OCA?q=barcode&type=repositories
   → Temukan: OCA/stock-logistics-barcode

2. Cek versi: ada 16.0 branch? ✅
   → github.com/OCA/stock-logistics-barcode/tree/16.0

3. Module yang relevan: stock_barcodes, stock_barcodes_gs1

4. Keputusan:
   a. Kalau fitur sudah cukup → depend ke OCA module langsung
   b. Kalau perlu custom → inherit dari OCA module
   c. Kalau terlalu berbeda → buat sendiri tapi pelajari pattern OCA
```
