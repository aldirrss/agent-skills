# Config & Logging

Pydantic Settings, Loguru setup, and health heartbeat. Read this first — everything else depends on it.

## Table of contents
- Dependencies
- Pydantic Settings
- Loguru setup
- Health heartbeat

---

## Dependencies

```toml
# pyproject.toml / requirements.txt
pydantic-settings>=2.0
loguru>=0.7
redis[asyncio]>=5.0
ccxt[async]>=4.0          # ccxt.pro included
sqlmodel>=0.0.16
asyncpg>=0.29
httpx>=0.27               # LLM API calls
```

---

## Pydantic Settings

```python
# config.py
from decimal import Decimal
from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class BotSettings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # ── Infrastructure ─────────────────────────────────────────────
    redis_url:    str = "redis://localhost:6379"
    database_url: str                              # required — no default

    # ── Safety hard limits (cannot be overridden per-worker) ────────
    max_leverage:       int     = Field(10, ge=1, le=20)
    max_risk_pct:       Decimal = Field(Decimal("0.02"), gt=0, le=Decimal("0.05"))
    max_open_positions: int     = Field(5, ge=1, le=20)
    circuit_breaker_daily_loss_pct: Decimal = Field(Decimal("0.05"), gt=0)
    circuit_breaker_drawdown_pct:   Decimal = Field(Decimal("0.10"), gt=0)

    # ── LLM providers (at least one required for LLMSignalAgent) ────
    gemini_api_key:     str | None = None
    groq_api_key:       str | None = None
    openrouter_api_key: str | None = None

    # ── Bot engine behaviour ────────────────────────────────────────
    health_heartbeat_interval_s: int = 10
    reconciliation_interval_s:   int = 30
    pnl_snapshot_interval_s:     int = 900     # 15 minutes
    llm_refresh_interval_s:      int = 240     # 4 minutes

    # ── Logging ────────────────────────────────────────────────────
    log_level:    str = "INFO"
    log_dir:      str = "logs"
    log_rotation: str = "100 MB"
    log_retention: str = "30 days"

    @field_validator("database_url")
    @classmethod
    def must_be_async(cls, v: str) -> str:
        if not v.startswith("postgresql+asyncpg://"):
            raise ValueError("database_url must use postgresql+asyncpg:// driver")
        return v

    def llm_providers(self) -> list[dict]:
        """Returns configured providers in priority order."""
        providers = []
        if self.gemini_api_key:
            providers.append({
                "api_key":  self.gemini_api_key,
                "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
                "model":    "gemini-2.0-flash",
            })
        if self.groq_api_key:
            providers.append({
                "api_key":  self.groq_api_key,
                "base_url": "https://api.groq.com/openai/v1",
                "model":    "llama-3.3-70b-versatile",
            })
        if self.openrouter_api_key:
            providers.append({
                "api_key":  self.openrouter_api_key,
                "base_url": "https://openrouter.ai/api/v1",
                "model":    "mistralai/mistral-7b-instruct",
            })
        return providers


# Singleton — import from anywhere
settings = BotSettings()
```

```ini
# .env (never commit to git)
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgresql+asyncpg://bot:secret@localhost:5432/trading_bot
GEMINI_API_KEY=AIza...
MAX_LEVERAGE=10
MAX_RISK_PCT=0.01
LOG_LEVEL=INFO
```

---

## Loguru setup

```python
# logger_setup.py
import sys
from pathlib import Path
from loguru import logger
from config import settings


def setup_logger() -> None:
    """Call once at process startup, before any other imports use logger."""
    logger.remove()     # remove default stderr handler

    # Stderr: human-readable during development
    logger.add(
        sys.stderr,
        level=settings.log_level,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
            "<level>{level: <8}</level> | "
            "<cyan>{extra[component]}</cyan> | "
            "<cyan>{extra[symbol]}</cyan> | "
            "{message}"
        ),
        colorize=True,
    )

    # File: JSON-structured for grep/parsing
    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)

    logger.add(
        log_dir / "bot_{time}.log",
        level="DEBUG",
        format="{time:YYYY-MM-DDTHH:mm:ss.fff}Z | {level} | {extra} | {message}",
        rotation=settings.log_rotation,
        retention=settings.log_retention,
        compression="gz",
        serialize=True,    # JSON lines format
        enqueue=True,      # async-safe: writes in background thread
    )

    # Separate file for errors only — easy to monitor
    logger.add(
        log_dir / "errors.log",
        level="ERROR",
        rotation="50 MB",
        retention="60 days",
        serialize=True,
        enqueue=True,
    )


# Component loggers — bind context so every log line is filterable
def component_logger(component: str, symbol: str = "global"):
    """
    Usage:
        log = component_logger("strategy_worker", "BTCUSDT")
        log.info("Signal generated", direction="long", confidence=0.82)
    """
    return logger.bind(component=component, symbol=symbol)
```

**Usage pattern in every component:**

```python
from logger_setup import component_logger

class StrategyWorker:
    def __init__(self, symbol: str, ...):
        self.log = component_logger("strategy_worker", symbol)

    async def run(self, ...):
        self.log.info("Worker started")
        try:
            # ...
            self.log.info("Signal generated", direction="long", confidence=0.82)
        except Exception as e:
            self.log.exception("Unhandled error in strategy worker")
            raise
```

`@logger.catch` for task-level exception catching:

```python
@logger.catch(reraise=True)
async def run_strategy_worker(symbol, config, redis, stop_event):
    # any uncaught exception logs full traceback + reraises
    ...
```

---

## Health heartbeat

```python
# health.py
import asyncio
import json
import time
from logger_setup import component_logger
from config import settings

log = component_logger("health")


async def run_health_heartbeat(redis, registry, stop_event: asyncio.Event):
    """
    Publishes bot health to Redis every N seconds.
    API Server reads these keys to serve GET /health.
    If bot engine crashes, keys expire → API returns unhealthy.
    """
    ttl = settings.health_heartbeat_interval_s * 3  # 3 missed beats = dead

    while not stop_event.is_set():
        try:
            now_ms  = int(time.time() * 1000)
            workers = registry.all_symbols()
            status  = await redis.get("state.bot.status") or "unknown"

            # Global heartbeat
            await redis.set("bot.heartbeat", str(now_ms), ex=ttl)

            # Per-component health
            components = {
                "engine":   {"status": "ok", "ts": now_ms},
                "workers":  {"active": workers, "count": len(workers)},
                "bot":      {"status": status},
            }
            for name, data in components.items():
                await redis.set(
                    f"bot.health.{name}",
                    json.dumps(data),
                    ex=ttl,
                )

        except Exception:
            log.exception("Health heartbeat error")

        await asyncio.sleep(settings.health_heartbeat_interval_s)


# FastAPI endpoint (in API Server, NOT bot engine)
# @app.get("/health")
# async def health(redis = Depends(get_redis)):
#     heartbeat = await redis.get("bot.heartbeat")
#     if not heartbeat:
#         return JSONResponse({"status": "unhealthy"}, status_code=503)
#     age_ms = int(time.time() * 1000) - int(heartbeat)
#     if age_ms > 30_000:   # 30s without heartbeat = dead
#         return JSONResponse({"status": "unhealthy", "last_seen_ms": age_ms}, 503)
#     workers = await redis.smembers("state.bot.workers")
#     return {"status": "ok", "active_workers": list(workers), "age_ms": age_ms}
```
