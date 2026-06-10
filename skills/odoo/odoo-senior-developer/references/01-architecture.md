---
name: odoo-architecture
description: Module structure, service layer patterns, multi-company, and architectural decisions for all Odoo versions.
---

# Architecture Patterns — All Versions

## Standard Module Structure

```
my_module/
├── __init__.py
├── __manifest__.py
├── models/
│   ├── __init__.py
│   ├── my_model.py
│   └── my_related_model.py
├── views/
│   ├── my_model_views.xml
│   └── my_model_menus.xml
├── security/
│   ├── ir.model.access.csv      ← REQUIRED for every new model
│   └── my_module_security.xml   ← record rules, groups
├── data/
│   └── my_module_data.xml
├── wizards/
│   ├── __init__.py
│   └── my_wizard.py
├── controllers/
│   ├── __init__.py
│   └── main.py
├── services/                    ← for external integrations
│   ├── __init__.py
│   └── external_api.py
├── migrations/
│   └── {version}.x.x.x/
│       ├── pre-migrate.py
│       └── post-migrate.py
├── tests/
│   ├── __init__.py
│   └── test_my_model.py
└── static/
    └── src/
        ├── js/
        ├── xml/
        └── scss/
```

---

## The Golden Rule: Thin Controllers, Fat Models

```
HTTP Request
    ↓
Controller (validate input, call model, return response)
    ↓
Model Method (ALL business logic here)
    ↓
ORM / DB
```

```python
# ❌ WRONG: business logic in controller
class MyController(http.Controller):
    @http.route('/api/order', type='json', auth='user')
    def create_order(self, **kwargs):
        partner = request.env['res.partner'].search([('name', '=', kwargs['name'])])
        order = request.env['sale.order'].create({
            'partner_id': partner.id,
            'state': 'draft',
        })
        order.action_confirm()
        return {'id': order.id}

# ✅ CORRECT: thin controller, model does the work
class MyController(http.Controller):
    @http.route('/api/order', type='json', auth='user')
    def create_order(self, **kwargs):
        order = request.env['sale.order'].create_from_api(kwargs)
        return {'id': order.id}

# In model:
@api.model
def create_from_api(self, data):
    partner = self.env['res.partner'].search([('name', '=', data['name'])], limit=1)
    if not partner:
        raise UserError(f"Partner '{data['name']}' not found")
    order = self.create({'partner_id': partner.id})
    order.action_confirm()
    return order
```

---

## Service Layer for External Integrations

When making HTTP calls to external systems (Camunda, payment gateway, other ERPs):

```
my_module/
├── models/
│   └── my_model.py          ← trigger service, save result
├── services/
│   └── external_api.py      ← ALL outbound HTTP calls
└── controllers/
    └── webhook.py           ← receive callbacks from external system
```

```python
# services/external_api.py
class MyExternalService(models.AbstractModel):
    _name = 'my.external.service'
    _description = 'External API Service'

    def send_order(self, payload):
        url = self.env['ir.config_parameter'].sudo().get_param('my_module.api_url')
        try:
            response = requests.post(url, json=payload, timeout=30)
            response.raise_for_status()
            return response.json()
        except requests.exceptions.Timeout:
            raise UserError("External API timeout. Try again later.")
        except requests.exceptions.HTTPError as e:
            raise UserError(f"External API error: {e}")

# models/my_model.py
def action_send_to_external(self):
    service = self.env['my.external.service']
    result = service.send_order(self._prepare_payload())
    self.write({'external_id': result['id'], 'state': 'sent'})
```

---

## Multi-Company Architecture

Every model storing company-specific data MUST have `company_id`:

```python
class MyModel(models.Model):
    _name = 'my.model'

    company_id = fields.Many2one(
        'res.company',
        required=True,
        default=lambda self: self.env.company
    )
```

Multi-company record rule (in `security/my_module_security.xml`):

```xml
<record id="rule_my_model_company" model="ir.rule">
    <field name="name">My Model: Multi-company</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">
        ['|', ('company_id', '=', False), ('company_id', 'in', company_ids)]
    </field>
    <field name="global" eval="True"/>
</record>
```

---

## Manifest Best Practices

```python
{
    'name': 'My Module',
    'version': '16.0.1.0.0',   # X.0.major.minor.patch
    'category': 'Custom',
    'author': 'Your Name',
    'depends': ['base', 'mail'],
    'data': [
        'security/ir.model.access.csv',   # ← ALWAYS FIRST
        'security/my_module_security.xml',
        'data/my_module_data.xml',
        'views/my_model_views.xml',
        'views/my_model_menus.xml',
    ],
    'installable': True,
    'application': False,       # True only if it's a main app with top-level menu
    'auto_install': False,
    'license': 'LGPL-3',
}
```

---

## Inheritance Patterns

### Model Extension (most common)
```python
class ResPartner(models.Model):
    _inherit = 'res.partner'

    custom_field = fields.Char(string='Custom Field')
```

### Model Delegation (for IS-A relationships)
```python
class Employee(models.Model):
    _name = 'hr.employee.custom'
    _inherits = {'res.partner': 'partner_id'}  # delegate fields

    partner_id = fields.Many2one('res.partner', required=True, ondelete='cascade')
```

### Abstract Model (reusable mixin)
```python
class TimestampMixin(models.AbstractModel):
    _name = 'my.timestamp.mixin'

    processed_date = fields.Datetime(readonly=True)
    processed_by = fields.Many2one('res.users', readonly=True)

    def mark_processed(self):
        self.write({
            'processed_date': fields.Datetime.now(),
            'processed_by': self.env.uid,
        })

class MyModel(models.Model):
    _name = 'my.model'
    _inherit = ['my.timestamp.mixin', 'mail.thread']
```

---

## Config Settings Pattern

```python
class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    my_api_url = fields.Char(
        config_parameter='my_module.api_url'
    )
    my_enable_feature = fields.Boolean(
        config_parameter='my_module.enable_feature'
    )
```

```xml
<record id="res_config_settings_view_form" model="ir.ui.view">
    <field name="name">res.config.settings.view.form.inherit.my_module</field>
    <field name="model">res.config.settings</field>
    <field name="inherit_id" ref="base_setup.action_general_configuration"/>
    <field name="arch" type="xml">
        <xpath expr="//div[@id='integration_settings']" position="after">
            <div class="app_settings_block">
                <h2>My Module</h2>
                <div class="row mt16">
                    <label for="my_api_url" class="col-lg-3 o_light_label"/>
                    <field name="my_api_url" class="col-lg-4"/>
                </div>
            </div>
        </xpath>
    </field>
</record>
```
