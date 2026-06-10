# Health Checker

System health monitoring: heartbeat, Redis, PostgreSQL, WebSocket connectivity per symbol, and worker status.

## Table of contents
- HealthChecker component
- Individual checks
- Health snapshot for API

---

## HealthChecker component

```python
# components/health_checker.py
import asyncio
import json
import time
from logger_setup import component_logger
from config import settings

log = component_logger("health_checker")


class HealthChecker:
    """
    Runs as asyncio task. Polls system health every 10s.
    Fires alerts via AlertManager. Writes snapshot to Redis for API /health.
    """

    def __init__(self, redis, registry, session_factory, alert_manager):
        self.redis         = redis
        self.registry      = registry
        self.session_factory = session_factory
        self.alerts        = alert_manager
        self._consecutive_executor_failures = {}   # symbol → count

    async def run(self, stop_event: asyncio.Event) -> None:
        log.info("Starting")
        while not stop_event.is_set():
            try:
                await self._check_all()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Health check cycle error")
            await asyncio.sleep(settings.health_heartbeat_interval_s)
        log.info("Stopped")

    async def _check_all(self) -> None:
        symbols = self.registry.all_symbols()
        results = await asyncio.gather(
            self._check_heartbeat(),
            self._check_circuit_breaker(),
            self._check_redis(),
            self._check_db(),
            self._check_workers(symbols),
            *[self._check_liquidation(s) for s in symbols],
            return_exceptions=True,
        )
        for r in results:
            if isinstance(r, dict) and r:
                await self.alerts.send(r["alert_type"], r["symbol"], r)
            elif isinstance(r, list):
                for item in r:
                    if item:
                        await self.alerts.send(item["alert_type"], item["symbol"], item)

        await self._write_health_snapshot(symbols)

    # ── Individual checks ────────────────────────────────────────────

    async def _check_heartbeat(self) -> dict | None:
        hb = await self.redis.get("bot.heartbeat")
        if not hb:
            return {"alert_type": "heartbeat_missed", "symbol": "global",
                    "detail": "No heartbeat. Bot engine may be dead."}
        age_ms = int(time.time() * 1000) - int(hb)
        if age_ms > 30_000:
            return {"alert_type": "heartbeat_missed", "symbol": "global",
                    "detail": f"Last heartbeat {age_ms/1000:.0f}s ago."}
        return None

    async def _check_circuit_breaker(self) -> dict | None:
        status = await self.redis.get("state.bot.status")
        if status == "halted":
            return {"alert_type": "circuit_breaker_trip", "symbol": "global",
                    "detail": "Circuit breaker tripped. Manual review required."}
        return None

    async def _check_redis(self) -> dict | None:
        try:
            await asyncio.wait_for(self.redis.ping(), timeout=5.0)
            return None
        except Exception as e:
            return {"alert_type": "redis_lost", "symbol": "global",
                    "detail": f"Redis ping failed: {e}"}

    async def _check_db(self) -> dict | None:
        try:
            from sqlalchemy import text
            async with self.session_factory() as session:
                await asyncio.wait_for(
                    session.exec(text("SELECT 1")), timeout=5.0
                )
            return None
        except Exception as e:
            return {"alert_type": "db_fallback_growing", "symbol": "global",
                    "detail": f"PostgreSQL check failed: {e}"}

    async def _check_workers(self, symbols: list[str]) -> list[dict]:
        alerts = []
        redis_workers = await self.redis.smembers("state.bot.workers")
        registry_symbols = set(symbols)

        # Workers in Redis but not in registry = crashed and not recovered
        orphaned = redis_workers - registry_symbols
        for sym in orphaned:
            alerts.append({
                "alert_type": "worker_restart_failed", "symbol": sym,
                "detail": f"Worker {sym} in Redis but not in registry. Restart failed.",
            })
        return alerts

    async def _check_liquidation(self, symbol: str) -> dict | None:
        pos_raw   = await self.redis.get(f"state.position.{symbol}")
        price_raw = await self.redis.get(f"state.price.{symbol}")
        if not pos_raw or not price_raw:
            return None

        from decimal import Decimal
        pos       = json.loads(pos_raw)
        price     = Decimal(price_raw)
        entry     = Decimal(pos["entry_price"])
        leverage  = Decimal(str(pos.get("leverage", 5)))
        direction = pos["direction"]
        mmr       = Decimal("0.005")

        liq = entry * (1 - 1/leverage + mmr) if direction == "long" \
              else entry * (1 + 1/leverage - mmr)
        dist_pct = float(abs(price - liq) / price)

        if dist_pct < 0.03:
            return {"alert_type": "liquidation_warning", "symbol": symbol,
                    "detail": f"Price {price} — {dist_pct*100:.2f}% from liq {liq:.2f}"}
        return None

    # ── Health snapshot for API /health endpoint ─────────────────────

    async def _write_health_snapshot(self, symbols: list[str]) -> None:
        now_ms = int(time.time() * 1000)
        hb     = await self.redis.get("bot.heartbeat")
        status = await self.redis.get("state.bot.status") or "unknown"

        positions = {}
        for sym in symbols:
            pos = await self.redis.get(f"state.position.{sym}")
            positions[sym] = bool(pos)

        snapshot = {
            "status":           status,
            "heartbeat_age_ms": now_ms - int(hb) if hb else -1,
            "active_workers":   symbols,
            "open_positions":   positions,
            "ts":               now_ms,
        }
        await self.redis.set(
            "bot.health.snapshot",
            json.dumps(snapshot),
            ex=settings.health_heartbeat_interval_s * 3,
        )
```

---

## API health endpoint

```python
# In FastAPI API Server (NOT bot engine):
from fastapi import FastAPI
from fastapi.responses import JSONResponse
import json, time

@app.get("/health")
async def health(redis=Depends(get_redis)):
    raw = await redis.get("bot.health.snapshot")
    if not raw:
        return JSONResponse({"status": "unhealthy", "reason": "no_snapshot"}, 503)

    snap = json.loads(raw)
    age  = int(time.time() * 1000) - snap.get("ts", 0)

    if age > 30_000 or snap.get("heartbeat_age_ms", -1) > 30_000:
        return JSONResponse({
            "status":  "unhealthy",
            "reason":  "heartbeat_stale",
            "age_ms":  age,
            "snapshot": snap,
        }, status_code=503)

    return {"status": "ok", **snap}


@app.get("/health/alerts")
async def active_alerts(redis=Depends(get_redis)):
    """List currently active (throttled) alerts."""
    keys = await redis.keys("alert.state.*")
    alerts = []
    for key in keys:
        ttl    = await redis.ttl(key)
        parts  = key.split(".")
        alerts.append({
            "alert_type":  parts[2] if len(parts) > 2 else "unknown",
            "symbol":      parts[3] if len(parts) > 3 else "global",
            "expires_in_s": ttl,
        })
    return {"active_alerts": alerts}
```
