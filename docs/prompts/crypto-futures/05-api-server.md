# Fase 05 — API Server

Tujuan: FastAPI server dengan auth, bot control endpoints, data endpoints, WebSocket relay.
Prasyarat: Fase 01-02 selesai (database models dan config tersedia).

---

## Prompt 5.1 — App setup dan config

```
Gunakan @crypto-futures-bot-api references/app-setup.md secara penuh.

Buat file-file berikut di api_server/:

1. config.py
   Pydantic BaseSettings dengan:
   - redis_url, database_url
   - admin_password_hash (bcrypt hash dari .env)
   - session_ttl_seconds (default 86400)
   - cookie_name, cookie_secure, cookie_httponly, cookie_domain
   - cors_origins (list dari JSON env var)
   - command_timeout_s (default 10.0)
   - Singleton: settings = Settings()

2. app.py
   Factory function create_app() dengan lifespan:
   - Connect Redis pool (aioredis.from_url)
   - Connect PostgreSQL (create_async_engine + sessionmaker)
   - Buat ConnectionManager untuk WebSocket (app.state.ws_manager)
   - Start Redis relay task sebagai background task (app.state.relay_task)
   - Register routers: auth, bot, data
   - CORS middleware dengan settings.cors_origins
   - Shutdown: cancel relay task, close Redis, dispose engine

3. dependencies.py
   - get_redis() → aioredis.Redis dari app.state
   - get_session() → AsyncSession dari sessionmaker
   - get_current_user(request) → str username, raise 401 jika tidak terauth
   - Type aliases: RedisDep, SessionDep, UserDep

4. main.py
   - uvicorn.run dengan workers=1 (WAJIB — ConnectionManager tidak thread-safe)
   - Port dari env (default 8000)
   - Log level dari settings
```

---

## Prompt 5.2 — Authentication

```
Gunakan @crypto-futures-bot-api references/auth.md secara penuh.

Buat folder api_server/auth/ dengan:

1. security.py
   - hash_password(plain) → str (bcrypt)
   - verify_password(plain, hashed) → bool
   - create_session(redis, username) → token:
     * token = secrets.token_hex(32)
     * SET session:{token} = username (TTL settings.session_ttl_seconds)
     * Sliding window: refresh TTL setiap request via verify_session_token
   - verify_session_token(redis, token) → username|None:
     * GET session:{token}
     * Jika ada: EXPIRE session:{token} settings.session_ttl_seconds (sliding)
     * Return username atau None
   - delete_session(redis, token) → None

2. router.py
   POST /auth/login:
   - Terima {username, password} form data
   - verify_password terhadap settings.admin_password_hash
   - Tambahkan asyncio.sleep(0.3) sebelum response (anti brute-force timing)
   - Jika valid: create_session, set HttpOnly cookie, return {status: ok}
   - Jika invalid: return 401 setelah sleep

   POST /auth/logout:
   - delete_session untuk token dari cookie
   - Clear cookie
   - Return {status: ok}

3. middleware.py
   AuthMiddleware(BaseHTTPMiddleware):
   - Bypass untuk: /auth/login, /docs, /openapi.json, /health (GET)
   - Semua route lain: cek cookie via verify_session_token
   - Jika tidak valid: return 401 JSON (bukan redirect)
```

---

## Prompt 5.3 — Bot control endpoints

```
Gunakan @crypto-futures-bot-api references/bot-control-endpoints.md secara penuh.

Buat api_server/routers/_command.py:
- async def send_command(redis, command, symbol=None, payload=None, timeout_s=None):
  * SUBSCRIBE ke bot.status TERLEBIH DAHULU sebelum xadd
  * Generate req_id = uuid4()
  * xadd ke stream.commands dengan req_id, command, symbol, payload, ts
  * Listen bot.status pub/sub untuk response dengan req_id yang cocok
  * asyncio.wait_for dengan timeout (default settings.command_timeout_s)
  * Raise HTTPException 504 jika timeout, 502 jika bot return error

Buat api_server/routers/bot.py dengan endpoints:
- GET /bot/status → {status, workers, uptime, heartbeat_age_s}
- POST /bot/symbol → {strategy, leverage, risk_pct, timeframes, exchange}
  Panggil send_command("ADD_SYMBOL")
- DELETE /bot/symbol/{symbol}
  Panggil send_command("REMOVE_SYMBOL")
- POST /bot/symbol/{symbol}/pause
  Panggil send_command("PAUSE_SYMBOL")
- POST /bot/symbol/{symbol}/resume
  Panggil send_command("RESUME_SYMBOL")
- PATCH /bot/symbol/{symbol}/config → partial update config
  Panggil send_command("UPDATE_CONFIG")
- POST /bot/emergency-stop → timeout_s=30.0
  Panggil send_command("EMERGENCY_STOP", timeout_s=30.0)

Semua endpoint require UserDep (authenticated).
```

---

## Prompt 5.4 — Data endpoints

```
Gunakan @crypto-futures-bot-api references/data-endpoints.md secara penuh.

Buat api_server/routers/data.py dengan endpoints:

GET /trades:
- Query params: symbol?, status?, page=1, page_size=50
- Query dari PostgreSQL menggunakan db/queries.py
- Return: {total, page, page_size, items: [Trade]}
- Semua nilai harga sebagai string (JANGAN float di JSON response)

GET /metrics/performance:
- Query params: symbol?, days=30
- Return: {win_rate, profit_factor, avg_pnl, max_drawdown_pct, trade_count}
- Gunakan get_trade_stats() dari db/queries.py

GET /metrics/equity-curve:
- Query params: days=90
- Return list {date (ISO), cumulative_pnl (str), drawdown_pct (str)}
- Gunakan get_equity_curve() dari db/queries.py

GET /health:
- Cek heartbeat age: sekarang - state.health.heartbeat
- Return: {status: ok|degraded|dead, heartbeat_age_s, worker_count, workers,
           bot_status, redis_ok, db_ok}
- Tidak memerlukan auth (monitoring endpoint)

GET /health/alerts:
- Scan Redis keys: alert.throttle.*
- Return list alert yang sedang aktif: {alert_id, level, message, triggered_at}

GET /accounts:
- List dari tabel Account
- Return: {id, name, exchange, api_key_ref (bukan actual key!), is_testnet, is_active}
```

---

## Prompt 5.5 — WebSocket relay

```
Gunakan @crypto-futures-bot-api references/websocket-relay.md secara penuh.

Buat dua file:

1. api_server/ws/manager.py — ConnectionManager:
   - Set of WebSocket connections dengan asyncio.Lock
   - connect(ws): accept() + add ke set
   - disconnect(ws): discard dari set
   - broadcast(message: str): kirim ke semua, remove dead connections on error
   - Property connection_count

2. api_server/ws/relay.py:
   a. async def start_redis_relay(redis, manager):
      - Subscribe ke: ["bot.status", "position.updates"]
      - Loop: setiap message type=="message", broadcast ke semua WS clients
      - Reconnect wrapper: jika crash, retry dengan delay 5s
      - Dedicated pubsub connection (tidak share dengan command connection)

   b. @router.websocket("/ws"):
      - Validate auth cookie SEBELUM accept() — tutup 4001 jika tidak auth
      - manager.connect(ws)
      - Push initial state: _push_initial_state(ws, redis)
        * bot status + active workers + semua open positions
        * Format konsisten dengan payload dari pub/sub
      - Message loop:
        * asyncio.wait_for(ws.receive_text(), timeout=25.0)
        * Timeout: kirim server ping JSON
        * Text "ping": balas "pong"
        * JSON command: forward via send_command(), response via pub/sub broadcast
      - finally: manager.disconnect(ws)
```

---

## Roadmap

Selesai? Tandai di `docs/ROADMAP.md` → Phase 1 › API Server:

- [ ] Auth: login/logout with HttpOnly cookie
- [ ] Bot control: add/remove symbol, pause, resume, emergency stop
- [ ] Data endpoints: trades, performance metrics, equity curve
- [ ] WebSocket relay: real-time broadcast to dashboard
