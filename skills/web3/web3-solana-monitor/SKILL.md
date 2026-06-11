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
| **Discord webhooks** | Optional secondary channel via `DISCORD_WEBHOOK_URL` — strips HTML tags, same queue |
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
stats.daily_pnl                      ← INCRBYFLOAT per closed trade, reset at midnight UTC
stats.daily_trades                   ← INCR per closed trade, reset at midnight UTC
stats.best_trade                     ← JSON {mint, symbol, pnl_usdc}, reset at midnight UTC
stats.worst_trade                    ← JSON {mint, symbol, pnl_usdc}, reset at midnight UTC
stats.report.{YYYY-MM-DD}            ← JSON daily report, TTL 30 days
```

**Stats key lifecycle:** `stats.signals.*`, `stats.wins.*`, `stats.losses.*` have **no TTL** — they accumulate indefinitely as all-time counters. `stats.daily_*` keys reset to zero at midnight UTC as part of the daily report generation cycle. Never use `SET` on stats counters — always `INCR` / `INCRBYFLOAT` to avoid race conditions.

## Alert Templates (Telegram HTML format)

All alerts use `parse_mode="HTML"` — use `<b>` for bold, `<code>` for mono. Call `alerter.enqueue(msg)` — never `await` alert sends directly from the hot path.

### BUY Opened
```python
f"✅ <b>BUY {symbol}</b>\n"
f"Entry: <code>${entry_price:.6f}</code>\n"
f"Size:  <code>${size_usdc:.2f} USDC</code>\n"
f"Strategy: {strategy}\n"
f"Mint: <code>{mint[:8]}…</code>"
```

### SELL Closed
```python
emoji = "🟢" if pnl_usdc >= 0 else "🔴"
f"{emoji} <b>SELL {symbol}</b>\n"
f"PnL:    <code>{pnl_usdc:+.2f} USDC ({pnl_pct:+.1f}%)</code>\n"
f"Reason: {reason_label}\n"
f"Mint: <code>{mint[:8]}…</code>"
# reason_label: "Take Profit" | "Stop Loss" | "Max Hold Time" | "Emergency Stop"
```

### Circuit Breaker Activated
```python
f"💀 <b>CIRCUIT BREAKER ACTIVATED</b>\n"
f"Daily loss: <code>-${abs(daily_loss_usdc):.2f} USDC</code>\n"
f"No new positions until midnight UTC."
```

### Emergency Stop
```python
f"🚨 <b>EMERGENCY STOP TRIGGERED</b>\n"
f"Queued {open_positions} sell order(s).\n"
f"Bot status: STOPPED"
```

### Scanner Task Dead
```python
f"⚠️ <b>Scanner task dead: {task_name}</b>\n"
f"Task not found in asyncio task list.\n"
f"Bot may be missing signals."
```

### Position Age Warning
```python
f"⚠️ <b>Position Age Warning: {symbol}</b>\n"
f"Open for {age_min} min (limit: {max_min} min)\n"
f"Mint: <code>{mint[:8]}…</code>"
```

### Daily Summary
```python
pnl_emoji = "🟢" if total_pnl >= 0 else "🔴"
f"📊 <b>Daily Summary — {date}</b>\n\n"
f"Trades:   {total_trades} ({wins}W / {losses}L)\n"
f"Win Rate: <code>{win_rate:.1f}%</code>\n"
f"Total PnL: {pnl_emoji} <code>{total_pnl:+.2f} USDC</code>\n\n"
f"Best:  {best_symbol} <code>{best_pnl:+.2f} USDC</code>\n"
f"Worst: {worst_symbol} <code>{worst_pnl:+.2f} USDC</code>"
```

## Rate Limiting — Why 3s and How Burst is Handled

Telegram limits bots to **1 message/second to a private chat, 30 messages/second to a group**. The 3s minimum gap is conservative to stay safe on both targets.

**Burst handling:** All sends go through `asyncio.Queue(maxsize=100)`. A background worker drains the queue at one message per 3s. If the queue fills (100 messages), new messages are dropped with a warning log — not blocked. This means an emergency stop that closes 5 positions generates 5 alerts queued and sent 3s apart, not 5 simultaneous API calls.

```
position.updates event → alerter.enqueue(msg)   ← non-blocking, O(1)
                              │
                      asyncio.Queue(maxsize=100)
                              │
                    background worker (1 msg / 3s) → Telegram API
                                                   → Discord webhook (if configured)
```

Discord integration: set `DISCORD_WEBHOOK_URL` in env. The same worker drains both channels. HTML tags are stripped (via regex) before sending to Discord since Discord does not support Telegram parse_mode.

## Architecture Position

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

Monitor never writes to `stream.signals`, `stream.swaps`, or `stream.fills`. It is a read-only observer with one write path: stats keys and heartbeat.

## Scanner Health Check

Each scanner task must be spawned with a predictable name so Monitor can verify it is alive via `asyncio.all_tasks()`:

```python
# Names to register at spawn time (scanner/runner.py):
asyncio.create_task(scanner.run_dexscreener(), name="scanner.dexscreener")
asyncio.create_task(scanner.run_gmgn(),        name="scanner.gmgn")
asyncio.create_task(scanner.run_pumpfun(),     name="scanner.pumpfun")
asyncio.create_task(scanner.run_kol_wallets(), name="scanner.kol_wallets")
```

Monitor checks `asyncio.all_tasks()` every 2 minutes against `EXPECTED_SCANNER_TASKS`. Any missing name triggers an alert. No subprocess calls, no Redis checks — pure asyncio task inspection.

## Quick Self-Check Before Finishing Monitor Code

- [ ] Heartbeat loop runs as its own named asyncio task (`monitor.heartbeat`)
- [ ] Telegram sends go through `asyncio.Queue` — never called directly from position update handler
- [ ] Rate limiter enforces ≥3s between Telegram messages (conservative for both private/group)
- [ ] Burst of alerts (e.g. emergency stop with 5 positions) queued, not dropped — queue size 100
- [ ] Discord strips HTML tags before send
- [ ] Daily reset fires at midnight UTC (not local time) — use `datetime.now(timezone.utc)`
- [ ] Scanner health check uses `asyncio.all_tasks()` by task name — no subprocess calls
- [ ] Position age alert threshold is 75% of `max_hold_time` from Redis `config.risk`
- [ ] `stats.daily_*` keys reset at midnight; `stats.wins.*` / `stats.losses.*` never reset (all-time)
- [ ] Stats counters use `INCR` / `INCRBYFLOAT` — never `SET`
- [ ] Monitor never writes to `stream.signals`, `stream.swaps`, or `stream.fills`
- [ ] All log lines use `logger.bind(component="monitor")`

## Reference Files

| Building... | Read |
|---|---|
| TelegramAlerter class, queue worker, Discord integration, full template implementations | `references/telegram-alerts.md` |
| Heartbeat loop, scanner health loop, position age loop, win rate queries, stats key patterns | `references/health-metrics.md` |
| Daily report generation, PostgreSQL queries, midnight trigger, report JSON structure | `references/daily-report.md` |
