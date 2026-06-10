---
name: crypto-futures-bot-monitoring
description: Alert patterns and observability for crypto futures trading bots. Use this whenever the user asks about monitoring, alerts, Telegram notifications, email alerts, health checks, drawdown alerts, PnL monitoring, circuit breaker notifications, WebSocket connectivity monitoring, or bot crash detection. Trigger even when the user mentions "notify me when", "alert if", "how do I know if the bot crashes", "monitor drawdown", "send Telegram when trade opens", or "why did the bot stop". Requires crypto-futures-bot-architecture for component names and Redis key schema.
requires:
  - crypto-futures-bot-architecture
---

# Crypto Futures Bot Monitoring

Monitoring for a trading bot has one job above all others: **get the right human involved before money is lost, not after**. A CRITICAL alert that fires 30 seconds after a SL placement failure is worth more than a perfect metrics dashboard.

## Alert Severity Levels

| Level | Meaning | Channels | Throttle |
|---|---|---|---|
| `INFO` | Normal lifecycle event — trade opened, closed, bot started | Telegram only | Once per event |
| `WARNING` | Degraded state — still running but needs attention | Telegram + Email | Once per 30 min |
| `CRITICAL` | Money at risk — act immediately | Telegram + Email | Once per 5 min |

## What Triggers Each Level

### CRITICAL — act within minutes
- SL placement failed after entry (unprotected position)
- Bot heartbeat missed > 30s (process dead)
- Circuit breaker tripped
- Liquidation price within 3% of current price
- OrderExecutor consecutive failures ≥ 3
- Exchange API authentication error
- Redis connection lost > 60s

### WARNING — act within the hour
- Daily drawdown > 5% of start-of-day equity
- Peak drawdown > 8%
- Win rate (last 20 trades) < 35%
- Consecutive losses ≥ 5
- Funding rate > 0.1% per 8h on open position
- Worker crashed and restart failed
- DB fallback file > 10 entries
- Fill timeout: order open > 60s without fill

### INFO — no action needed
- Trade opened / closed (entry, SL, outcome, PnL)
- Bot started / stopped
- Worker added / removed
- Circuit breaker reset
- Daily PnL summary (end of day)

## What NOT to Alert
- Every signal generated (too frequent)
- Transient network blips that self-heal < 5s
- LLM service unavailable (degrades gracefully)
- WARNING repeated > once per 30 min (throttle)

## Reference Files

| Building… | Read |
|---|---|
| Full alert conditions, thresholds, message templates | `references/alert-rules.md` |
| AlertManager: dedup, throttle, routing | `references/alert-manager.md` |
| Telegram bot setup, SMTP/SendGrid, formatting | `references/telegram-email.md` |
| Health checker: heartbeat, Redis, DB, WebSocket | `references/health-checker.md` |
| Metrics: equity, drawdown, win rate, funding | `references/metrics-collector.md` |
