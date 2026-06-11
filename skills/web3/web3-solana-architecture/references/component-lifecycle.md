# Component Lifecycle

How components are spawned, supervised, and shut down in the bot engine.

## Startup Sequence

```
1. Load config (pydantic, from env + config.json)
2. Load wallet keypair (from encrypted file or env var WALLET_PRIVATE_KEY)
3. Connect Redis (with retry, max 10 attempts)
4. Connect PostgreSQL (with retry, max 10 attempts)
5. Connect Solana RPC primary + fallback (verify with getHealth)
6. Run DB migrations (if any pending)
7. Set state.bot.status = "stopped"
8. Create Redis consumer groups (XGROUP CREATE, use MKSTREAM)
9. Spawn asyncio tasks:
   - CommandListener
   - Monitor
10. Wait for START command via CommandListener
11. On START: spawn Scanner, Strategy, RiskManager, Execution, PositionTracker, DBWriter
12. Set state.bot.status = "running"
```

## Task Supervision

Each component runs as an asyncio task. The engine supervisor:

```python
async def supervise(name: str, coro_fn, restart_on_crash: bool = True):
    while True:
        task = asyncio.create_task(coro_fn(), name=name)
        try:
            await task
        except asyncio.CancelledError:
            break  # intentional shutdown
        except Exception as e:
            logger.error(f"{name} crashed: {e}")
            if not restart_on_crash:
                break
            await asyncio.sleep(5)  # backoff before restart
            logger.info(f"Restarting {name}...")
```

Restart policy per component:

| Component | Restart on crash |
|---|---|
| Scanner | Yes |
| Strategy | Yes |
| RiskManager | Yes |
| Execution | Yes (releases all locks first) |
| PositionTracker | Yes |
| DBWriter | Yes |
| CommandListener | Yes |
| Monitor | Yes |

## Graceful Shutdown (STOP command)

```
1. Set state.bot.status = "paused"  (no new signals processed)
2. Wait for in-flight stream.swaps to drain (max 30s)
3. Cancel Scanner, Strategy tasks
4. Wait for Execution to complete current swap (max 60s)
5. Cancel RiskManager, Execution tasks
6. Flush DBWriter queue (max 30s)
7. Cancel PositionTracker, DBWriter tasks
8. Set state.bot.status = "stopped"
9. Cancel Monitor, CommandListener
10. Close Redis + PostgreSQL connections
11. Exit process
```

## Crash Recovery on Restart

On startup, before transitioning to "running":

1. **Check unacknowledged stream messages** (XPENDING) for all consumer groups
2. **Re-process any pending swap requests** — Execution checks if tx was already sent (by looking up tx signature from DB) before re-submitting
3. **Reconcile positions** — PositionTracker reads all `state.position.*` keys and verifies against on-chain token balances via RPC
4. If discrepancy found: alert Monitor, do NOT auto-correct — wait for operator

## Adding/Removing Tokens at Runtime

Via `stream.commands`:
```json
{"cmd": "ADD_TOKEN", "payload": {"mint": "...", "symbol": "NEWTOKEN"}}
{"cmd": "REMOVE_TOKEN", "payload": {"mint": "..."}}
```

CommandListener handling:
- `ADD_TOKEN`: SADD `state.bot.tokens` mint, Scanner picks up on next poll cycle
- `REMOVE_TOKEN`: SREM `state.bot.tokens` mint, close open position if any (SELL signal), then stop tracking
