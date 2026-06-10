# Event Flow

Complete trace of every event from market data arrival to order fill and UI update. Use this when building any component to understand what it receives, what it must produce, and what side effects are expected.

## Table of contents
- Flow 1: Market data → signal
- Flow 2: Signal → order
- Flow 3: Order → fill → state update
- Flow 4: Position close (SL/TP hit)
- Timing budget

## Flow 1: Market data → signal

```
Exchange WebSocket
    │ OHLCV candle (1h closed)
    ▼
DataCollector
    │ publish → market.{symbol}.candle.1h
    │           {"open","high","low","close","vol","ts","closed":true}
    ▼
StrategyWorker (subscribed to channel)
    │ 1. Fetch candle history from exchange (last 200 bars)
    │ 2. Run detect_regime(df)          → Regime enum
    │ 3. If CHOPPY: discard, no signal
    │ 4. Run htf_bias(ex, symbol, "4h") → "bull"|"bear"|"neutral"
    │ 5. Run strategy signal fn         → raw signals dict
    │ 6. Fetch LLM score from Redis     → llm.signal.{symbol} (cached)
    │    If cache miss: fire async LLM call (non-blocking, update cache)
    │    Use neutral score (0.5) while waiting
    │ 7. Run confluence_score(signals)  → int
    │ 8. If score < threshold: discard
    │ 9. xadd → stream.signals
    │           {symbol, direction, strategy, confidence, entry_price, atr, ts}
    ▼
[End of Flow 1]
```

**Max latency budget:** < 500ms from candle publish to signal written. If LLM is slow, use cached value — never await LLM inline.

## Flow 2: Signal → order

```
stream.signals (xreadgroup, consumer group: risk-manager)
    │
    ▼
RiskManager
    │ 1. Check state.bot.status == "running"  → else discard
    │ 2. Check state.position.{symbol}        → if exists, already in position, discard
    │ 3. Check pre_entry_filters()            → funding window, extreme funding, regime
    │    If any filter fails: discard + log reason
    │ 4. Fetch account equity from exchange   → fetch_balance()
    │ 5. Check CircuitBreaker.check(equity)   → if halted: discard
    │ 6. Compute position_size(equity, risk_pct, entry, sl)
    │ 7. Validate leverage via set_leverage() guard
    │ 8. xack stream.signals (ack BEFORE writing order — idempotency)
    │ 9. xadd → stream.orders
    │           {symbol, direction, qty, order_type, sl_price, tp_price,
    │            strategy, signal_id, ts}
    ▼
[End of Flow 2]
```

**Idempotency note:** RiskManager acks the signal before publishing the order. If it crashes between ack and xadd, the signal is lost (not retried). This is intentional — a missed entry is safer than a double entry. Order events (stream.orders onward) are never lost due to consumer group persistence.

## Flow 3: Order → fill → state update

```
stream.orders (xreadgroup, consumer group: order-executor)
    │
    ▼
OrderExecutor
    │ 1. Acquire asyncio.Lock for symbol (one order at a time per symbol)
    │ 2. Round qty and price to instrument precision
    │ 3. create_order(symbol, type, side, qty)  → entry order
    │ 4. _assert_filled(ex, symbol, order)      → verify fill, raise if not
    │ 5. create_order(SL, reduce_only=True)     → stop loss
    │ 6. create_order(TP, reduce_only=True)     → take profit (if configured)
    │ 7. xack stream.orders
    │ 8. xadd → stream.fills
    │           {symbol, order_id, direction, qty_filled, avg_price, fee,
    │            outcome:"filled", sl_order_id, tp_order_id, signal_id, ts}
    │ 9. Release lock
    │
    │ On ANY exception after entry filled but before SL placed:
    │   → emergency_market_close(symbol)
    │   → xadd stream.fills with outcome:"emergency_close"
    │   → Release lock
    ▼
stream.fills (consumer group: fill-processors, 2 consumers)
    │
    ├──▶ PositionTracker
    │       │ 1. Write state.position.{symbol}  (Redis)
    │       │ 2. Publish → position.updates pub/sub
    │       │             {symbol, direction, qty, entry, sl, tp, status:"open"}
    │       │ 3. xack stream.fills (own ack)
    │
    └──▶ DBWriter
            │ 1. INSERT into trades table
            │ 2. INSERT into orders table
            │ 3. If DB unavailable: append to local fallback file, retry later
            │ 4. xack stream.fills (own ack)
    ▼
[End of Flow 3]
```

**Two consumers, independent acks:** PositionTracker and DBWriter each ack independently. If DBWriter crashes, PositionTracker still updates live state. On DBWriter restart, it drains pending fills and writes them to DB.

## Flow 4: Position close (SL/TP hit)

Exchange closes the position via resting SL/TP order. The bot detects this via position reconciliation (not via a fill event — the exchange does not push close events reliably).

```
Reconciliation loop (PositionTracker, runs every 30s)
    │
    ▼
PositionTracker
    │ 1. For each symbol in state.bot.workers:
    │    a. Fetch state.position.{symbol} from Redis
    │    b. If no position in Redis: skip
    │    c. Fetch live positions from exchange: fetch_positions()
    │    d. If exchange shows no position for symbol:
    │       → Position was closed (SL or TP hit)
    │       → Compute realized PnL from entry vs exit price
    │       → Delete state.position.{symbol}
    │       → xadd stream.fills with outcome:"sl_hit"|"tp_hit"|"unknown_close"
    │       → Publish position.updates {symbol, status:"closed", pnl:...}
    │ 2. Sleep 30s, repeat
    ▼
stream.fills (outcome: sl_hit / tp_hit)
    │
    └──▶ DBWriter: UPDATE trades SET exit_price, pnl, closed_at WHERE ...
```

**Why polling, not push?** Exchange WebSocket user streams are unreliable for fill events — they drop messages on reconnect. Polling `fetch_positions` every 30s is the safe pattern. 30s is acceptable because the position is already protected by exchange-native SL/TP orders.

## Timing budget

| Leg | Expected | Max acceptable |
|---|---|---|
| Exchange candle → DataCollector publish | < 50ms | 200ms |
| Candle publish → StrategyWorker signal | < 400ms | 1000ms |
| Signal → RiskManager approval | < 100ms | 300ms |
| Risk approval → OrderExecutor entry | < 200ms | 500ms |
| Entry fill → SL/TP placed | < 500ms | 1000ms |
| Fill → PositionTracker update | < 100ms | 300ms |
| Fill → UI WebSocket push | < 200ms | 500ms |
| **Total: candle close → position open** | **< 1.5s** | **3s** |

LLM signal call is explicitly outside the critical path — it updates the cache async and never contributes to the above timings.
