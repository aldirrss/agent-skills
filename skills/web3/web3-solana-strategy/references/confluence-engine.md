# Confluence Engine

Signal buffer, scoring, deduplication, and exit logic shared by all strategies.

## Signal Buffer

Each token has a signal buffer in memory — signals accumulate within the window, then confluence is evaluated.

```python
from dataclasses import dataclass, field
from collections import defaultdict
import time

@dataclass
class SignalEntry:
    source: str
    score: int
    ts: float  # epoch seconds
    raw: dict  # original signal payload

class SignalBuffer:
    def __init__(self):
        # mint → list of SignalEntry
        self._buffer: dict[str, list[SignalEntry]] = defaultdict(list)

    def add(self, mint: str, source: str, score: int, raw: dict):
        self._buffer[mint].append(SignalEntry(
            source=source, score=score,
            ts=time.time(), raw=raw,
        ))

    def get_active(self, mint: str, window_s: int) -> list[SignalEntry]:
        cutoff = time.time() - window_s
        active = [s for s in self._buffer[mint] if s.ts >= cutoff]
        self._buffer[mint] = active   # prune stale
        return active

    def clear(self, mint: str):
        self._buffer.pop(mint, None)

    def total_score(self, mint: str, window_s: int) -> int:
        return sum(s.score for s in self.get_active(mint, window_s))

    def has_source(self, mint: str, source: str, window_s: int) -> bool:
        return any(s.source == source for s in self.get_active(mint, window_s))
```

## Confluence Evaluator

```python
from decimal import Decimal

SIGNAL_WEIGHTS = {
    "kol_wallet":          40,
    "smart_money_multi":   35,
    "pumpfun_graduation":  30,
    "gmgn_trending":       25,
    "birdeye_trending":    20,
    "dexscreener_volume":  20,
    "pumpfun_new":         15,
    "twitter_spike":       15,
    "telegram_alpha":      10,
}

async def evaluate_confluence(
    mint: str,
    symbol: str,
    buffer: SignalBuffer,
    strategy_name: str,
    anchor_source: str,
    window_s: int,
    min_score: int,
    redis,
) -> bool:
    # 1. anchor signal must be present
    if not buffer.has_source(mint, anchor_source, window_s):
        return False

    # 2. score must meet threshold
    score = buffer.total_score(mint, window_s)
    if score < min_score:
        return False

    # 3. no open position already
    if await redis.get(f"state.position.{mint}"):
        return False

    # 4. bot must be running
    status = await redis.get("state.bot.status")
    if status and status.decode() != "running":
        return False

    # 5. max concurrent positions check
    positions = await redis.keys("state.position.*")
    max_pos = int(await redis.get("config.risk.max_concurrent_positions") or 5)
    if len(positions) >= max_pos:
        return False

    return True

async def publish_buy_signal(
    mint: str,
    symbol: str,
    score: int,
    sources: list[str],
    strategy: str,
    price_usdc: str,
    liquidity_usdc: float,
    redis,
):
    import uuid, time, json
    signal = {
        "signal_id": f"sig_{uuid.uuid4().hex[:8]}",
        "mint": mint,
        "symbol": symbol,
        "action": "BUY",
        "strategy": strategy,
        "confidence": min(score / 100, 1.0),
        "sources": sources,
        "price_usdc": price_usdc,
        "liquidity_usdc": str(liquidity_usdc),
        "ts": int(time.time() * 1000),
    }
    await redis.xadd("stream.signals", {k: str(v) for k, v in signal.items()})
    await redis.set(f"strategy.last_signal.{mint}", json.dumps(signal), ex=3600)
```

## Exit Logic

Called by position monitor every 5s for each open position.

```python
async def _check_exit_conditions(mint: str, position: dict, current_price: Decimal, redis):
    entry = Decimal(position["entry_price"])
    sl = Decimal(position["stop_loss_price"])
    tp = Decimal(position["take_profit_price"])
    entry_ts = int(position.get("entry_ts", 0))
    max_hold_s = int(await redis.get("config.risk.max_hold_time_seconds") or 3600)

    reason = None
    if current_price <= sl:
        reason = "stop_loss"
    elif current_price >= tp:
        reason = "take_profit"
    elif (time.time() * 1000 - entry_ts) / 1000 > max_hold_s:
        reason = "max_hold_time"

    if reason:
        await _publish_sell_signal(mint, position, reason, current_price, redis)

async def _publish_sell_signal(mint, position, reason, current_price, redis):
    import uuid, time
    signal = {
        "signal_id": f"sig_{uuid.uuid4().hex[:8]}",
        "mint": mint,
        "symbol": position.get("symbol", "UNKNOWN"),
        "action": "SELL",
        "strategy": "exit",
        "reason": reason,
        "entry_price": position["entry_price"],
        "current_price": str(current_price),
        "ts": int(time.time() * 1000),
    }
    await redis.xadd("stream.signals", {k: str(v) for k, v in signal.items()})
```

## Price Feed

Strategy needs current token price for SL/TP monitoring. Update `state.price.{mint}` from DEXScreener on every Scanner poll cycle.

```python
async def update_price_cache(redis, session, tracked_mints: set[str]):
    for mint in tracked_mints:
        pair = await get_pair_by_mint(session, mint)
        if pair:
            price = pair.get("priceUsd", "0")
            await redis.set(f"state.price.{mint}", price, ex=60)
```

## Deduplication of Signals

Prevent the same strategy from publishing multiple BUY signals for the same token within a cooldown period.

```python
async def is_signal_on_cooldown(redis, strategy: str, mint: str, cooldown_s: int = 1800) -> bool:
    key = f"strategy.cooldown.{strategy}.{mint}"
    exists = await redis.get(key)
    if exists:
        return True
    await redis.set(key, "1", ex=cooldown_s)
    return False
```

30-minute cooldown per strategy per token — prevents re-entering a position too quickly after an exit.
