# Alert Rules

Complete list of alert conditions, thresholds, severity, and message templates.

## Table of contents
- Alert rule definitions
- CRITICAL conditions
- WARNING conditions
- INFO events
- Message templates

---

## Alert rule definitions

```python
# alerts/rules.py
from dataclasses import dataclass
from enum import Enum

class Severity(str, Enum):
    INFO     = "INFO"
    WARNING  = "WARNING"
    CRITICAL = "CRITICAL"

@dataclass
class AlertRule:
    alert_type: str       # unique key for throttle dedup
    severity:   Severity
    title:      str
    throttle_s: int       # 0=no throttle, 1800=30min, 300=5min

CRITICAL_RULES = [
    AlertRule("sl_placement_failed",  Severity.CRITICAL, "SL Placement FAILED",     300),
    AlertRule("heartbeat_missed",     Severity.CRITICAL, "Bot Engine Dead",          300),
    AlertRule("circuit_breaker_trip", Severity.CRITICAL, "Circuit Breaker Tripped",  300),
    AlertRule("liquidation_warning",  Severity.CRITICAL, "Liquidation Warning",      300),
    AlertRule("executor_consecutive", Severity.CRITICAL, "Order Executor Failing",   300),
    AlertRule("exchange_auth_error",  Severity.CRITICAL, "Exchange Auth Error",      300),
    AlertRule("redis_lost",           Severity.CRITICAL, "Redis Connection Lost",    300),
]

WARNING_RULES = [
    AlertRule("daily_drawdown",         Severity.WARNING, "Daily Drawdown Alert",    1800),
    AlertRule("peak_drawdown",          Severity.WARNING, "Peak Drawdown Alert",     1800),
    AlertRule("win_rate_low",           Severity.WARNING, "Win Rate Degrading",      1800),
    AlertRule("consecutive_losses",     Severity.WARNING, "Consecutive Losses",      1800),
    AlertRule("high_funding_position",  Severity.WARNING, "High Funding on Position",1800),
    AlertRule("worker_restart_failed",  Severity.WARNING, "Worker Restart Failed",   1800),
    AlertRule("db_fallback_growing",    Severity.WARNING, "DB Fallback File Growing",1800),
    AlertRule("fill_timeout",           Severity.WARNING, "Order Fill Timeout",      1800),
]

INFO_RULES = [
    AlertRule("trade_opened",          Severity.INFO, "Trade Opened",        0),
    AlertRule("trade_closed",          Severity.INFO, "Trade Closed",        0),
    AlertRule("bot_started",           Severity.INFO, "Bot Started",         0),
    AlertRule("bot_stopped",           Severity.INFO, "Bot Stopped",         0),
    AlertRule("worker_added",          Severity.INFO, "Worker Added",        0),
    AlertRule("worker_removed",        Severity.INFO, "Worker Removed",      0),
    AlertRule("circuit_breaker_reset", Severity.INFO, "Circuit Breaker Reset",0),
    AlertRule("daily_summary",         Severity.INFO, "Daily Summary",       0),
]
```

---

## CRITICAL conditions

```python
# alerts/conditions_critical.py
import time, json
from decimal import Decimal

async def check_heartbeat(redis) -> dict | None:
    hb = await redis.get("bot.heartbeat")
    if not hb:
        return {"alert_type": "heartbeat_missed", "symbol": "global",
                "detail": "No heartbeat received. Bot engine may be dead."}
    age_ms = int(time.time() * 1000) - int(hb)
    if age_ms > 30_000:
        return {"alert_type": "heartbeat_missed", "symbol": "global",
                "detail": f"Last heartbeat {age_ms/1000:.0f}s ago."}
    return None

async def check_circuit_breaker(redis) -> dict | None:
    status = await redis.get("state.bot.status")
    if status == "halted":
        return {"alert_type": "circuit_breaker_trip", "symbol": "global",
                "detail": "Circuit breaker tripped. Bot halted. Manual review required."}
    return None

async def check_liquidation_warning(redis, symbol: str,
                                     threshold_pct: float = 0.03) -> dict | None:
    pos_raw   = await redis.get(f"state.position.{symbol}")
    price_raw = await redis.get(f"state.price.{symbol}")
    if not pos_raw or not price_raw:
        return None
    pos       = json.loads(pos_raw)
    price     = Decimal(price_raw)
    entry     = Decimal(pos["entry_price"])
    leverage  = Decimal(str(pos.get("leverage", 5)))
    direction = pos["direction"]
    mmr       = Decimal("0.005")
    liq = entry * (1 - 1/leverage + mmr) if direction == "long" \
          else entry * (1 + 1/leverage - mmr)
    dist_pct = abs(price - liq) / price
    if dist_pct < Decimal(str(threshold_pct)):
        return {
            "alert_type": "liquidation_warning", "symbol": symbol,
            "detail": f"Price {price} is {float(dist_pct)*100:.2f}% from liq {liq:.2f}",
        }
    return None

# sl_placement_failed is event-driven (called directly by OrderExecutor, not polled)
def make_sl_failed_alert(symbol: str, error: str) -> dict:
    return {
        "alert_type": "sl_placement_failed", "symbol": symbol,
        "detail": f"Entry filled but SL failed: {error}. Position UNPROTECTED.",
    }
```

---

## WARNING conditions

```python
# alerts/conditions_warning.py
from decimal import Decimal
from sqlalchemy import text

async def check_daily_drawdown(session_factory, account_id: int,
                                threshold_pct: float = 0.05) -> dict | None:
    async with session_factory() as session:
        result = await session.exec(text("""
            WITH day_start AS (
                SELECT equity FROM pnl_snapshots
                WHERE account_id = :aid AND snapshot_ts >= DATE_TRUNC('day', NOW())
                ORDER BY snapshot_ts ASC LIMIT 1
            ), current AS (
                SELECT equity FROM pnl_snapshots
                WHERE account_id = :aid
                ORDER BY snapshot_ts DESC LIMIT 1
            )
            SELECT d.equity AS start_eq, c.equity AS curr_eq FROM day_start d, current c
        """), {"aid": account_id})
        row = result.first()
    if not row or not row.start_eq or row.start_eq == 0:
        return None
    dd = (Decimal(str(row.start_eq)) - Decimal(str(row.curr_eq))) / Decimal(str(row.start_eq))
    if dd >= Decimal(str(threshold_pct)):
        return {"alert_type": "daily_drawdown", "symbol": "global",
                "detail": f"Daily DD {float(dd)*100:.2f}% — start:{row.start_eq:.2f} now:{row.curr_eq:.2f}"}
    return None

async def check_consecutive_losses(session_factory, account_id: int,
                                    threshold: int = 5) -> dict | None:
    from sqlmodel import select
    from db.models.trade import Trade
    async with session_factory() as session:
        result = await session.exec(
            select(Trade)
            .where(Trade.account_id == account_id, Trade.closed_at.is_not(None))
            .order_by(Trade.closed_at.desc()).limit(threshold)
        )
        recent = result.all()
    if len(recent) < threshold or not all(t.net_pnl < 0 for t in recent):
        return None
    total = sum(t.net_pnl for t in recent)
    return {"alert_type": "consecutive_losses", "symbol": "global",
            "detail": f"{threshold} consecutive losses. Total: {total:.4f} USDT"}

async def check_win_rate(session_factory, account_id: int,
                          lookback: int = 20, threshold: float = 0.35) -> dict | None:
    async with session_factory() as session:
        result = await session.exec(text("""
            SELECT COUNT(*) AS total,
                   SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins
            FROM (SELECT net_pnl FROM trades
                  WHERE account_id = :aid AND closed_at IS NOT NULL
                  ORDER BY closed_at DESC LIMIT :n) sub
        """), {"aid": account_id, "n": lookback})
        row = result.first()
    if not row or not row.total or row.total < lookback:
        return None
    win_rate = row.wins / row.total
    if win_rate < threshold:
        return {"alert_type": "win_rate_low", "symbol": "global",
                "detail": f"Win rate last {lookback} trades: {win_rate*100:.1f}% (threshold: {threshold*100:.0f}%)"}
    return None

async def check_fill_timeout(redis, symbol: str, timeout_s: int = 60) -> dict | None:
    import time, json
    pending_raw = await redis.get(f"state.order.pending.{symbol}")
    if not pending_raw:
        return None
    pending = json.loads(pending_raw)
    age = int(time.time()) - int(pending.get("placed_at", 0))
    if age > timeout_s:
        return {"alert_type": "fill_timeout", "symbol": symbol,
                "detail": f"Order {pending.get('order_id')} open for {age}s without fill"}
    return None
```

---

## Message templates

```python
# alerts/templates.py

TEMPLATES = {
    "sl_placement_failed": lambda d: (
        f"🚨 *SL PLACEMENT FAILED*\n"
        f"Symbol: `{d['symbol']}`\n"
        f"Position is UNPROTECTED ‼️\n"
        f"{d['detail']}\n"
        f"→ Manual close or SL required immediately"
    ),
    "heartbeat_missed": lambda d: (
        f"🚨 *BOT ENGINE UNRESPONSIVE*\n"
        f"{d['detail']}\n→ Check VPS, restart bot engine"
    ),
    "circuit_breaker_trip": lambda d: (
        f"🚨 *CIRCUIT BREAKER TRIPPED*\n"
        f"{d['detail']}\n→ Review trades, reset manually when ready"
    ),
    "liquidation_warning": lambda d: (
        f"🚨 *LIQUIDATION WARNING*\n"
        f"Symbol: `{d['symbol']}`\n"
        f"{d['detail']}\n→ Consider manual close or add margin"
    ),
    "daily_drawdown": lambda d: (
        f"⚠️ *Daily Drawdown Alert*\n{d['detail']}"
    ),
    "consecutive_losses": lambda d: (
        f"⚠️ *Consecutive Losses*\n{d['detail']}\n→ Review strategy"
    ),
    "win_rate_low": lambda d: (
        f"⚠️ *Win Rate Degrading*\n{d['detail']}\n→ Review strategy parameters"
    ),
    "fill_timeout": lambda d: (
        f"⚠️ *Fill Timeout*\nSymbol: `{d['symbol']}`\n{d['detail']}"
    ),
    "trade_opened": lambda d: (
        f"📈 *Trade Opened*\n"
        f"`{d['symbol']}` {d.get('direction','').upper()}\n"
        f"Entry: `{d.get('entry_price')}` SL: `{d.get('sl_price')}`\n"
        f"Strategy: {d.get('strategy')} | {d.get('leverage')}x"
    ),
    "trade_closed": lambda d: (
        f"📊 *Trade Closed* — {d.get('outcome','').upper()}\n"
        f"`{d['symbol']}` PnL: `{d.get('net_pnl')} USDT` ({d.get('r_multiple')}R)\n"
        f"Duration: {d.get('duration')}"
    ),
    "daily_summary": lambda d: (
        f"📋 *Daily Summary*\n"
        f"Trades: {d.get('total_trades')} ({d.get('wins')}W/{d.get('losses')}L)\n"
        f"Net PnL: `{d.get('net_pnl')} USDT`\n"
        f"Win Rate: {d.get('win_rate')}% | Fees: {d.get('fees')} USDT"
    ),
    "bot_started": lambda d: f"🟢 *Bot Started*\nAcct: {d.get('account')}",
    "bot_stopped":  lambda d: f"🔴 *Bot Stopped*\nReason: {d.get('reason')}",
}

def format_message(alert_type: str, data: dict) -> str:
    fn = TEMPLATES.get(alert_type)
    return fn(data) if fn else f"Alert: {alert_type}\n{data.get('detail','')}"
```
