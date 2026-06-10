# Order Execution

The most dangerous code in any trading system. A bug here is a financial loss, not a stack trace. Read `risk-management.md` alongside this — sizing and stops are part of correct execution.

## Table of contents
- Order types & when to use them
- Entry with attached stop loss / take profit
- reduce-only: closing without accidentally reversing
- Order state machine & verification
- Cancel / amend safely
- Slippage estimation

## Order types & when to use them

| Type | Use when | Risk |
|---|---|---|
| Market | You must fill now, accept the price | Slippage, esp. thin books |
| Limit | You want a price or better, can wait | May never fill |
| Stop-Market | Trigger a market exit at a level (stop loss) | Slippage on trigger |
| Stop-Limit | Trigger a limit at a level | May not fill in a fast move — dangerous as a stop loss |

For a **stop loss, prefer Stop-Market**. A Stop-Limit stop can fail to fill exactly when you most need it (a violent move blows past your limit), leaving you with an unprotected losing position.

## Entry with attached stop loss / take profit

The safest pattern: place the protective stop **atomically with or immediately after** entry, and verify it. Many exchanges support attaching TP/SL to the entry order — use that when available.

```python
from decimal import Decimal

def open_long_with_stop(ex, symbol, qty: Decimal, stop_price: Decimal,
                        take_profit: Decimal | None = None):
    qty_s = ex.amount_to_precision(symbol, float(qty))

    # 1) Entry
    entry = ex.create_order(symbol, "market", "buy", qty_s)
    _assert_filled(ex, symbol, entry)        # verify before we depend on the position

    # 2) Protective stop — reduce_only so it can only CLOSE, never reverse
    sl_s = ex.price_to_precision(symbol, float(stop_price))
    ex.create_order(
        symbol, "stop_market", "sell", qty_s,
        params={"stopPrice": sl_s, "reduceOnly": True},
    )

    # 3) Optional take profit, also reduce-only
    if take_profit is not None:
        tp_s = ex.price_to_precision(symbol, float(take_profit))
        ex.create_order(
            symbol, "take_profit_market", "sell", qty_s,
            params={"stopPrice": tp_s, "reduceOnly": True},
        )
    return entry
```

If the SL placement fails after entry filled, you have unprotected exposure — that is an emergency. Either retry the SL aggressively or immediately market-close the position. Never just log and move on.

Param names (`stopPrice`, `reduceOnly`, `closePosition`) vary by exchange. Confirm against `ex.describe()` / ccxt docs for your target. On Binance you can also use `closePosition: True` for a full close that auto-sizes.

## reduce-only: closing without accidentally reversing

Without `reduceOnly`, a close order sized slightly larger than your position (e.g. due to a partial fill you didn't account for) will close the position **and open a new one the other way**. This is a frequent, expensive bug.

```python
# Closing a long position — reduce_only guarantees it can only reduce, never flip
ex.create_order(symbol, "market", "sell", qty_s, params={"reduceOnly": True})
```

## Order state machine & verification

Treat an order as a state machine. Never assume `create_order` returning means the order filled.

```
created → open → partially_filled → filled
                              ↘ canceled / rejected / expired
```

```python
def _assert_filled(ex, symbol, order, *, timeout=10.0, poll=0.5):
    import time
    deadline = time.time() + timeout
    oid = order["id"]
    while time.time() < deadline:
        o = ex.fetch_order(oid, symbol)
        status = o["status"]
        if status == "closed":          # ccxt 'closed' == fully filled
            return o
        if status in ("canceled", "rejected", "expired"):
            raise RuntimeError(f"Order {oid} ended unfilled: {status}")
        time.sleep(poll)
    raise TimeoutError(f"Order {oid} not filled within {timeout}s")
```

For market orders fills are near-instant but still verify. For limit orders, decide upfront: wait, cancel-and-replace, or convert to market after a timeout.

## Cancel / amend safely

Cancelling is also a state change — confirm it. A "cancel" that races a fill can leave you holding a position you thought you avoided.

```python
try:
    ex.cancel_order(oid, symbol)
except ccxt.OrderNotFound:
    # Already filled or already gone — fetch to learn the truth
    o = ex.fetch_order(oid, symbol)
    # handle the case where it actually filled
```

Many exchanges have no true "amend" — cancel then re-create. Between the two there's a window with no resting order; account for it.

## Slippage estimation

Before a market order in size, estimate fill cost against the order book so you don't get surprised in a thin market.

```python
def estimate_fill(ex, symbol, side: str, qty: Decimal) -> Decimal:
    ob = ex.fetch_order_book(symbol, limit=50)
    levels = ob["asks"] if side == "buy" else ob["bids"]
    remaining, cost = qty, Decimal("0")
    for price, available in levels:
        price, available = Decimal(str(price)), Decimal(str(available))
        take = min(remaining, available)
        cost += take * price
        remaining -= take
        if remaining <= 0:
            return cost / qty          # volume-weighted avg fill price
    raise ValueError("Order book too thin to fill requested size")
```

If the VWAP fill price deviates from the top-of-book beyond a tolerance, reconsider: split the order, use a limit, or reduce size.
