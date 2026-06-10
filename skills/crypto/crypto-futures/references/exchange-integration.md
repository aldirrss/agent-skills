# Exchange Integration

Patterns for connecting to crypto futures exchanges via `ccxt`. Covers credentials, sandbox switching, rate limits, error handling, and the REST-vs-websocket decision.

## Table of contents
- Client setup & sandbox
- Loading market metadata (precision is everything)
- Rate limits & backoff
- Error taxonomy & handling
- REST vs WebSocket

## Client setup & sandbox

Default to testnet. Make `live=True` an explicit, obvious choice.

```python
import ccxt
from decimal import Decimal

def make_exchange(api_key: str, secret: str, *, live: bool = False) -> ccxt.binance:
    ex = ccxt.binance({
        "apiKey": api_key,
        "secret": secret,
        "enableRateLimit": True,          # ccxt throttles for you; keep it on
        "options": {
            "defaultType": "future",      # USDⓈ-M futures, not spot
        },
    })
    if not live:
        ex.set_sandbox_mode(True)         # routes to testnet endpoints
    return ex
```

`defaultType` matters: `"future"` (USDⓈ-M), `"delivery"` (COIN-M), or `"swap"` for perps on some exchanges. Bybit/OKX use slightly different option keys — check `ex.options` and the ccxt docs per exchange. Never hardcode endpoint URLs; let ccxt resolve them so sandbox switching works.

## Loading market metadata (precision is everything)

Before sending any order you need the instrument's tick size, step size, and minimum notional. Load markets once at startup and cache.

```python
ex.load_markets()
market = ex.market("BTC/USDT:USDT")        # ccxt unified symbol for the perp

price_precision = market["precision"]["price"]
amount_precision = market["precision"]["amount"]
min_notional = market["limits"]["cost"]["min"]

# Round using ccxt helpers so the exchange won't reject the order
price_str = ex.price_to_precision("BTC/USDT:USDT", 64231.7)
amount_str = ex.amount_to_precision("BTC/USDT:USDT", 0.0123456)
```

A wrong-precision order is one of the most common rejections. Always round through `price_to_precision` / `amount_to_precision` (they return strings — convert to `Decimal` for your own math, pass the string to the API).

## Rate limits & backoff

`enableRateLimit=True` handles steady-state throttling, but bursts and transient network failures still need retry with exponential backoff. Never retry a *place order* call blindly — a "failed" request may have actually landed. Retry reads freely; for writes, reconcile first.

```python
import time, random

def with_backoff(fn, *, retries=5, base=0.5, max_delay=8.0):
    """Use for READ calls (fetch_*). For order placement, see order-execution.md."""
    for attempt in range(retries):
        try:
            return fn()
        except (ccxt.NetworkError, ccxt.RequestTimeout, ccxt.DDoSProtection) as e:
            if attempt == retries - 1:
                raise
            delay = min(base * (2 ** attempt) + random.uniform(0, 0.3), max_delay)
            time.sleep(delay)
        except ccxt.RateLimitExceeded:
            time.sleep(max_delay)   # back off hard on explicit rate-limit
```

## Error taxonomy & handling

ccxt exceptions tell you whether a retry is safe:

| Exception | Meaning | Safe to retry? |
|---|---|---|
| `NetworkError`, `RequestTimeout` | transient connectivity | Reads: yes. Writes: reconcile first |
| `RateLimitExceeded`, `DDoSProtection` | throttled | Yes, after a long pause |
| `InsufficientFunds` | not enough margin | No — fix sizing/leverage |
| `InvalidOrder` | bad params (precision, min notional) | No — fix the request |
| `ExchangeNotAvailable` | maintenance/outage | Yes, slow retry |
| `AuthenticationError` | bad keys/permissions | No — config problem |

Never write `except Exception: pass` in an order path. A swallowed error here means you don't know your true position.

## REST vs WebSocket

| Need | Use |
|---|---|
| Place/cancel/amend orders | REST (`create_order`, etc.) |
| Account balance / position snapshot at decision time | REST (`fetch_positions`) |
| Streaming price/orderbook for a live strategy | WebSocket (`ccxt.pro` `watch_ohlcv` / `watch_ticker`) |
| Real-time fills/order updates | WebSocket user stream (`watch_orders`) |
| Historical backfill | REST (`fetch_ohlcv` with pagination) |

Rule of thumb: **state-changing actions go over REST; high-frequency reads go over WebSocket.** Don't poll `fetch_ticker` in a tight loop — you'll burn rate limit and lag the market. For real-time price, stream it. See `data-pipeline.md` for candle reconstruction from a stream.

Always reconcile websocket-derived state against a REST snapshot periodically — streams drop messages, and you never want your bot's idea of its position to silently diverge from reality.
