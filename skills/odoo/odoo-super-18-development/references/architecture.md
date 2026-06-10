# Architecture Patterns — Odoo 18

Scalable, maintainable module design patterns for production Odoo 18.

---

## Module Structure Archetypes

### Archetype 1: Feature Module (Most Common)

Self-contained business domain. No external dependencies beyond Odoo modules.

```
my_feature/
├── __manifest__.py
├── __init__.py
├── models/
│   ├── __init__.py
│   ├── my_feature.py          # Main model
│   └── my_feature_line.py     # Child model (if needed)
├── views/
│   ├── my_feature_views.xml
│   └── my_feature_menus.xml
├── security/
│   ├── my_feature_security.xml  # Groups + record rules
│   └── ir.model.access.csv
├── data/
│   └── my_feature_data.xml    # Initial data (noupdate)
├── wizard/
│   ├── __init__.py
│   ├── my_wizard.py
│   └── my_wizard_views.xml
└── tests/
    ├── __init__.py
    └── test_my_feature.py
```

### Archetype 2: Integration Module

Bridges Odoo with external system. Has a services/ layer.

```
my_integration/
├── models/
│   ├── my_model.py            # Business model, triggers service calls
│   └── res_config_settings.py # Config fields for API credentials
├── services/
│   └── external_client.py     # AbstractModel — all HTTP calls here
├── controllers/
│   └── webhook.py             # Receives callbacks from external system
└── data/
    └── config.xml             # Default configuration values
```

**Key rule**: Models call services. Services never import models directly.

### Archetype 3: Extension Module

Adds functionality to existing Odoo module without forking.

```
lmc_sale_extension/
├── models/
│   └── sale_order.py          # _inherit = 'sale.order'
├── views/
│   └── sale_order_views.xml   # inherit_id = sale.view_order_form
└── security/
    └── ir.model.access.csv    # Only if new models added
```

**Naming**: `{company_prefix}_{base_module}` e.g. `lmc_sale`, `lmc_account`

---

## Service Layer Pattern

For any external API integration, always use an AbstractModel service:

```python
# services/camunda_client.py
import requests
from odoo import models, api
from odoo.exceptions import UserError

class CamundaClient(models.AbstractModel):
    _name = 'camunda.client'
    _description = 'Camunda REST API Client'

    def _get_base_url(self):
        return self.env['ir.config_parameter'].sudo().get_param(
            'camunda.base_url', 'http://localhost:8080/engine-rest'
        )

    def _get_headers(self):
        return {'Content-Type': 'application/json'}

    def _request(self, method, endpoint, **kwargs):
        url = f"{self._get_base_url()}{endpoint}"
        try:
            response = requests.request(
                method, url,
                headers=self._get_headers(),
                timeout=10,
                **kwargs
            )
            response.raise_for_status()
            return response.json()
        except requests.exceptions.Timeout:
            raise UserError("Camunda API timeout. Please try again.")
        except requests.exceptions.ConnectionError:
            raise UserError("Cannot connect to Camunda. Check server status.")
        except requests.exceptions.HTTPError as e:
            raise UserError(f"Camunda API error: {e.response.status_code}")

    def start_process(self, process_key, variables):
        return self._request('POST', f'/process-definition/key/{process_key}/start',
            json={'variables': variables}
        )

    def _test_connection(self):
        """Used by admin UI to verify connection"""
        try:
            self._request('GET', '/engine')
            return True
        except UserError:
            return False
```

```python
# models/my_model.py
class MyModel(models.Model):
    _name = 'my.model'

    def action_send_to_camunda(self):
        client = self.env['camunda.client']
        for rec in self:
            result = client.start_process('my-process', rec._prepare_variables())
            rec.write({
                'camunda_instance_id': result['id'],
                'state': 'in_progress'
            })

    def _prepare_variables(self):
        """Camunda variable format"""
        return {
            'orderId': {'value': self.id, 'type': 'Long'},
            'orderName': {'value': self.name, 'type': 'String'},
        }
```

---

## Config Settings Pattern

For storing module configuration (API keys, URLs, flags):

```python
# models/res_config_settings.py
from odoo import fields, models

class ResConfigSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    # Use config_parameter for global settings
    my_api_key = fields.Char(
        string='API Key',
        config_parameter='my_module.api_key',
    )
    my_api_url = fields.Char(
        string='API URL',
        config_parameter='my_module.api_url',
        default='https://api.example.com',
    )

    # Use company-specific fields for per-company settings
    my_company_setting = fields.Boolean(
        related='company_id.my_company_setting',
        readonly=False,
    )
```

```python
# Reading config anywhere
def _get_api_key(self):
    return self.env['ir.config_parameter'].sudo().get_param('my_module.api_key')
```

---

## Multi-Company Pattern

Essential for modules deployed in multi-company environments:

```python
class MyModel(models.Model):
    _name = 'my.model'

    company_id = fields.Many2one(
        'res.company',
        string='Company',
        required=True,
        default=lambda self: self.env.company,
        index=True,
    )

    # For currency-related fields, also store currency
    currency_id = fields.Many2one(
        'res.currency',
        related='company_id.currency_id',
        store=True,
    )
    amount = fields.Monetary(currency_field='currency_id')
```

```xml
<!-- Record rule for multi-company isolation -->
<record id="rule_my_model_company" model="ir.rule">
    <field name="name">My Model: Multi-company</field>
    <field name="model_id" ref="model_my_model"/>
    <field name="domain_force">[('company_id', 'in', company_ids)]</field>
    <field name="global" eval="True"/>
</record>
```

---

## State Machine Pattern

For models with lifecycle states:

```python
class MyDocument(models.Model):
    _name = 'my.document'

    state = fields.Selection([
        ('draft', 'Draft'),
        ('submitted', 'Submitted'),
        ('approved', 'Approved'),
        ('rejected', 'Rejected'),
        ('cancelled', 'Cancelled'),
    ], default='draft', string='Status', tracking=True)

    # State-dependent computed fields
    can_edit = fields.Boolean(compute='_compute_can_edit')
    can_submit = fields.Boolean(compute='_compute_can_submit')

    @api.depends('state')
    def _compute_can_edit(self):
        for rec in self:
            rec.can_edit = rec.state == 'draft'

    @api.depends('state')
    def _compute_can_submit(self):
        for rec in self:
            rec.can_submit = rec.state == 'draft' and bool(rec.name)

    # Transition methods — one method per transition
    def action_submit(self):
        self._validate_for_submit()
        self.write({'state': 'submitted'})

    def action_approve(self):
        self.ensure_one()
        if not self.env.user.has_group('my_module.group_approver'):
            raise UserError("Only approvers can approve documents.")
        self.write({'state': 'approved', 'approved_by': self.env.user.id})

    def action_reject(self, reason=None):
        self.write({'state': 'rejected', 'rejection_reason': reason})

    def action_cancel(self):
        if any(r.state == 'approved' for r in self):
            raise UserError("Approved documents cannot be cancelled.")
        self.write({'state': 'cancelled'})

    def action_reset_draft(self):
        self.write({'state': 'draft'})

    def _validate_for_submit(self):
        for rec in self:
            if not rec.partner_id:
                raise ValidationError(f"Document '{rec.name}' has no partner.")
            if not rec.line_ids:
                raise ValidationError(f"Document '{rec.name}' has no lines.")
```

---

## Wizard Pattern

For multi-step user interactions:

```python
# wizard/my_wizard.py
class MyWizard(models.TransientModel):
    _name = 'my.wizard'
    _description = 'My Action Wizard'

    # Context: record that opened this wizard
    record_id = fields.Many2one('my.model', string='Record',
        default=lambda self: self.env.context.get('active_id'))

    # Wizard fields
    action_type = fields.Selection([
        ('approve', 'Approve'),
        ('reject', 'Reject'),
    ], required=True, default='approve')
    reason = fields.Text(string='Reason')

    def action_confirm(self):
        self.ensure_one()
        if self.action_type == 'approve':
            self.record_id.action_approve()
        else:
            if not self.reason:
                raise UserError("Please provide a rejection reason.")
            self.record_id.action_reject(self.reason)

        # Return action to close wizard and refresh view
        return {'type': 'ir.actions.act_window_close'}
```

```xml
<!-- views/my_wizard_views.xml -->
<record id="view_my_wizard_form" model="ir.ui.view">
    <field name="name">my.wizard.form</field>
    <field name="model">my.wizard</field>
    <field name="arch" type="xml">
        <form string="Process Document">
            <group>
                <field name="action_type"/>
                <field name="reason" attrs="{'required': [('action_type', '=', 'reject')]}"/>
            </group>
            <footer>
                <button name="action_confirm" string="Confirm" type="object" class="btn-primary"/>
                <button string="Cancel" class="btn-secondary" special="cancel"/>
            </footer>
        </form>
    </field>
</record>

<record id="action_my_wizard" model="ir.actions.act_window">
    <field name="name">Process Document</field>
    <field name="res_model">my.wizard</field>
    <field name="view_mode">form</field>
    <field name="target">new</field>
</record>
```

---

## Demo Provisioning Pattern (Token Auth)

Pattern from `demo_provisioner` / `demo_token_auth` for auto-login via URL token:

```python
class DemoToken(models.Model):
    _name = 'demo.token'

    token = fields.Char(required=True, index=True, copy=False)
    user_id = fields.Many2one('res.users', required=True)
    expiry = fields.Datetime(required=True)
    used = fields.Boolean(default=False)

    @api.model
    def generate_for_user(self, user_id, ttl_minutes=60):
        import secrets
        token = secrets.token_urlsafe(32)
        expiry = fields.Datetime.now() + timedelta(minutes=ttl_minutes)
        return self.create({'token': token, 'user_id': user_id, 'expiry': expiry})

    @api.model
    def validate_and_consume(self, token_str):
        token = self.search([
            ('token', '=', token_str),
            ('used', '=', False),
            ('expiry', '>', fields.Datetime.now()),
        ], limit=1)
        if not token:
            return False
        token.write({'used': True})
        return token.user_id
```
