---
name: odoo-decision-trees
description: Decision trees untuk pilihan decorator, field type, auth, SQL vs ORM, dan architectural choices di semua versi Odoo.
---

# Decision Trees — All Versions

## Computed Field vs Onchange

```
Perlu update nilai field?
├── Harus benar di DB (bukan hanya UI) → @api.depends (computed field)
│   ├── Perlu di-search/filter → store=True + search=...
│   ├── Perlu bisa diedit user → tambah inverse=...
│   └── Tergantung context → tambah @api.depends_context
└── Feedback UI saja, tidak perlu disimpan → @api.onchange
    ⚠️  onchange DILARANG CRUD — no create/write/unlink
    ⚠️  onchange return value hanya untuk domain/warning, bukan persist
```

## store=True vs store=False

```
Computed field — perlu disimpan?
├── Di-search dalam domain filter? → store=True (WAJIB)
├── Dipakai di report atau export? → store=True (jauh lebih cepat)
├── Jarang berubah, banyak record? → store=True
├── Selalu berubah (e.g., "sekarang") → store=False
└── Hanya tampil di form, tidak pernah di-query → store=False boleh
```

## @api.constrains vs Override write/create

```
Perlu validasi data?
├── Constraint pada field tertentu → @api.constrains (dianjurkan)
│   ⚠️  NO dotted paths! Hanya direct fields.
│   ⚠️  Hanya trigger jika field tersebut ada di vals yang ditulis.
└── Validasi apapun yang ditulis (semua field) → override write()
    └── Panggil super() DULU, lalu validasi
```

## @api.ondelete vs Override unlink()

```
Perlu cegah penghapusan?
├── v15+ → @api.ondelete(at_uninstall=False)  ← DIANJURKAN
│   └── Tidak merusak proses uninstall modul
└── v14 atau butuh logic kompleks → override unlink()
    └── if any(rec.state != 'draft' for rec in self): raise UserError(...)
    └── return super().unlink()
```

## sudo() — Kapan Dipakai

```
Perlu elevated access?
├── Di controller (public endpoint) → sudo() boleh, tapi comment alasannya
├── Di model method → HINDARI — perbaiki ACL-nya
├── Untuk count/check rekord terkait → sudo() boleh
├── Untuk kirim email/notifikasi → sudo() boleh (operasi teknis)
└── "Biar jalan dulu" → JANGAN — fix access rights-nya
```

## auth Type di Controllers

```
HTTP endpoint — siapa yang boleh akses?
├── Hanya logged-in users → auth='user' (default, aman)
├── Halaman website publik → auth='public'
│   └── Gunakan sudo() HANYA untuk yang diperlukan
├── Webhook dari sistem eksternal → auth='none', csrf=False
│   └── WAJIB validasi signature/token secara manual
└── Internal utility → auth='none'
```

## Field Type Selection

```
Data apa yang disimpan?
├── Teks pendek (nama, kode) → Char
├── Teks panjang (catatan) → Text
├── HTML terformat → Html (auto-sanitized)
├── True/False → Boolean
├── Bilangan bulat → Integer
├── Desimal → Float
│   └── Uang → Monetary (+ currency_id field)
├── Tanggal saja → Date
├── Tanggal + waktu → Datetime
├── File/gambar kecil → Binary
│   └── File besar → Binary(attachment=True)
├── Pilihan tetap → Selection
├── Link ke satu rekord → Many2one (+ ondelete='restrict'/'cascade'/'set null')
├── Rekord anak → One2many (+ inverse_name wajib)
├── Banyak link → Many2many
└── v17+: Data semi-structured → Json / Properties
```

## ORM vs Raw SQL

```
Perlu query database?
├── CRUD biasa → ORM (search, create, write, unlink)
├── Agregasi sederhana → read_group() / _read_group() v17+
├── Agregasi kompleks / jutaan baris → Raw SQL
│   ├── v14-v16 → cr.execute("...", (param,))
│   └── v17+ → SQL() class atau cr.execute()
├── Cross-model aggregation → Raw SQL
└── Report kompleks GROUP BY → Raw SQL
    ⚠️  JANGAN f-string SQL! Selalu parameterized.
```

## Many2one ondelete Strategy

```
Many2one field — kalau parent dihapus?
├── Hapus juga child (cascade) → ondelete='cascade'
│   ⚠️  Hati-hati: bisa hapus data penting secara silent
├── Tolak penghapusan parent → ondelete='restrict' (DEFAULT, aman)
└── Set field ke null → ondelete='set null' (+ required=False)
```

## Mixin Selection

```
Perlu fitur?
├── Chatter / tracking perubahan → _inherit = ['mail.thread', 'mail.activity.mixin']
├── Hanya tracking tanpa chatter → _inherit = 'mail.thread' saja
├── Nomor sequence otomatis → _inherit = 'ir.sequence'
│   └── Atau gunakan ir.sequence di data XML
├── Portal access → _inherit = 'portal.mixin'
└── Rating → _inherit = 'rating.mixin'
```

## When to Create New Module vs Inherit

```
Fitur baru — module baru atau extend existing?
├── Fitur independen yang bisa ON/OFF sendiri → module baru
├── Ekstensi kecil dari modul existing → inherit di modul existing atau glue module
├── Integrasi dua modul → glue module baru yang depends keduanya
└── Modifikasi core Odoo → JANGAN — inherit dan override saja
    ⚠️  Jangan pernah edit file di addons/ Odoo langsung
```
