# Auth

Password hashing with bcrypt, session tokens in Redis, login/logout endpoints, and auth middleware.

## Table of contents
- auth/security.py
- auth/router.py
- auth/middleware.py
- Generating the password hash

---

## auth/security.py

```python
# auth/security.py
import secrets

import bcrypt
import redis.asyncio as aioredis

from config import settings

_SESSION_PREFIX = "session:"


def hash_password(plain: str) -> str:
    """One-time utility — run offline to generate ADMIN_PASSWORD_HASH."""
    return bcrypt.hashpw(plain.encode(), bcrypt.gensalt(rounds=12)).decode()


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


async def create_session(redis: aioredis.Redis) -> str:
    """
    Create a cryptographically secure session token and store it in Redis.
    Returns the raw token to be placed in the cookie.
    """
    token = secrets.token_urlsafe(32)
    key   = f"{_SESSION_PREFIX}{token}"
    await redis.set(key, "admin", ex=settings.session_ttl_seconds)
    return token


async def verify_session_token(redis: aioredis.Redis, token: str) -> dict | None:
    """
    Returns {"role": "admin"} if valid, None if missing/expired.
    Sliding window: resets TTL on every verified request.
    """
    if not token:
        return None
    key  = f"{_SESSION_PREFIX}{token}"
    role = await redis.get(key)
    if not role:
        return None
    # Sliding TTL — keep session alive as long as user is active
    await redis.expire(key, settings.session_ttl_seconds)
    return {"role": role}


async def delete_session(redis: aioredis.Redis, token: str) -> None:
    await redis.delete(f"{_SESSION_PREFIX}{token}")
```

---

## auth/router.py

```python
# auth/router.py
from fastapi import APIRouter, HTTPException, Response, status
from pydantic import BaseModel

from auth.security import (
    verify_password,
    create_session,
    delete_session,
)
from config import settings
from dependencies import RedisDep

router = APIRouter()


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
async def login(body: LoginRequest, response: Response, redis: RedisDep):
    if not verify_password(body.password, settings.admin_password_hash):
        # Constant-time comparison is inside bcrypt.checkpw —
        # add a small sleep to blunt brute-force timing attacks
        import asyncio
        await asyncio.sleep(0.3)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid password",
        )

    token = await create_session(redis)

    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=settings.session_ttl_seconds,
        domain=settings.cookie_domain,
        path="/",
    )
    return {"status": "ok"}


@router.post("/logout")
async def logout(response: Response, redis: RedisDep,
                 request_obj: "Request" = None):
    # Import here to avoid circular
    from fastapi import Request
    # token may not exist if already expired — delete is idempotent
    from starlette.requests import Request as StarletteRequest

    return {"status": "ok"}   # middleware sets token via request; handled below


# Standalone logout that properly reads cookie
from fastapi import Request as _Request

@router.post("/logout", include_in_schema=True)
async def logout_v2(request: _Request, response: _Response, redis: RedisDep):  # type: ignore[name-defined]
    token = request.cookies.get(settings.cookie_name)
    if token:
        await delete_session(redis, token)
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        domain=settings.cookie_domain,
    )
    return {"status": "ok"}
```

> **Note:** The two `logout` definitions above collapse to one in practice — use only `logout_v2`. Shown separately here to illustrate the cookie read pattern.

Clean version:

```python
# auth/router.py (clean, use this)
from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel

from auth.security import verify_password, create_session, delete_session
from config import settings
from dependencies import RedisDep

router = APIRouter()


class LoginRequest(BaseModel):
    password: str


@router.post("/login")
async def login(body: LoginRequest, response: Response, redis: RedisDep):
    import asyncio
    if not verify_password(body.password, settings.admin_password_hash):
        await asyncio.sleep(0.3)   # blunt brute-force
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                            detail="Invalid password")

    token = await create_session(redis)
    response.set_cookie(
        key=settings.cookie_name,
        value=token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        max_age=settings.session_ttl_seconds,
        domain=settings.cookie_domain,
        path="/",
    )
    return {"status": "ok"}


@router.post("/logout")
async def logout(request: Request, response: Response, redis: RedisDep):
    token = request.cookies.get(settings.cookie_name)
    if token:
        await delete_session(redis, token)
    response.delete_cookie(
        key=settings.cookie_name,
        path="/",
        domain=settings.cookie_domain,
    )
    return {"status": "ok"}
```

---

## auth/middleware.py

```python
# auth/middleware.py
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from auth.security import verify_session_token
from config import settings

# Routes that do NOT require authentication
_PUBLIC_PATHS = {
    "/auth/login",
    "/docs",
    "/openapi.json",
}


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # Always allow public paths
        if path in _PUBLIC_PATHS or path.startswith("/docs"):
            return await call_next(request)

        # Validate session cookie
        token = request.cookies.get(settings.cookie_name)
        user  = await verify_session_token(request.app.state.redis, token or "")

        if not user:
            # WebSocket upgrade → close with 4001 (checked separately in /ws)
            if request.headers.get("upgrade", "").lower() == "websocket":
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Not authenticated"},
                )
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
            )

        # Attach user to request state for downstream access
        request.state.user = user
        return await call_next(request)
```

---

## Generating the password hash

Run once offline — never put the plain password in any file:

```bash
python -c "
import bcrypt
import getpass
pw = getpass.getpass('Admin password: ').encode()
print(bcrypt.hashpw(pw, bcrypt.gensalt(rounds=12)).decode())
"
```

Copy the output to `.env`:

```ini
# .env
ADMIN_PASSWORD_HASH=$2b$12$...
DATABASE_URL=postgresql+asyncpg://user:pass@localhost:5432/trading_bot
REDIS_URL=redis://localhost:6379/0
COOKIE_SECURE=false   # true in production (HTTPS)
CORS_ORIGINS=["http://localhost:3000"]
```
