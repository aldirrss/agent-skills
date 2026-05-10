---
name: odoo-debugging
description: Systematic debugging workflow untuk Python errors, OWL/JS errors, transaction errors, dan performance issues di semua versi Odoo.
---

# Debugging Workflow — All Versions

## Step 1: Baca Traceback dengan Benar

```
SELALU baca dari BAWAH ke ATAS:
- Baris terakhir = tipe error + pesan
- Baris sebelumnya = lokasi di code kita
- Naik terus sampai ketemu file di addons/ kita (bukan odoo core)
```

---

## Identifikasi Tipe Error

```
Error TYPE → Arti → Langkah

UserError / ValidationError
  → Business logic issue — data tidak valid
  → Cek validasi di @api.constrains atau write/create override

AccessError
  → Permission issue
  → Cek ir.model.access.csv dan ir.rule
  → Cek apakah sudo() diperlukan (tapi cari tahu KENAPA dulu)

MissingError
  → Record dihapus atau ID salah
  → Cek apakah record masih ada: record.exists()
  → Kemungkinan race condition atau stale ID

UniqueViolation (psycopg2.errors.UniqueViolation)
  → Duplicate key constraint di database
  → Gunakan savepoint! Transaction sudah rusak setelah error ini
  → Lihat constraint name di e.diag.constraint_name

InFailedSqlTransaction
  → Ada error sebelumnya yang tidak di-handle
  → Transaction masih dalam state "aborted"
  → Harus gunakan savepoint dari awal

KeyError / AttributeError
  → Python bug — field name salah atau attribute tidak ada
  → Cek typo di field name, cek apakah field ada di model

IntegrityError
  → Foreign key constraint atau NOT NULL violation
  → Cek relasi many2one dengan ondelete strategy

RecursionError
  → @api.depends atau compute memanggil dirinya sendiri
  → Cek circular dependency di depends chain
```

---

## Pattern: Handle UniqueViolation

```python
from psycopg2 import errors as pg_errors

def create_with_fallback(self, vals):
    try:
        with self.env.cr.savepoint():
            return self.create(vals)
    except Exception as e:
        if isinstance(e.__cause__, pg_errors.UniqueViolation):
            # Record sudah ada — cari dan return yang existing
            existing = self.search([
                ('reference', '=', vals.get('reference')),
                ('company_id', '=', vals.get('company_id', self.env.company.id)),
            ], limit=1)
            if existing:
                return existing
        raise
```

---

## Pattern: Savepoint untuk Partial Failures

```python
def process_batch(self, records):
    success = self.env['my.model']
    failed = []

    for record in records:
        try:
            with self.env.cr.savepoint():
                record.action_process()
                success |= record
        except Exception as e:
            failed.append({'record': record.id, 'error': str(e)})
            # savepoint auto-rollback, transaksi utama tetap jalan

    return {'success': success.ids, 'failed': failed}
```

---

## Debug OWL / JavaScript Errors

```
1. SELALU buka browser DevTools → Console DULU
   OWL errors di console jauh lebih informatif dari Odoo log

2. Error types OWL:
   - "Cannot read property X of undefined" → props tidak lengkap, cek static props
   - "Component is destroyed" → async operation setelah component di-unmount
   - "willStart/onWillStart failed" → error di async initialization

3. Debug steps:
   a. F12 → Console → lihat error message lengkap
   b. Network tab → cek apakah RPC call gagal (status 500/400)
   c. Source tab → set breakpoint di JS code
   d. Reload dengan ?debug=assets untuk load non-minified JS
```

```javascript
// Tambahkan debug logging sementara
import { useEffect } from "@odoo/owl";

class MyComponent extends Component {
    setup() {
        useEffect(() => {
            console.log("Props:", this.props);
            console.log("State:", this.state);
        });
    }
}
```

---

## Debug Performance Issues

```python
# Enable query logging sementara
import logging
logging.getLogger('odoo.sql_db').setLevel(logging.DEBUG)

# Hitung query dalam satu operation
from odoo.tests.common import BaseCase
import odoo.tests.common as common

# Gunakan ?debug=1 di URL untuk lihat technical info
# Settings → Technical → Logging → add odoo.sql_db DEBUG

# Profile dengan Python profiler
import cProfile
import pstats

pr = cProfile.Profile()
pr.enable()
# ... code yang ingin di-profile ...
pr.disable()
stats = pstats.Stats(pr).sort_stats('cumulative')
stats.print_stats(20)
```

---

## Odoo Shell untuk Debug Interaktif

```bash
# Odoo shell
odoo-bin shell -d mydb --addons-path=...

# Di shell:
env = self.env  # atau: env = api.Environment(cr, uid, {})

# Test query
records = env['my.model'].search([('state', '=', 'draft')])
print(records)
print(records.read(['name', 'state']))

# Test method
result = records[0].action_confirm()
env.cr.rollback()  # jangan commit!
```

---

## Common Odoo-Specific Bugs

```python
# BUG: @api.depends dengan dotted path di @api.constrains
@api.constrains('partner_id.country_id')  # ❌ TIDAK VALID
def _check_country(self):
    pass

@api.constrains('partner_id')  # ✅ hanya direct field
def _check_country(self):
    for rec in self:
        if rec.partner_id.country_id.code != 'ID':
            raise ValidationError("Hanya Indonesia")

# BUG: CRUD di dalam onchange
@api.onchange('partner_id')
def _onchange_partner(self):
    if self.partner_id:
        self.env['my.log'].create({'message': 'changed'})  # ❌ jangan!
        self.name = self.partner_id.name  # ✅ hanya update UI field

# BUG: Lupa loop di compute method
@api.depends('amount')
def _compute_tax(self):
    # ❌ tanpa loop — hanya update record pertama
    self.tax_amount = self.amount * 0.1

    # ✅ dengan loop
    for rec in self:
        rec.tax_amount = rec.amount * 0.1

# BUG: Modify list saat di-iterate
for line in order.line_ids:
    if condition:
        line.unlink()  # ❌ modify saat iterate

lines_to_delete = order.line_ids.filtered(lambda l: condition)
lines_to_delete.unlink()  # ✅
```
