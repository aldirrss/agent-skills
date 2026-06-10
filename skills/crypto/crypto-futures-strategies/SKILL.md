---
name: crypto-futures-strategies
description: Strategy playbook for crypto futures/perpetual trading. Use this whenever the user asks about trading strategies, entry/exit rules, signal generation, market regime detection, when to long/short, how to implement trend following, breakout, momentum, S/R bounce, funding rate reversal, or liquidation-based strategies for crypto futures. Trigger even when the user doesn't say "strategy" explicitly but mentions EMA ribbon, VWAP, funding rate, liquidation levels, long/short ratio, CVD, order flow, BOS, CHoCH, support/resistance, or asks "when to enter/exit" a futures position. This skill requires crypto-futures skill — safety rules, order execution, and risk management are defined there and not repeated here.
requires: crypto-futures
---

# Crypto Futures Strategies

Strategy selection is not arbitrary — it must match market conditions. A trend strategy in a ranging market bleeds slowly. A mean reversion play in a strong trend bleeds fast. **Always identify regime first, then select strategy.**

This skill covers the "when and why" of entry. For the "how" of order execution, stop placement, and position sizing, refer to `crypto-futures` skill.

## Step 0: Market Regime Detection

Run this before every strategy decision. It determines which reference file to read.

```python
import pandas_ta as ta
import pandas as pd
from enum import Enum

class Regime(Enum):
    TRENDING_BULL  = "trending_bull"
    TRENDING_BEAR  = "trending_bear"
    RANGING        = "ranging"
    CHOPPY         = "choppy"        # avoid trading
    BREAKOUT       = "breakout"      # transition state

def detect_regime(df: pd.DataFrame, atr_period=14, adx_period=14) -> Regime:
    """
    df must have: open, high, low, close, volume columns.
    Uses ADX for trend strength, ATR for volatility context.
    """
    adx  = ta.adx(df["high"], df["low"], df["close"], length=adx_period)
    adx_val  = adx[f"ADX_{adx_period}"].iloc[-1]
    dmp      = adx[f"DMP_{adx_period}"].iloc[-1]   # +DI
    dmn      = adx[f"DMN_{adx_period}"].iloc[-1]   # -DI

    atr      = ta.atr(df["high"], df["low"], df["close"], length=atr_period).iloc[-1]
    atr_pct  = atr / df["close"].iloc[-1]

    if adx_val > 25 and dmp > dmn:
        return Regime.TRENDING_BULL
    if adx_val > 25 and dmn > dmp:
        return Regime.TRENDING_BEAR
    if adx_val < 20 and atr_pct < 0.015:
        return Regime.RANGING
    if adx_val < 15:
        return Regime.CHOPPY
    return Regime.BREAKOUT
```

## Strategy Routing Table

| Regime | Valid Strategies | Avoid |
|---|---|---|
| TRENDING_BULL | Trend Following, Momentum Continuation | Mean Reversion, S/R short |
| TRENDING_BEAR | Trend Following (short), Momentum Continuation | Mean Reversion, S/R long |
| RANGING | S/R Bounce, Funding Rate Reversal, Liquidation Levels | Breakout (fake), Trend |
| BREAKOUT | Breakout, Momentum Continuation | S/R Bounce (levels break) |
| CHOPPY | **Do not trade** — wait for regime clarity | Everything |

## Multi-Timeframe (MTF) Framework

All strategies use this framework. HTF sets the bias; LTF finds the entry.

```
HTF (4h / 1D)  → Market structure, trend direction, major S/R
  ↓ bias
MTF (1h)       → Entry zone confirmation, structure context
  ↓ refine
LTF (5m / 15m) → Precise entry trigger, stop placement
```

**Rule:** Never trade LTF signals that conflict with HTF bias. A 5m long setup in a 4h downtrend is a counter-trend gamble, not a strategy.

```python
def htf_bias(ex, symbol, htf="4h", n=100) -> str:
    """Returns 'bull', 'bear', or 'neutral'."""
    df = fetch_ohlcv_df(ex, symbol, htf, n)        # from data-pipeline.md
    ema50 = ta.ema(df["close"], length=50)
    ema200 = ta.ema(df["close"], length=200)
    price = df["close"].iloc[-1]
    if price > ema50.iloc[-1] > ema200.iloc[-1]:
        return "bull"
    if price < ema50.iloc[-1] < ema200.iloc[-1]:
        return "bear"
    return "neutral"
```

## Confluence Scoring

Before executing any entry, score the confluence. More confirmation = higher conviction = justified position size. Fewer = smaller size or skip.

```python
def confluence_score(signals: dict[str, bool]) -> int:
    """
    signals: dict of signal_name → True/False
    Returns score 0–N. Trade only if score >= threshold.
    """
    return sum(signals.values())

# Example usage
signals = {
    "htf_bias_aligned":    True,   # HTF trend matches trade direction
    "mtf_structure":       True,   # MTF confirms entry zone
    "ltf_trigger":         False,  # LTF entry candle not yet formed
    "volume_confirms":     True,   # Volume expanding on signal bar
    "funding_aligned":     False,  # Funding rate not supporting direction
}
score = confluence_score(signals)  # → 3
# Threshold: >= 3 → trade with normal size, >= 4 → full size, < 3 → skip
```

## Shared Signal Filters

Apply these across all strategies before entry:

```python
def pre_entry_filters(ex, symbol, side: str, df: pd.DataFrame) -> tuple[bool, list[str]]:
    """Returns (ok_to_trade, list_of_failed_filters)."""
    failed = []

    # 1. Avoid trading within 15min of funding timestamp (8h cycle)
    import time
    ts_now = int(time.time())
    next_funding_in = 28800 - (ts_now % 28800)   # seconds until next funding
    if next_funding_in < 900 or next_funding_in > 28800 - 900:
        failed.append("near_funding_window")

    # 2. Avoid extreme funding rate (market already overcrowded)
    fr = float(ex.fetch_funding_rate(symbol)["fundingRate"])
    if abs(fr) > 0.001:    # > 0.1% per 8h = crowded trade
        failed.append(f"extreme_funding_{fr:.4f}")

    # 3. Avoid choppy regime
    regime = detect_regime(df)
    if regime == Regime.CHOPPY:
        failed.append("choppy_regime")

    # 4. Long/short ratio as sentiment check (extreme = contrarian warning)
    # Fetch from exchange if available; skip if not
    # if ls_ratio > 3.0 and side == "long": failed.append("ls_ratio_extreme_long")

    return len(failed) == 0, failed
```

## Reference Files

Read the specific file for your chosen strategy. Each file contains signal logic, entry/exit rules, and concrete code patterns.

| Strategy | When valid | Read |
|---|---|---|
| Trend Following | TRENDING_BULL or TRENDING_BEAR | `references/trend.md` |
| Breakout | BREAKOUT regime, range compression | `references/breakout.md` |
| Momentum Continuation | Trending + pullback to key level | `references/momentum.md` |
| S/R Bounce | RANGING, clear horizontal levels | `references/sr-bounce.md` |
| Funding Rate Reversal | RANGING, extreme funding | `references/funding-reversal.md` |
| Liquidation-Based | Any regime with clear liq clusters | `references/liquidation.md` |
| Structure (BOS/CHoCH/OB/FVG) | Any regime — used as filter or standalone | `references/price-structure.md` |

## When NOT to Trade

This is as important as any entry signal.

- Regime is CHOPPY (ADX < 15)
- Major news event in next 30 minutes (FOMC, CPI, etc.)
- Funding timestamp within 15 minutes
- Circuit breaker tripped (from `crypto-futures` risk-management)
- HTF and LTF signals directly conflict with no resolution
- Spread unusually wide (thin liquidity)
