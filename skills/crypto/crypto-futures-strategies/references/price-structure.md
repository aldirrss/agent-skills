# Price Structure Analysis

BOS, CHoCH, order blocks, fair value gaps, and premium/discount zones.
These are structural context tools — use them to filter entries from other strategies
or as the basis of a dedicated structure-based strategy.

## Table of contents
- Concept overview
- Swing high/low tracking
- BOS (Break of Structure)
- CHoCH (Change of Character)
- Order blocks
- Fair value gaps (FVG)
- Premium/discount zones
- `get_structure_context()` — combined helper
- `_strategy_structure` — standalone strategy function
- Integration with existing strategies

---

## Concept overview

These concepts come from the Smart Money / ICT methodology. The premise:
large participants (institutions) leave footprints in price structure. Identifying
those footprints — where they accumulated, where they left imbalances, where
structure shifted — gives a structural edge on top of indicator-based signals.

```
BOS    → structure continues in current direction (trend confirmation)
CHoCH  → structure shifts (first warning of reversal)
Order Block → price zone where institutional orders were filled (strong S/R)
FVG    → price imbalance (gap) that tends to get filled before continuation
P/D    → premium / discount relative to a range (entry timing within structure)
```

Use these as **additional confluence filters** — they do not replace regime
detection or indicator signals. A BOS without volume is noise. An order block
without price reaction is just a candle. Always combine with other signals.

---

## Swing high/low tracking

Foundation for all structural analysis. Reusable across all functions in this file.

```python
# components/price_structure.py
from __future__ import annotations
import pandas as pd
from dataclasses import dataclass, field


@dataclass
class SwingPoint:
    price: float
    bar_index: int   # position in df
    ts: int          # Unix ms timestamp
    kind: str        # "high" or "low"


def find_swings(df: pd.DataFrame,
                window: int = 5) -> tuple[list[SwingPoint], list[SwingPoint]]:
    """
    Detect swing highs and lows using a pivot algorithm.
    A bar is a swing high if its high is greater than the `window` bars
    on each side. Symmetric for swing lows.

    Returns (swing_highs, swing_lows) — oldest first.
    """
    highs: list[SwingPoint] = []
    lows:  list[SwingPoint] = []

    for i in range(window, len(df) - window):
        h_i = float(df["high"].iloc[i])
        l_i = float(df["low"].iloc[i])
        ts  = int(df["ts"].iloc[i]) if "ts" in df.columns else i

        is_sh = all(
            h_i > float(df["high"].iloc[i - j]) and
            h_i > float(df["high"].iloc[i + j])
            for j in range(1, window + 1)
        )
        is_sl = all(
            l_i < float(df["low"].iloc[i - j]) and
            l_i < float(df["low"].iloc[i + j])
            for j in range(1, window + 1)
        )
        if is_sh:
            highs.append(SwingPoint(h_i, i, ts, "high"))
        if is_sl:
            lows.append(SwingPoint(l_i, i, ts, "low"))

    return highs, lows
```

**Swing window guidance:**
- `window=3` — sensitive, more swings, more noise (good for 5m/15m)
- `window=5` — balanced (good for 1h default)
- `window=8` — smooth, fewer levels, higher significance (good for 4h)

---

## BOS (Break of Structure)

A BOS confirms the **current trend continues**. Price makes a new structural extreme,
breaking the last swing in the direction of the trend.

```
Bullish BOS: close > last swing HIGH  → uptrend structure intact
Bearish BOS: close < last swing LOW   → downtrend structure intact
```

```python
@dataclass
class BosEvent:
    type: str          # "bullish" or "bearish"
    broken_level: float
    bar_index: int
    ts: int


def detect_bos(df: pd.DataFrame,
               swing_highs: list[SwingPoint],
               swing_lows:  list[SwingPoint],
               confirm_close: bool = True) -> BosEvent | None:
    """
    Check if the most recent closed bar constitutes a BOS.

    confirm_close=True  → requires a full candle CLOSE beyond the level (safer)
    confirm_close=False → triggers on wick touch (earlier but more false signals)
    """
    if not swing_highs or not swing_lows:
        return None

    # Only consider swings that formed before the current bar
    last_bar = len(df) - 1
    valid_highs = [s for s in swing_highs if s.bar_index < last_bar]
    valid_lows  = [s for s in swing_lows  if s.bar_index < last_bar]

    if not valid_highs or not valid_lows:
        return None

    last_sh = valid_highs[-1]
    last_sl = valid_lows[-1]

    price_ref = float(df["close"].iloc[-1]) if confirm_close \
                else float(df["high"].iloc[-1])

    if price_ref > last_sh.price:
        return BosEvent("bullish", last_sh.price, last_bar,
                        int(df["ts"].iloc[-1]) if "ts" in df.columns else 0)

    price_ref_dn = float(df["close"].iloc[-1]) if confirm_close \
                   else float(df["low"].iloc[-1])
    if price_ref_dn < last_sl.price:
        return BosEvent("bearish", last_sl.price, last_bar,
                        int(df["ts"].iloc[-1]) if "ts" in df.columns else 0)

    return None
```

**Trading significance:**
- Bullish BOS in an uptrend → buy pullbacks into order blocks / FVGs below
- Bearish BOS in a downtrend → sell rallies into order blocks / FVGs above
- BOS immediately after a CHoCH → high conviction reversal signal (see below)

---

## CHoCH (Change of Character)

A CHoCH is the **first structural break against the established trend**.
It is not an entry signal by itself — it is a warning that the trend may be
reversing. Wait for a BOS in the new direction before trading the reversal.

```
In uptrend:   CHoCH = close < last swing LOW  (structure breaks down for first time)
In downtrend: CHoCH = close > last swing HIGH (structure breaks up for first time)
```

```python
@dataclass
class ChochEvent:
    type: str          # "bullish" (upward shift) or "bearish" (downward shift)
    broken_level: float
    bar_index: int
    ts: int


def detect_choch(df: pd.DataFrame,
                 swing_highs: list[SwingPoint],
                 swing_lows:  list[SwingPoint],
                 current_trend: str) -> ChochEvent | None:
    """
    current_trend: "bull" or "bear" — the prevailing trend before this bar.
    Determined by detect_regime() or EMA50 > EMA200 check.

    CHoCH in a bull trend = price breaks below the most recent swing low
    CHoCH in a bear trend = price breaks above the most recent swing high
    """
    if not swing_highs or not swing_lows:
        return None

    last_bar  = len(df) - 1
    close_now = float(df["close"].iloc[-1])

    if current_trend == "bull":
        valid_lows = [s for s in swing_lows if s.bar_index < last_bar]
        if not valid_lows:
            return None
        last_sl = valid_lows[-1]
        if close_now < last_sl.price:
            return ChochEvent(
                "bearish", last_sl.price, last_bar,
                int(df["ts"].iloc[-1]) if "ts" in df.columns else 0
            )

    elif current_trend == "bear":
        valid_highs = [s for s in swing_highs if s.bar_index < last_bar]
        if not valid_highs:
            return None
        last_sh = valid_highs[-1]
        if close_now > last_sh.price:
            return ChochEvent(
                "bullish", last_sh.price, last_bar,
                int(df["ts"].iloc[-1]) if "ts" in df.columns else 0
            )

    return None
```

**CHoCH vs BOS distinction:**

| Event | Meaning | Action |
|---|---|---|
| BOS bullish | Last swing high broken — uptrend confirmed | Look to buy pullbacks |
| BOS bearish | Last swing low broken — downtrend confirmed | Look to sell rallies |
| CHoCH bearish | First break of uptrend structure | Pause longs, watch for bearish BOS |
| CHoCH bullish | First break of downtrend structure | Pause shorts, watch for bullish BOS |

**Do not short on CHoCH alone.** The trend may resume. Wait for:
`CHoCH → pullback → BOS in new direction → order block retest → entry`

---

## Order blocks

An order block (OB) is the last opposing candle before a significant impulse.
It marks where institutional participants placed orders, and price tends to return
to these zones for re-entry (mitigation).

```
Bullish OB: last BEARISH candle before a bullish impulse of >= 2x ATR
Bearish OB: last BULLISH candle before a bearish impulse of >= 2x ATR
```

```python
@dataclass
class OrderBlock:
    type: str          # "bullish" or "bearish"
    top: float         # high of the OB candle
    bottom: float      # low of the OB candle
    open: float
    close: float
    bar_index: int
    ts: int
    valid: bool = True  # False when price closes through the OB


def find_order_blocks(df: pd.DataFrame,
                      atr_val: float,
                      impulse_min_atr: float = 2.0,
                      lookback: int = 50) -> list[OrderBlock]:
    """
    Scan the last `lookback` bars for order blocks.
    Returns list of OrderBlock (may include invalidated ones — check .valid).

    An OB is invalidated when price closes THROUGH the opposing extreme:
    - Bullish OB invalidated: close < OB low
    - Bearish OB invalidated: close > OB high
    """
    min_impulse = atr_val * impulse_min_atr
    blocks: list[OrderBlock] = []
    current_close = float(df["close"].iloc[-1])

    for i in range(2, min(len(df) - 1, lookback + 2)):
        idx  = len(df) - 1 - i          # absolute index
        o_i  = float(df["open"].iloc[idx])
        h_i  = float(df["high"].iloc[idx])
        l_i  = float(df["low"].iloc[idx])
        c_i  = float(df["close"].iloc[idx])
        ts_i = int(df["ts"].iloc[idx]) if "ts" in df.columns else idx

        is_bearish_candle = c_i < o_i
        is_bullish_candle = c_i > o_i

        # Check the move following this candle
        future_close = float(df["close"].iloc[idx + 1])
        impulse_up   = future_close - c_i
        impulse_dn   = c_i - future_close

        if is_bearish_candle and impulse_up >= min_impulse:
            valid = current_close > l_i   # invalidated if price closes below OB low
            blocks.append(OrderBlock(
                type="bullish", top=h_i, bottom=l_i,
                open=o_i, close=c_i,
                bar_index=idx, ts=ts_i, valid=valid,
            ))

        elif is_bullish_candle and impulse_dn >= min_impulse:
            valid = current_close < h_i   # invalidated if price closes above OB high
            blocks.append(OrderBlock(
                type="bearish", top=h_i, bottom=l_i,
                open=o_i, close=c_i,
                bar_index=idx, ts=ts_i, valid=valid,
            ))

    return blocks


def price_in_order_block(price: float,
                          blocks: list[OrderBlock],
                          kind: str) -> OrderBlock | None:
    """
    Check if current price is inside a valid OB of the given kind.
    Returns the most recent valid match, or None.
    kind: "bullish" (price returned to bullish OB = long entry zone)
          "bearish" (price returned to bearish OB = short entry zone)
    """
    valid_blocks = [b for b in blocks if b.type == kind and b.valid]
    for b in reversed(valid_blocks):   # newest first
        if b.bottom <= price <= b.top:
            return b
    return None
```

**Order block trading rules:**
- Enter only when price **returns** to the OB from the impulse side, not immediately after formation
- Stop: just beyond the OB extreme (low of bullish OB, high of bearish OB) + 0.1× ATR buffer
- OB is mitigated (weakened) once price touches it — first touch is strongest
- Combine with: BOS in same direction, FVG between current price and OB, HTF trend aligned

---

## Fair value gaps (FVG)

An FVG is a 3-candle imbalance where the middle candle moves so fast that it
leaves a gap between candle 1 and candle 3 that price has not yet traded through.

```
Bullish FVG: candle[i-1].high  <  candle[i+1].low   (gap above candle i-1)
Bearish FVG: candle[i-1].low   >  candle[i+1].high  (gap below candle i-1)
```

```python
@dataclass
class FVG:
    type: str      # "bullish" or "bearish"
    top: float     # upper boundary of the gap
    bottom: float  # lower boundary of the gap
    ts: int        # timestamp of the impulse (middle) candle
    bar_index: int
    filled: bool = False


def find_fvgs(df: pd.DataFrame, lookback: int = 30,
              min_gap_pct: float = 0.001) -> list[FVG]:
    """
    Find unfilled fair value gaps in the last `lookback` bars.
    min_gap_pct: minimum gap size as fraction of price (filter noise).

    A FVG is filled when price trades through the entire gap zone.
    """
    fvgs: list[FVG] = []
    current_high  = float(df["high"].iloc[-1])
    current_low   = float(df["low"].iloc[-1])
    current_price = float(df["close"].iloc[-1])

    for i in range(1, min(len(df) - 1, lookback + 1)):
        idx  = len(df) - 1 - i
        if idx < 1 or idx >= len(df) - 1:
            continue

        h_prev  = float(df["high"].iloc[idx - 1])
        l_prev  = float(df["low"].iloc[idx - 1])
        h_next  = float(df["high"].iloc[idx + 1])
        l_next  = float(df["low"].iloc[idx + 1])
        ts_i    = int(df["ts"].iloc[idx]) if "ts" in df.columns else idx

        # Bullish FVG
        if l_next > h_prev:
            gap_size = l_next - h_prev
            if gap_size / h_prev >= min_gap_pct:
                filled = current_low <= h_prev   # price traded down into the gap
                fvgs.append(FVG("bullish", top=l_next, bottom=h_prev,
                                 ts=ts_i, bar_index=idx, filled=filled))

        # Bearish FVG
        if h_next < l_prev:
            gap_size = l_prev - h_next
            if gap_size / l_prev >= min_gap_pct:
                filled = current_high >= l_prev   # price traded up into the gap
                fvgs.append(FVG("bearish", top=l_prev, bottom=h_next,
                                 ts=ts_i, bar_index=idx, filled=filled))

    return fvgs


def price_in_fvg(price: float, fvgs: list[FVG],
                  kind: str) -> FVG | None:
    """
    Check if price is currently inside an unfilled FVG of the given kind.
    Returns most recent match or None.
    """
    for fvg in reversed(fvgs):
        if fvg.type == kind and not fvg.filled:
            if fvg.bottom <= price <= fvg.top:
                return fvg
    return None
```

**FVG trading rules:**
- Bullish FVG below current price = support zone, expect price to fill it then bounce
- Bearish FVG above current price = resistance zone, expect price to fill it then reject
- FVGs are strongest when they form on impulse legs with clear BOS
- First touch of FVG = highest probability; once filled, it's no longer active
- FVG + order block overlap = "OB+FVG confluence zone" — highest conviction entry

---

## Premium/discount zones

Identifies where price sits within a structural range. In SMC methodology:
- **Discount zone** (< 50% of range) = buy zone in uptrend
- **Premium zone** (> 50% of range) = sell zone in downtrend
- **Equilibrium** (near 50%) = wait for more information

```python
from decimal import Decimal

def premium_discount(price: float,
                      range_high: float,
                      range_low: float) -> dict:
    """
    Returns zone classification and the exact levels.

    range_high / range_low: typically the last swing high and swing low
    forming the current structure range.
    """
    if range_high == range_low:
        return {"zone": "undefined", "pct": 0.5, "equilibrium": price}

    pct   = (price - range_low) / (range_high - range_low)
    mid   = (range_high + range_low) / 2.0
    fib79 = range_low + (range_high - range_low) * 0.786   # premium threshold
    fib21 = range_low + (range_high - range_low) * 0.214   # discount threshold

    if pct >= 0.786:
        zone = "deep_premium"
    elif pct >= 0.5:
        zone = "premium"
    elif pct <= 0.214:
        zone = "deep_discount"
    else:
        zone = "discount"

    return {
        "zone":         zone,
        "pct":          round(pct, 4),
        "equilibrium":  round(mid, 4),
        "fib_21":       round(fib21, 4),
        "fib_79":       round(fib79, 4),
    }


# Usage rule:
# Long setup in uptrend → prefer entries when pct < 0.5 (discount)
# Short setup in downtrend → prefer entries when pct > 0.5 (premium)
# "Never buy premium in a range, never sell discount in a range"
```

---

## `get_structure_context()` — combined helper

Single call that returns all structural elements for use in any strategy function.

```python
import pandas_ta as ta


def get_structure_context(df: pd.DataFrame,
                           swing_window: int = 5,
                           ob_lookback:  int = 50,
                           fvg_lookback: int = 30) -> dict:
    """
    Compute all structural elements from the candle DataFrame.
    Returns a context dict that any strategy can use for extra confluence.

    Called once per candle evaluation — all computations are stateless.
    """
    if len(df) < swing_window * 2 + 5:
        return {}

    atr_series = ta.atr(df["high"], df["low"], df["close"], length=14)
    if atr_series.isna().iloc[-1]:
        return {}

    atr_val = float(atr_series.iloc[-1])
    price   = float(df["close"].iloc[-1])

    # Swing points
    swing_highs, swing_lows = find_swings(df, window=swing_window)

    # Current range for premium/discount
    range_high = swing_highs[-1].price if swing_highs else price * 1.02
    range_low  = swing_lows[-1].price  if swing_lows  else price * 0.98
    pd_zone    = premium_discount(price, range_high, range_low)

    # Structure events
    bos   = detect_bos(df, swing_highs, swing_lows)
    choch = None  # caller must pass current_trend for CHoCH

    # Order blocks
    obs            = find_order_blocks(df, atr_val, lookback=ob_lookback)
    bull_ob_active = price_in_order_block(price, obs, "bullish")
    bear_ob_active = price_in_order_block(price, obs, "bearish")

    # FVGs
    fvgs            = find_fvgs(df, lookback=fvg_lookback)
    bull_fvg_active = price_in_fvg(price, fvgs, "bullish")
    bear_fvg_active = price_in_fvg(price, fvgs, "bearish")

    return {
        "price":              price,
        "atr":                atr_val,
        "swing_highs":        swing_highs,
        "swing_lows":         swing_lows,
        "range_high":         range_high,
        "range_low":          range_low,
        "pd_zone":            pd_zone,
        "bos":                bos,
        "order_blocks":       obs,
        "bull_ob_active":     bull_ob_active,
        "bear_ob_active":     bear_ob_active,
        "fvgs":               fvgs,
        "bull_fvg_active":    bull_fvg_active,
        "bear_fvg_active":    bear_fvg_active,
    }
```

---

## `_strategy_structure` — standalone strategy function

Wire this into `strategy_worker.py` as a 7th strategy if desired.

```python
# In components/strategy_worker.py — add to strategies dict:
# "structure": _strategy_structure,

async def _strategy_structure(symbol, config, df, llm, redis,
                                cvd_df, liq_s) -> "dict | None":
    """
    Structure-based entry: BOS confirmation + order block / FVG retest.

    Entry model:
      1. BOS in trade direction (structure confirms continuation)
      2. Price pulls back to bullish OB (long) or bearish OB (short)
         OR price is inside a relevant FVG
      3. Price is in the correct premium/discount zone (discount for long, premium for short)
      4. Volume + LLM as additional confluence
    """
    from components.price_structure import get_structure_context

    if len(df) < 30:
        return None

    ctx = get_structure_context(df, swing_window=config.get("sr_swing_window", 5))
    if not ctx:
        return None

    bos             = ctx["bos"]
    pd_info         = ctx["pd_zone"]
    bull_ob_active  = ctx["bull_ob_active"]
    bear_ob_active  = ctx["bear_ob_active"]
    bull_fvg_active = ctx["bull_fvg_active"]
    bear_fvg_active = ctx["bear_fvg_active"]
    price           = ctx["price"]
    atr_val         = ctx["atr"]

    # Determine trade direction from BOS
    direction = None
    if bos and bos.type == "bullish" and pd_info["pct"] < 0.5:
        direction = "long"    # bullish BOS in discount zone
    elif bos and bos.type == "bearish" and pd_info["pct"] > 0.5:
        direction = "short"   # bearish BOS in premium zone
    if not direction:
        return None

    # At least one retest zone must be active
    in_retest_zone = (direction == "long"  and (bull_ob_active or bull_fvg_active)) or \
                     (direction == "short" and (bear_ob_active or bear_fvg_active))
    if not in_retest_zone:
        return None

    # Volume on current bar vs 20-bar average
    vol_ok = float(df["vol"].iloc[-1]) > float(df["vol"].iloc[-20:].mean())

    import pandas_ta as ta
    rsi_series = ta.rsi(df["close"], length=14)
    rsi_val    = float(rsi_series.iloc[-1]) if not rsi_series.isna().iloc[-1] else 50.0

    # RSI sanity: not over-extended in entry direction
    rsi_ok = (direction == "long"  and rsi_val < 70) or \
             (direction == "short" and rsi_val > 30)

    signals = {
        "bos_confirmed":    True,
        "pd_zone_correct":  True,
        "in_retest_zone":   True,
        "volume_confirms":  vol_ok,
        "rsi_not_extreme":  rsi_ok,
        "ob_retest":        bool(bull_ob_active if direction == "long" else bear_ob_active),
        "fvg_retest":       bool(bull_fvg_active if direction == "long" else bear_fvg_active),
        "llm_aligned":      _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    if score < config.get("confluence_threshold", 4):
        return None

    # Stop: below the OB low (long) or above OB high (short), else 1.5x ATR from entry
    if direction == "long" and bull_ob_active:
        sl = bull_ob_active.bottom - atr_val * 0.2
    elif direction == "short" and bear_ob_active:
        sl = bear_ob_active.top + atr_val * 0.2
    elif direction == "long":
        sl = price - atr_val * 1.5
    else:
        sl = price + atr_val * 1.5

    tp = price + atr_val * 2.5 if direction == "long" else price - atr_val * 2.5

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "sl_price":           str(round(sl, 4)),
        "tp_price":           str(round(tp, 4)),
        "regime":             f"structure_{bos.type}",
        "confluence_score":   str(score),
        "confluence_details": __import__("json").dumps({
            **{k: v for k, v in signals.items()},
            "pd_zone":   pd_info["zone"],
            "pd_pct":    pd_info["pct"],
            "bos_level": round(bos.broken_level, 4),
        }),
        "llm_score":     str(llm["score"]) if llm else "",
        "llm_direction": llm["direction"]  if llm else "",
    }
```

---

## Integration with existing strategies

Add structural confluence **without** switching to the full structure strategy.
Useful for filtering false signals in trend, breakout, and momentum strategies.

```python
# In _strategy_trend, _strategy_breakout, or _strategy_momentum:
# Call get_structure_context() and use it as additional confluence

from components.price_structure import get_structure_context

ctx = get_structure_context(df)

# Extra confluence signals (add to the signals dict):
extra_signals = {
    # Long entry: prefer discount zone + bullish OB or FVG nearby
    "in_discount":      ctx.get("pd_zone", {}).get("pct", 0.5) < 0.5,
    "near_bullish_ob":  ctx.get("bull_ob_active") is not None,
    "near_bullish_fvg": ctx.get("bull_fvg_active") is not None,
    "bos_bullish":      (ctx.get("bos") is not None and
                         ctx["bos"].type == "bullish"),
}
```

**When to use each structural element as a filter:**

| Element | Use as filter for | Condition |
|---|---|---|
| BOS bullish | Trend long / momentum long | `bos.type == "bullish"` |
| BOS bearish | Trend short / momentum short | `bos.type == "bearish"` |
| CHoCH | Exit existing positions | Opposite CHoCH fires |
| Bullish OB | Long entry confirmation | Price inside valid bullish OB |
| Bearish OB | Short entry confirmation | Price inside valid bearish OB |
| Bullish FVG | Target for shorts / entry for longs | Price fills bullish FVG from above |
| Bearish FVG | Target for longs / entry for shorts | Price fills bearish FVG from below |
| Discount zone | Long entry timing | `pd_pct < 0.5` |
| Premium zone | Short entry timing | `pd_pct > 0.5` |

**Files to create:**
- `components/price_structure.py` — paste the dataclasses and detection functions above
- Import in `strategy_worker.py`: `from components.price_structure import get_structure_context`
- No new Redis keys required — all computation is stateless on the candle buffer
