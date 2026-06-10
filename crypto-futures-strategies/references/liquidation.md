# Liquidation-Based Strategy

Valid when: Any regime with identifiable liquidation clusters. Futures-exclusive.
Core insight: Leveraged positions have forced exit levels. Large clusters of stops/liquidations act as magnets — price often moves toward them (stop hunt) then reverses sharply, or accelerates through them in a cascade.

## How liquidation levels work

Every leveraged position has a liquidation price. When price reaches it, the exchange force-closes the position — creating a market order that accelerates the move. But after the liquidation cluster is consumed, the selling/buying pressure suddenly disappears, often causing a sharp reversal.

Two behaviors to trade:
1. **Stop hunt / liquidity grab** → price spikes into a cluster, reverses. Fade the spike.
2. **Liquidation cascade** → cluster breaks, accelerates the move. Ride the cascade.

## Getting liquidation data

Liquidation heatmap data is not available via standard ccxt. Sources:

```python
# Option 1: CoinGlass API (requires API key)
# https://open-api.coinglass.com/public/v2/liquidation_heatmap

# Option 2: Fetch real-time liquidation events (what already happened)
def fetch_recent_liquidations(ex, symbol, limit=100) -> list[dict]:
    """ccxt unified: not all exchanges support this."""
    try:
        liq = ex.fetch_liquidations(symbol, limit=limit)
        return [{"ts": l["timestamp"], "price": l["price"],
                 "qty": l["amount"], "side": l["side"]} for l in liq]
    except ccxt.NotSupported:
        return []   # fetch from alternative source

# Option 3: WebSocket liquidation stream (Binance)
# Stream: wss://fstream.binance.com/ws/!forceOrder@arr
# Real-time liquidation events across all symbols
```

## Estimating liquidation levels from open interest

When heatmap data is unavailable, approximate where liquidations cluster using leverage assumptions:

```python
from decimal import Decimal

def estimate_liq_levels(current_price: Decimal,
                        leverages=[5, 10, 20, 50, 100]) -> dict:
    """
    For isolated margin, liquidation ≈ entry * (1 - 1/leverage) for longs.
    This gives approximate cluster zones below (long liq) and above (short liq).
    """
    long_liq_levels  = {}
    short_liq_levels = {}
    for lev in leverages:
        l = Decimal(str(lev))
        long_liq_levels[lev]  = current_price * (1 - 1/l)   # below current
        short_liq_levels[lev] = current_price * (1 + 1/l)   # above current
    return {"long_liquidations": long_liq_levels,
            "short_liquidations": short_liq_levels}

# Cluster significance: 20x and 50x leverage liquidations are most common
# 10x: wide zone, 50x: narrow but dense, 100x: thin
```

## Strategy 1: Fade the liquidity grab (stop hunt)

Price spikes into a known cluster, liquidations fire, then reverses sharply.

```python
def liquidity_grab_signal(df_recent: pd.DataFrame,
                          known_liq_level: Decimal,
                          tolerance_pct=0.003) -> dict:
    """
    Detect: wick that pierced the liq level but candle body stayed away.
    This = price grabbed the stops but rejected — reversal entry.
    """
    last = df_recent.iloc[-1]
    tol  = known_liq_level * Decimal(str(tolerance_pct))

    wick_touched = (Decimal(str(last["low"]))  <= known_liq_level + tol or
                    Decimal(str(last["high"])) >= known_liq_level - tol)
    body_away    = (Decimal(str(min(last["open"], last["close"]))) > known_liq_level + tol or
                    Decimal(str(max(last["open"], last["close"]))) < known_liq_level - tol)

    if wick_touched and body_away:
        # Determine direction: wick below level = long liq hunted → go long
        grabbed_longs  = Decimal(str(last["low"]))  <= known_liq_level + tol
        grabbed_shorts = Decimal(str(last["high"])) >= known_liq_level - tol
        return {
            "signal":    True,
            "direction": "long" if grabbed_longs else "short",
            "strength":  "strong" if body_away else "weak",
        }
    return {"signal": False}
```

**Entry:** candle that shows the wick + rejection closes → enter on next bar open.
**Stop:** beyond the wick extreme (if price returns there, it wasn't a stop hunt).
**Target:** 1–2% back toward origin of the spike, or nearest VWAP.

## Strategy 2: Ride the liquidation cascade

A large cluster breaks → force-closes chain-react → strong directional move.

```python
def cascade_signal(recent_liquidations: list[dict],
                   window_seconds=300,
                   size_threshold=1_000_000) -> dict:
    """
    If total liquidated notional in the last window exceeds threshold,
    a cascade may be underway — ride the direction.
    """
    import time
    now = int(time.time() * 1000)
    cutoff = now - (window_seconds * 1000)
    recent = [l for l in recent_liquidations if l["ts"] >= cutoff]

    long_liq  = sum(l["qty"] * l["price"] for l in recent if l["side"] == "long")
    short_liq = sum(l["qty"] * l["price"] for l in recent if l["side"] == "short")

    if long_liq > size_threshold:
        return {"signal": True, "direction": "short",   # longs liquidated = price fell
                "liq_volume": long_liq}
    if short_liq > size_threshold:
        return {"signal": True, "direction": "long",
                "liq_volume": short_liq}
    return {"signal": False}
```

**Cascade trading is momentum, not reversal.** Enter in the direction of the cascade, not against it. The cascade has a shelf life — exit before it exhausts (watch for volume dying off).

## Risk notes

- Liquidity grabs can extend further than expected before reversing — stops must be beyond the wick
- Cascades can chain into larger cascades — use trailing stop, not fixed TP
- Heatmap levels are estimates; without real data they're approximate. Treat as zones, not exact prices
- Do not size full position — these are high-volatility setups

## Confluence checklist

```python
liq_confluence = {
    "known_cluster_identified":  True,   # heatmap or calculation shows cluster
    "price_reached_cluster":     True,   # price interacted with the zone
    "wick_rejection_formed":     True,   # (for fade) wick + body away
    "volume_spike_at_level":     True,   # liquidation events = volume
    "liq_stream_confirms":       False,  # real-time liq data available
    "htf_supports_direction":    False,  # HTF bias aligns with trade
}
# Minimum 3/6. known_cluster_identified + price_reached_cluster are required.
# Without real liquidation data, treat all signals as lower conviction.
```
