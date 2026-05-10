---
name: odoo-testing
description: Test patterns untuk unit test, integration test, dan tour test di semua versi Odoo.
---

# Testing — All Versions

## Test Classes

```python
from odoo.tests.common import TransactionCase, SavepointCase, Form
from odoo.tests import tagged
from odoo.exceptions import UserError, ValidationError

# TransactionCase: rollback otomatis setelah setiap test (v14+)
@tagged('post_install', '-at_install')
class TestMyModel(TransactionCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        # Setup data SEKALI untuk semua test di class ini
        cls.partner = cls.env['res.partner'].create({
            'name': 'Test Partner',
            'email': 'test@example.com',
        })
        cls.company = cls.env.company

    def setUp(self):
        super().setUp()
        # Setup data PER TEST (lebih lambat, tapi isolasi lebih baik)
        self.record = self.env['my.model'].create({
            'name': 'Test Record',
            'partner_id': self.partner.id,
        })

    def test_create_basic(self):
        """Test basic creation"""
        record = self.env['my.model'].create({'name': 'Test'})
        self.assertEqual(record.state, 'draft')
        self.assertTrue(record.active)

    def test_action_confirm(self):
        """Test confirmation flow"""
        self.record.action_confirm()
        self.assertEqual(self.record.state, 'confirmed')
        self.assertIsNotNone(self.record.confirmed_date)

    def test_constraint_name_length(self):
        """Test validation constraint"""
        with self.assertRaises(ValidationError):
            self.env['my.model'].create({'name': 'AB'})  # terlalu pendek

    def test_cannot_delete_confirmed(self):
        """Test deletion restriction"""
        self.record.action_confirm()
        with self.assertRaises(UserError):
            self.record.unlink()

    def test_compute_total(self):
        """Test computed field"""
        self.env['my.model.line'].create([
            {'model_id': self.record.id, 'price': 100},
            {'model_id': self.record.id, 'price': 200},
        ])
        self.assertEqual(self.record.amount_total, 300)

    def test_security_access(self):
        """Test record rules — user only sees own records"""
        other_user = self.env['res.users'].create({
            'name': 'Other User',
            'login': 'other@test.com',
        })
        # Record dibuat oleh admin, other_user tidak boleh lihat
        record_as_other = self.record.with_user(other_user)
        with self.assertRaises(Exception):
            _ = record_as_other.name
```

---

## Form Wizard Testing

```python
from odoo.tests.common import Form

def test_form_flow(self):
    """Test menggunakan Form helper — simulasi user input"""
    with Form(self.env['my.model']) as form:
        form.name = 'Test via Form'
        form.partner_id = self.partner
        form.date = fields.Date.today()
        record = form.save()

    self.assertEqual(record.name, 'Test via Form')

    # Edit record existing
    with Form(record) as form:
        form.name = 'Updated Name'
    self.assertEqual(record.name, 'Updated Name')

    # Test One2many lines
    with Form(self.env['sale.order']) as order_form:
        order_form.partner_id = self.partner
        with order_form.order_line.new() as line:
            line.product_id = self.product
            line.product_uom_qty = 5
        order = order_form.save()

    self.assertEqual(len(order.order_line), 1)
```

---

## Test Tags & Execution

```python
# Tags untuk control kapan test dijalankan
@tagged('post_install', '-at_install')  # hanya setelah install (default untuk most tests)
@tagged('at_install')                   # saat install
@tagged('-standard', 'slow')           # exclude dari standard, jalankan manual

# Jalankan test dari command line:
# python odoo-bin test -d mydb --test-tags my_module
# python odoo-bin test -d mydb --test-tags my_module.TestMyModel
# python odoo-bin test -d mydb --test-tags my_module.TestMyModel.test_create_basic
```

---

## Mocking External Services

```python
from unittest.mock import patch, MagicMock

def test_external_api_success(self):
    """Test dengan mock external API"""
    mock_response = MagicMock()
    mock_response.json.return_value = {'id': 'EXT-001', 'status': 'ok'}
    mock_response.raise_for_status.return_value = None

    with patch('requests.post', return_value=mock_response) as mock_post:
        self.record.action_send_to_external()

        # Verify API dipanggil dengan benar
        mock_post.assert_called_once()
        call_args = mock_post.call_args
        self.assertEqual(call_args.kwargs['json']['reference'], self.record.name)

    # Verify hasil tersimpan
    self.assertEqual(self.record.external_id, 'EXT-001')
    self.assertEqual(self.record.state, 'sent')

def test_external_api_timeout(self):
    """Test handling timeout"""
    import requests
    with patch('requests.post', side_effect=requests.exceptions.Timeout):
        with self.assertRaises(UserError) as context:
            self.record.action_send_to_external()
        self.assertIn('timeout', str(context.exception).lower())
```

---

## Performance Tests

```python
def test_no_n_plus_one(self):
    """Pastikan tidak ada N+1 queries"""
    # Buat 10 records
    records = self.env['my.model'].create([
        {'name': f'Record {i}', 'partner_id': self.partner.id}
        for i in range(10)
    ])

    # Hitung queries saat akses computed field
    with self.assertQueryCount(1):  # harus hanya 1 query
        totals = records.mapped('amount_total')

def test_batch_create_performance(self):
    """Test batch create lebih cepat dari loop"""
    import time

    # Batch create
    start = time.time()
    self.env['my.model'].create([
        {'name': f'Batch {i}'} for i in range(100)
    ])
    batch_time = time.time() - start

    self.assertLess(batch_time, 2.0, "Batch create terlalu lambat")
```

---

## HTTP Controller Tests

```python
from odoo.tests.common import HttpCase

class TestMyController(HttpCase):

    def test_api_endpoint(self):
        """Test JSON endpoint"""
        response = self.url_open(
            '/api/my_endpoint',
            data='{"key": "value"}',
            headers={'Content-Type': 'application/json'},
        )
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn('result', data)

    def test_webhook_valid_signature(self):
        """Test webhook dengan signature valid"""
        import hmac, hashlib, json
        secret = 'my_secret'
        payload = json.dumps({'event': 'payment.done', 'amount': 100})
        signature = hmac.new(
            secret.encode(), payload.encode(), hashlib.sha256
        ).hexdigest()

        response = self.url_open(
            '/webhook/payment',
            data=payload,
            headers={
                'Content-Type': 'application/json',
                'X-Signature': signature,
            },
        )
        self.assertEqual(response.status_code, 200)
```
