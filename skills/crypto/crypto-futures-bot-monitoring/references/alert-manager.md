# AlertManager

Central dispatcher: dedup, throttle, severity routing. Every alert goes through here.

## Table of contents
- AlertManager class
- Throttle & dedup via Redis
- Integration points

---

## AlertManager class

```python
# alerts/manager.py
import asyncio
import json
import time
from dataclasses import dataclass
from enum import Enum

from alerts.rules import Severity, CRITICAL_RULES, WARNING_RULES, INFO_RULES
from alerts.templates import format_message
from logger_setup import component_logger

log = component_logger("alert_manager")

ALL_RULES = {r.alert_type: r for r in CRITICAL_RULES + WARNING_RULES + INFO_RULES}


class AlertManager:
    """
    Single instance. All components call alert_manager.send(alert_type, symbol, data).
    Handles: dedup via Redis TTL, routing to correct channels, formatting.
    """

    def __init__(self, redis, notifier):
        self.redis    = redis
        self.notifier = notifier   # Notifier instance (telegram + email)

    async def send(self, alert_type: str, symbol: str, data: dict) -> bool:
        """
        Returns True if alert was sent, False if throttled/deduped.
        data must include at minimum: {"symbol": ..., "detail": ...}
        """
        rule = ALL_RULES.get(alert_type)
        if not rule:
            log.warning("Unknown alert type", alert_type=alert_type)
            return False

        # Dedup + throttle check
        if rule.throttle_s > 0:
            key = f"alert.state.{alert_type}.{symbol}"
            if await self.redis.exists(key):
                log.debug("Alert throttled", alert_type=alert_type, symbol=symbol)
                return False
            await self.redis.set(key, "1", ex=rule.throttle_s)

        message = format_message(alert_type, {**data, "symbol": symbol})

        try:
            if rule.severity == Severity.CRITICAL:
                await self.notifier.send_critical(message, rule.title)
            elif rule.severity == Severity.WARNING:
                await self.notifier.send_warning(message, rule.title)
            else:
                await self.notifier.send_info(message)

            log.info("Alert sent", alert_type=alert_type,
                     severity=rule.severity, symbol=symbol)
            return True

        except Exception:
            log.exception("Alert delivery failed", alert_type=alert_type)
            return False

    async def clear_throttle(self, alert_type: str, symbol: str) -> None:
        """Manually clear a throttle — used when condition resolves."""
        await self.redis.delete(f"alert.state.{alert_type}.{symbol}")
```

---

## Throttle & dedup via Redis

Throttle state is stored in Redis with TTL equal to the throttle window:

```
Key:   alert.state.{alert_type}.{symbol}
Value: "1"
TTL:   throttle_s (300 for CRITICAL, 1800 for WARNING, none for INFO)
```

Pattern:
- Key exists → alert was recently sent → skip (throttled)
- Key missing → first occurrence in window → send + set key with TTL
- Key expires → window reset → next occurrence will send again

This means a CRITICAL condition that persists will alert every 5 minutes — enough to wake someone up without spamming.

```python
# Throttle window table
THROTTLE_WINDOWS = {
    Severity.CRITICAL: 300,    # 5 minutes
    Severity.WARNING:  1800,   # 30 minutes
    Severity.INFO:     0,      # no throttle
}
```

**Active alert tracking** — list all currently throttled alerts:

```python
async def active_alerts(redis) -> list[dict]:
    """Returns all active (throttled) alerts — useful for dashboard."""
    keys = await redis.keys("alert.state.*")
    alerts = []
    for key in keys:
        ttl = await redis.ttl(key)
        parts = key.split(".")   # ["alert", "state", alert_type, symbol]
        if len(parts) >= 4:
            alerts.append({
                "alert_type": parts[2],
                "symbol":     parts[3],
                "expires_in": ttl,
            })
    return alerts
```

---

## Integration points

**From OrderExecutor** — SL placement failure (event-driven, not polled):

```python
# In OrderExecutor._execute(), after SL placement fails:
from alerts.rules import make_sl_failed_alert
alert = make_sl_failed_alert(symbol, str(e))
await alert_manager.send("sl_placement_failed", symbol, alert)
```

**From HealthChecker** — polled every 10s:

```python
# In HealthChecker.run():
checks = [
    await check_heartbeat(redis),
    await check_circuit_breaker(redis),
    *[await check_liquidation_warning(redis, s) for s in active_symbols],
]
for result in checks:
    if result:
        await alert_manager.send(result["alert_type"], result["symbol"], result)
```

**From MetricsCollector** — polled every 60s:

```python
# In MetricsCollector.run():
warnings = [
    await check_daily_drawdown(session_factory, account_id),
    await check_consecutive_losses(session_factory, account_id),
    await check_win_rate(session_factory, account_id),
]
for result in warnings:
    if result:
        await alert_manager.send(result["alert_type"], result["symbol"], result)
```

**From PositionTracker** — trade lifecycle INFO alerts:

```python
# After opening position:
await alert_manager.send("trade_opened", symbol, {
    "symbol":      symbol,
    "direction":   pos["direction"],
    "entry_price": pos["entry_price"],
    "sl_price":    pos["sl_price"],
    "strategy":    config.get("strategy"),
    "leverage":    pos.get("leverage"),
})

# After closing position:
await alert_manager.send("trade_closed", symbol, {
    "symbol":      symbol,
    "outcome":     outcome,
    "net_pnl":     f"{net_pnl:.4f}",
    "r_multiple":  f"{r_multiple:.2f}" if r_multiple else "N/A",
    "duration":    _fmt_duration(duration_seconds),
})
```

**Daily summary** — scheduled via asyncio, fires at market day end:

```python
async def send_daily_summary(alert_manager, session_factory, account_id: int):
    from sqlalchemy import text
    async with session_factory() as session:
        result = await session.exec(text("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins,
                   SUM(CASE WHEN net_pnl <= 0 THEN 1 ELSE 0 END) AS losses,
                   ROUND(SUM(net_pnl)::NUMERIC, 4) AS net_pnl,
                   ROUND(SUM(fee_total)::NUMERIC, 4) AS fees
            FROM trades
            WHERE account_id = :aid
              AND closed_at >= DATE_TRUNC('day', NOW())
        """), {"aid": account_id})
        row = result.first()
    if not row:
        return
    wins = row.wins or 0
    total = row.total or 0
    await alert_manager.send("daily_summary", "global", {
        "total_trades": total,
        "wins":         wins,
        "losses":       row.losses or 0,
        "net_pnl":      f"{row.net_pnl or 0:.4f}",
        "fees":         f"{row.fees or 0:.4f}",
        "win_rate":     f"{wins/total*100:.1f}" if total else "0",
    })


def _fmt_duration(seconds: int | None) -> str:
    if not seconds:
        return "unknown"
    h, m = divmod(seconds, 3600)
    m, s = divmod(m, 60)
    return f"{h}h {m}m" if h else f"{m}m {s}s"
```
