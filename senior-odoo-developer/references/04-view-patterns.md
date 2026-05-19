---
name: odoo-view-patterns
description: XML view patterns with version-specific syntax. attrs= for v14-v16, inline for v17+.
---

# View Patterns — All Versions

## ⚠️ Version-Critical Syntax

```
v14, v15, v16 → REQUIRED attrs={"invisible": [...]}
v17           → both ways are valid (transition period)
v18, v19      → inline: invisible="state == 'done'"
```

---

## List/Tree View

```xml
<!-- v14, v15, v16: use <tree> -->
<record id="view_my_model_tree" model="ir.ui.view">
    <field name="name">my.model.tree</field>
    <field name="model">my.model</field>
    <field name="arch" type="xml">
        <tree string="My Records" editable="bottom" multi_edit="1"
              default_order="date desc">
            <field name="name"/>
            <field name="date"/>
            <field name="partner_id"/>
            <field name="state"
                   decoration-success="state == 'done'"
                   decoration-danger="state == 'cancel'"
                   decoration-muted="state == 'draft'"/>
            <field name="amount_total" sum="Total"/>
        </tree>
    </field>
</record>

<!-- v18, v19: use <list> -->
<record id="view_my_model_list" model="ir.ui.view">
    <field name="name">my.model.list</field>
    <field name="model">my.model</field>
    <field name="arch" type="xml">
        <list string="My Records" editable="bottom" multi_edit="1">
            <field name="name"/>
            <field name="state" decoration-success="state == 'done'"/>
            <field name="amount_total" sum="Total"/>
        </list>
    </field>
</record>
```

---

## Form View

```xml
<record id="view_my_model_form" model="ir.ui.view">
    <field name="name">my.model.form</field>
    <field name="model">my.model</field>
    <field name="arch" type="xml">
        <form string="My Record">
            <header>
                <button name="action_confirm" string="Confirm" type="object"
                        class="btn-primary"
                        <!-- v14-v16: -->
                        attrs="{'invisible': [('state', '!=', 'draft')]}"/>
                        <!-- v18+: invisible="state != 'draft'" -->
                <button name="action_cancel" string="Cancel" type="object"
                        attrs="{'invisible': [('state', 'in', ['draft', 'cancel'])]}"/>
                <field name="state" widget="statusbar"
                       statusbar_visible="draft,confirmed,done"/>
            </header>

            <!-- v16-: chatter with div -->
            <!-- v17+: use <chatter/> tag -->

            <sheet>
                <!-- Stat buttons -->
                <div class="oe_button_box" name="button_box">
                    <button class="oe_stat_button" type="object"
                            name="action_view_lines" icon="fa-list">
                        <field name="line_count" widget="statinfo" string="Lines"/>
                    </button>
                </div>

                <!-- Avatar / image -->
                <field name="image" widget="image" class="oe_avatar"
                       options="{'preview_image': 'image'}"/>

                <div class="oe_title">
                    <h1><field name="name" placeholder="Record Name..."/></h1>
                </div>

                <group>
                    <group string="General">
                        <field name="partner_id"/>
                        <field name="date"/>
                        <field name="user_id"/>
                    </group>
                    <group string="Details">
                        <field name="company_id" groups="base.group_multi_company"/>
                        <field name="currency_id" invisible="1"/>
                        <field name="amount_total" widget="monetary"/>
                    </group>
                </group>

                <notebook>
                    <page string="Lines" name="lines">
                        <field name="line_ids" nolabel="1">
                            <!-- v14-v16: -->
                            <tree editable="bottom">
                                <field name="product_id"/>
                                <field name="quantity"/>
                                <field name="price_unit"/>
                            </tree>
                            <!-- v18+: <list editable="bottom"> -->
                        </field>
                    </page>
                    <page string="Notes" name="notes">
                        <field name="notes" nolabel="1" placeholder="Internal notes..."/>
                    </page>
                </notebook>
            </sheet>

            <!-- v14-v16 chatter -->
            <div class="oe_chatter">
                <field name="message_follower_ids"/>
                <field name="activity_ids"/>
                <field name="message_ids"/>
            </div>
            <!-- v17+: <chatter/> -->
        </form>
    </field>
</record>
```

---

## Dynamic Attributes — Version Comparison

```xml
<!-- ==================== v14, v15, v16 ==================== -->
<field name="date_end"
       attrs="{'invisible': [('state', '!=', 'done')],
               'required': [('state', '=', 'done')]}"/>

<field name="discount"
       attrs="{'readonly': [('state', 'not in', ['draft', 'confirmed'])]}"/>

<button name="action_cancel"
        attrs="{'invisible': [('state', 'in', ['draft', 'cancel'])]}"/>

<!-- ==================== v17 (both valid) ==================== -->
<field name="date_end"
       attrs="{'invisible': [('state', '!=', 'done')]}"/>
<!-- ATAU -->
<field name="date_end" invisible="state != 'done'"/>

<!-- ==================== v18, v19 ==================== -->
<field name="date_end"
       invisible="state != 'done'"
       required="state == 'done'"/>

<field name="discount" readonly="state not in ('draft', 'confirmed')"/>

<button name="action_cancel" invisible="state in ('draft', 'cancel')"/>
```

---

## Search View

```xml
<record id="view_my_model_search" model="ir.ui.view">
    <field name="name">my.model.search</field>
    <field name="model">my.model</field>
    <field name="arch" type="xml">
        <search string="My Records">
            <!-- Search fields -->
            <field name="name" string="Name" filter_domain="[('name', 'ilike', self)]"/>
            <field name="partner_id"/>

            <!-- Predefined filters -->
            <filter name="draft" string="Draft" domain="[('state', '=', 'draft')]"/>
            <filter name="active" string="Active" domain="[('active', '=', True)]"/>
            <separator/>
            <filter name="my_records" string="My Records"
                    domain="[('user_id', '=', uid)]"/>

            <!-- Group by -->
            <group expand="0" string="Group By">
                <filter name="group_partner" string="Partner"
                        context="{'group_by': 'partner_id'}"/>
                <filter name="group_state" string="Status"
                        context="{'group_by': 'state'}"/>
                <filter name="group_date" string="Date"
                        context="{'group_by': 'date:month'}"/>
            </group>
        </search>
    </field>
</record>
```

---

## View Inheritance (XPath)

```xml
<record id="view_my_model_form_inherit" model="ir.ui.view">
    <field name="name">my.model.form.inherit</field>
    <field name="model">my.model</field>
    <field name="inherit_id" ref="base_module.view_my_model_form"/>
    <field name="arch" type="xml">

        <!-- Add field after another field -->
        <field name="partner_id" position="after">
            <field name="custom_field"/>
        </field>

        <!-- Add button in header -->
        <header position="inside">
            <button name="action_custom" string="Custom Action" type="object"
                    class="btn-secondary"/>
        </header>

        <!-- Replace entire field -->
        <field name="old_field" position="replace">
            <field name="new_field"/>
        </field>

        <!-- Hide field -->
        <field name="unwanted_field" position="attributes">
            <attribute name="invisible">1</attribute>
        </field>

        <!-- Add new page in notebook -->
        <notebook position="inside">
            <page string="Custom Tab" name="custom">
                <group>
                    <field name="custom_field"/>
                </group>
            </page>
        </notebook>

        <!-- XPath to specific element -->
        <xpath expr="//group[@name='details']" position="inside">
            <field name="extra_field"/>
        </xpath>
    </field>
</record>
```

---

## Kanban View

```xml
<record id="view_my_model_kanban" model="ir.ui.view">
    <field name="name">my.model.kanban</field>
    <field name="model">my.model</field>
    <field name="arch" type="xml">
        <kanban default_group_by="state" quick_create="false">
            <field name="name"/>
            <field name="state"/>
            <field name="partner_id"/>
            <field name="amount_total"/>
            <field name="color"/>
            <templates>
                <t t-name="kanban-box">
                    <div t-attf-class="oe_kanban_card oe_kanban_global_click
                                       o_kanban_record_has_image_fill
                                       oe_kanban_color_{{record.color.raw_value}}">
                        <div class="o_kanban_record_top">
                            <div class="o_kanban_record_headings">
                                <strong class="o_kanban_record_title">
                                    <field name="name"/>
                                </strong>
                            </div>
                        </div>
                        <div class="o_kanban_record_bottom">
                            <div class="oe_kanban_bottom_left">
                                <field name="amount_total" widget="monetary"/>
                            </div>
                            <div class="oe_kanban_bottom_right">
                                <field name="partner_id" widget="many2one_avatar"/>
                            </div>
                        </div>
                    </div>
                </t>
            </templates>
        </kanban>
    </field>
</record>
```

---

## Action & Menu

```xml
<!-- Action -->
<record id="action_my_model" model="ir.actions.act_window">
    <field name="name">My Records</field>
    <field name="res_model">my.model</field>
    <field name="view_mode">list,form,kanban</field>  <!-- v18+: list; v16-: tree -->
    <field name="domain">[]</field>
    <field name="context">{'default_state': 'draft'}</field>
</record>

<!-- Menu -->
<menuitem id="menu_my_module_root"
          name="My Module"
          sequence="100"/>

<menuitem id="menu_my_module_my_model"
          name="My Records"
          parent="menu_my_module_root"
          action="action_my_model"
          sequence="10"/>
```
