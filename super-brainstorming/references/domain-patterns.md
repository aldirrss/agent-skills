# Domain Patterns Reference

Patterns specific to common domains Aldi works in. Load the relevant section when brainstorming in that domain.

---

## Odoo Module Architecture Patterns

### Pattern 1: Feature Module (most common)
```
my_module/
├── __manifest__.py
├── models/
│   ├── __init__.py
│   └── my_model.py
├── views/
│   └── my_model_views.xml
├── security/
│   ├── ir.model.access.csv
│   └── security.xml
├── data/
│   └── my_data.xml
└── static/src/
    ├── js/          (OWL components)
    └── xml/         (OWL templates)
```

**Decision trigger:** Use this when building a self-contained business domain.

### Pattern 2: Integration Module
Thin module that bridges Odoo with external system (e.g., Camunda, payment gateway, external API).

Key considerations:
- Put all external calls in a `services/` layer (not in models directly)
- Use `ir.config_parameter` for config, not hardcoded values
- Always handle API failures gracefully — external systems fail
- Add a `_test_connection()` method for admin validation

### Pattern 3: Extension Module
Extends existing Odoo module without forking it.

Rules:
- Inherit via `_inherit`, never copy-paste base code
- Use `super()` always
- Avoid overriding core methods unless necessary — prefer adding hooks
- Name: `{base_module_name}_extension` or `{company_prefix}_{base_module}`

---

## Infrastructure / DevOps Patterns

### Nginx Reverse Proxy (Multi-service)
When multiple services share one server (e.g., Odoo + Mailcow):

```nginx
# Service routing by subdomain
server {
    server_name odoo.domain.com;
    location / { proxy_pass http://localhost:8069; }
}
server {
    server_name mail.domain.com;
    location / { proxy_pass http://localhost:8080; }
}
```

Key decisions:
- **SSL termination**: at Nginx level (recommended) or per-service?
- **WebSocket**: Odoo needs `proxy_read_timeout 720s` and upgrade headers
- **Static files**: serve directly from Nginx, not through Odoo

### Docker Compose Multi-Environment Pattern
```yaml
# base: docker-compose.yml
# override: docker-compose.prod.yml / docker-compose.dev.yml
# Run: docker compose -f docker-compose.yml -f docker-compose.prod.yml up
```

### CI/CD Decision Tree
```
Changed files in which path?
├── addons/*         → lint + test changed modules → deploy
├── docker/*         → rebuild image → deploy
├── nginx/*          → validate config → reload nginx
└── .github/*        → no deploy needed
```

---

## API Design Patterns

### REST Controller in Odoo (JSON API)
```python
@http.route('/api/v1/resource', type='json', auth='user', methods=['POST'])
def my_endpoint(self, **kwargs):
    # Validate input
    # Call service layer
    # Return structured response
    return {'status': 'ok', 'data': {...}}
```

Best practices:
- Always version your API (`/api/v1/`)
- Use `type='json'` for structured data, `type='http'` for file downloads
- Auth options: `'user'` (session), `'api_key'`, `'public'`, `'none'`
- Never return Odoo recordsets directly — serialize to dicts

### Token Auth Pattern (like demo_token_auth)
```
Token Flow:
  Generate token → Store in DB with expiry + metadata
  → User visits URL with token
  → Validate token → Auto-login session
  → Redirect to target
```

Security checklist:
- [ ] One-time use or time-limited?
- [ ] Rate limit generation endpoint
- [ ] Log all token validations
- [ ] Invalidate on use (if one-time)

---

## FastAPI / Python Backend Patterns

### Service Layer Architecture
```
Request → Router (validation) → Service (business logic) → Repository (DB) → Response
```

Never put business logic in routers. Never put DB calls in services directly — use a repository layer.

### Background Task Pattern
```python
# FastAPI + asyncio
@app.post('/trigger')
async def trigger(background_tasks: BackgroundTasks):
    background_tasks.add_task(heavy_function, param)
    return {'status': 'queued'}
```

For long-running tasks: use Celery + Redis, not BackgroundTasks.

---

## Next.js + Odoo Integration Patterns

### Data Fetching Strategy
| Data type | Strategy | Reason |
|-----------|----------|--------|
| Product catalog | SSG + ISR | Rarely changes, needs SEO |
| User-specific | Client-side fetch | Auth-gated |
| Real-time inventory | SSR or SWR | Freshness critical |
| Static content | SSG | Never changes |

### Odoo REST vs JSON-RPC
- **JSON-RPC** (`/web/dataset/call_kw`): Use for standard CRUD on models
- **Custom REST** (`/api/v1/...`): Use when you need clean API for external consumers
- **GraphQL wrapper**: Rarely needed, only if frontend complexity justifies it