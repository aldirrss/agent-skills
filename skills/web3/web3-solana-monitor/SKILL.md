---
name: web3-solana-monitor
description: Monitor component for Solana DEX trading bot — health heartbeat, Telegram/Discord alerts, performance metrics, daily PnL tracking, and operational dashboards. Use this whenever the user is building or debugging the monitoring layer, including: Telegram bot alerts for trades, heartbeat liveness check, daily PnL summary, win rate stats, strategy performance breakdown, scanner health check, position age alerts, or Discord webhook integration. Trigger even when the user mentions one specific area (e.g. "how to send Telegram alert on trade", "bot crashed silently", "how to track win rate per strategy", "daily report", "how to know if scanner is stuck").
requires:
  - web3-solana
  - web3-solana-architecture
---

# Web3 Solana Monitor

The Monitor component is the **observability layer** of the trading bot. It does not modify state, place orders, or participate in signal flow. Its sole responsibilities are: knowing the bot is alive, alerting humans when something significant happens, and keeping accurate performance statistics.

## Monitor Responsibilities

| Responsibility | What it does |
|---|---|
| **Health heartbeat** | Writes `state.bot.heartbeat` every 30s with TTL 60s — if it expires, the bot is dead |
| **Telegram alerts** | Sends formatted trade notifications, warnings, and emergency events to a Telegram chat |
| **Discord webhooks** | Optional secondary alert channel via Discord webhook URL |
| **Win/loss metrics** | Tracks per-strategy signal count, wins, losses, and win rate in Redis |
| **Daily PnL tracking** | Accumulates realized PnL across the day; resets at midnight UTC |
| **Daily summary report** | Generates a full performance recap at midnight, saves to Redis + sends to Telegram |
| **Position age alerts** | Warns if any open position exceeds 75% of `max_hold_time` (default: 45 min of 60 min) |
| **Scanner health check** | Verifies scanner asyncio tasks are alive; alerts if a scanner has silently died |
| **Command handler** | Responds to `DAILY_REPORT` command sent via `stream.commands` |

## What Monitor Subscribes To

```
# Pub/Sub (subscribed, fire-and-forget)
position.updates          ← PositionTracker publishes after every fill or PnL update

# Redis Keys (polled)
state.bot.heartbeat       ← written by Monitor itself; checked externally by watchdog
state.bot.status          ← read to detect emergency stop / pause events
state.position.{mint}     ← scanned periodically to detect aged positions

# Redis Streams (consumed)
stream.commands           ← Monitor listens for cmd=DAILY_REPORT to trigger on-demand report
```

## What Monitor Writes

```
state.bot.heartbeat                   ← epoch seconds, TTL=60s, every 30s
stats.signals.{strategy}             ← INCR per signal evaluated
stats.wins.{strategy}                ← INCR per profitable closed trade
stats.losses.{strategy}              ← INCR per unprofitable closed trade
stats.daily_pnl                      ← accumulated USDC PnL today (float string)
stats.daily_trades                   ← count of closed trades today
stats.best_trade                     ← JSON {mint, symbol, pnl_usdc} best trade today
stats.worst_trade                    ← JSON {mint, symbol, pnl_usdc} worst trade today
stats.report.{YYYY-MM-DD}            ← JSON daily report, TTL 30 days
```

## Architecture Position

The Monitor is a **read-only observer** of the system. It never writes to streams that influence trading decisions. It must not block any other component — all alert sending is async and queued via `asyncio.Queue` to prevent the heartbeat loop from stalling if Telegram is slow.

```
PositionTracker ──► position.updates (pub/sub) ──► Monitor ──► Telegram / Discord
stream.commands ────────────────────────────────► Monitor (DAILY_REPORT cmd)
                                                   │
                                     asyncio tasks │
                                   ┌───────────────┤
                                   │ heartbeat_loop│ (every 30s)
                                   │ age_check_loop│ (every 5 min)
                                   │ scanner_health│ (every 2 min)
                                   │ midnight_reset│ (once/day)
                                   └───────────────┘
```

## Reference Files

| Building... | Read |
|---|---|
| Telegram alert templates, rate limiting, message queue | `references/telegram-alerts.md` |
| Heartbeat loop, scanner health, Redis stats keys, win rate | `references/health-metrics.md` |
| Daily report generation, PostgreSQL queries, midnight trigger | `references/daily-report.md` |

Read the relevant reference file before writing any Monitor code. All patterns here are production-ready and tested against the architecture's Redis schema.

## Quick Self-Check Before Finishing Monitor Code

- [ ] Heartbeat loop runs as its own named asyncio task (`monitor.heartbeat`)
- [ ] Telegram sends go through `asyncio.Queue` — never called directly from position update handler
- [ ] Rate limiter enforces ≥3s between Telegram messages
- [ ] Daily reset fires at midnight UTC (not local time)
- [ ] Scanner health check uses `asyncio.all_tasks()` by task name — no subprocess calls
- [ ] Position age alert threshold is 75% of `max_hold_time` from config (default 45 min)
- [ ] Monitor never writes to `stream.signals`, `stream.swaps`, or `stream.fills`
- [ ] Stats keys use `INCR` / `INCRBYFLOAT` — never `SET` (to avoid race conditions)
- [ ] All log lines use `logger.bind(component="monitor")`
