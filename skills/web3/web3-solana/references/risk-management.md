# Risk Management

Position sizing, stop loss, take profit, max exposure, and circuit breakers for Solana DEX trading.

## Position Sizing

Size from wallet balance and risk parameters — never from a fixed notional.

```python
from decimal import Decimal

# Hard ceiling — code constant, not just config
MAX_POSITION_USDC = Decimal("500")
MAX_WALLET_PCT = Decimal("0.10")   # max 10% of wallet per trade

def calculate_position_size(
    wallet_usdc: Decimal,
    confidence: Decimal,       # 0.0 to 1.0 from Strategy
    base_size_usdc: Decimal,   # from config.risk.base_position_usdc
) -> Decimal:
    # scale size by confidence
    sized = base_size_usdc * confidence

    # cap by wallet percentage
    wallet_cap = wallet_usdc * MAX_WALLET_PCT

    # cap by absolute maximum (code constant — config cannot override this)
    result = min(sized, wallet_cap, MAX_POSITION_USDC)

    if result != sized:
        logger.debug(f"position size capped: {sized:.2f} → {result:.2f}")

    return result.quantize(Decimal("0.01"))
```

Default `base_position_usdc` = 50 USDC. Adjust in `config.risk`.

## Stop Loss

Stop loss is calculated at entry and stored immediately in position state.

```python
def calculate_stop_loss_price(entry_price: Decimal, stop_loss_pct: Decimal) -> Decimal:
    """stop_loss_pct e.g. Decimal('0.15') for 15% below entry."""
    return entry_price * (1 - stop_loss_pct)

def calculate_take_profit_price(entry_price: Decimal, take_profit_pct: Decimal) -> Decimal:
    """take_profit_pct e.g. Decimal('0.30') for 30% above entry."""
    return entry_price * (1 + take_profit_pct)
```

Default thresholds (adjust via `config.risk`):
```json
{
  "stop_loss_pct": 0.15,
  "take_profit_pct": 0.50,
  "trailing_stop": false
}
```

Stop loss and take profit are stored in position state at entry:
```python
# stored in state.position.{mint}
{
  "mint": "...",
  "entry_price": "0.00001233",
  "stop_loss_price": "0.00001048",   # entry * (1 - 0.15)
  "take_profit_price": "0.00001850", # entry * (1 + 0.50)
  "amount_tokens": "4056000",
  "entry_ts": 1718000000000
}
```

## Position Monitor Loop

Strategy runs a background loop to check open positions against SL/TP.

```python
async def monitor_positions(redis, strategy_config):
    while True:
        mints = await redis.smembers("state.bot.tokens")
        for mint in mints:
            pos_json = await redis.get(f"state.position.{mint}")
            if not pos_json:
                continue
            pos = json.loads(pos_json)

            current_price = Decimal(await redis.get(f"state.price.{mint}") or "0")
            if current_price == 0:
                continue

            entry = Decimal(pos["entry_price"])
            sl = Decimal(pos["stop_loss_price"])
            tp = Decimal(pos["take_profit_price"])

            if current_price <= sl:
                await publish_exit_signal(mint, "stop_loss", redis)
            elif current_price >= tp:
                await publish_exit_signal(mint, "take_profit", redis)

        await asyncio.sleep(5)  # check every 5 seconds
```

## Max Concurrent Positions

Limit total exposure across all tokens:

```python
MAX_CONCURRENT_POSITIONS = 5   # code constant

async def can_open_new_position(redis) -> bool:
    position_keys = await redis.keys("state.position.*")
    return len(position_keys) < MAX_CONCURRENT_POSITIONS
```

RiskManager checks this before forwarding any signal to `stream.swaps`.

## Max Daily Loss Circuit Breaker

Stop all trading if daily loss exceeds threshold:

```python
MAX_DAILY_LOSS_USDC = Decimal("200")   # from config.risk

async def check_circuit_breaker(redis) -> bool:
    daily_pnl = Decimal(await redis.get("stats.daily_pnl") or "0")
    if daily_pnl <= -MAX_DAILY_LOSS_USDC:
        logger.critical(f"CIRCUIT BREAKER: daily loss {daily_pnl} USDC exceeded limit")
        await redis.set("state.bot.status", "paused")
        return False
    return True
```

`stats.daily_pnl` is updated by DBWriter after every fill. Reset at midnight UTC via cron command.

## Time-Based Rules

```python
# Don't open new positions within N minutes of a major scheduled event
# (not applicable to Solana like macro calendars, but useful for known
# pump.fun launchpad events or Solana network upgrade windows)

MAX_HOLD_TIME_SECONDS = 3600   # force-close position after 1 hour if no SL/TP hit

async def check_max_hold_time(pos: dict, redis) -> bool:
    age_seconds = time.time() - pos["entry_ts"] / 1000
    if age_seconds > MAX_HOLD_TIME_SECONDS:
        await publish_exit_signal(pos["mint"], "max_hold_time", redis)
        return True
    return False
```

## Config Reference

Full `config.risk` schema:
```json
{
  "base_position_usdc": 50,
  "max_wallet_pct": 0.10,
  "stop_loss_pct": 0.15,
  "take_profit_pct": 0.50,
  "trailing_stop": false,
  "max_concurrent_positions": 5,
  "max_daily_loss_usdc": 200,
  "max_hold_time_seconds": 3600,
  "min_liquidity_usdc": 30000
}
```

Validated by pydantic at startup. Any value outside safe range raises `ValueError` — bot does not start with invalid risk config.
