# StrategyWorker

Signal evaluation loop, strategy routing, config hot-reload from Redis, and signal publishing.

## Table of contents
- Implementation
- Strategy router
- Strategy: trend
- Strategy: breakout
- Strategy: momentum (requires CVD)
- Strategy: sr\_bounce
- Strategy: funding\_reversal
- Strategy: liquidation (requires liquidation data)
- CVD and liquidation helpers
- Funding rate helpers
- Config hot-reload
- Helpers

---

## Implementation

```python
# components/strategy_worker.py
import asyncio
import json
import time
from decimal import Decimal

import ccxt.async_support as ccxt_async
import redis.asyncio as aioredis
import pandas as pd
import pandas_ta as ta
from loguru import logger

from config import settings
from logger_setup import component_logger


async def run_strategy_worker(symbol: str, initial_config: dict,
                               redis, stop_event: asyncio.Event) -> None:
    """
    One StrategyWorker per symbol. Subscribes to candle pub/sub,
    evaluates signals, publishes to stream.signals.

    Config is re-read from Redis on every candle — hot-reload is free.
    """
    log = component_logger("strategy_worker", symbol)
    log.info("Starting", strategy=initial_config.get("strategy"))

    r_sub = await aioredis.from_url(
        settings.redis_url, encoding="utf-8", decode_responses=True
    )
    candle_buffer: list[dict] = await _fetch_initial_candles(symbol, redis, log)

    try:
        async with r_sub.pubsub() as ps:
            timeframes = initial_config.get("timeframes", ["1h", "15m"])
            channels   = [f"market.{symbol}.candle.{tf}" for tf in timeframes]
            await ps.subscribe(*channels)
            log.info("Subscribed to candle channels", channels=channels)

            async for msg in ps.listen():
                if stop_event.is_set():
                    break
                if msg["type"] != "message":
                    continue

                candle = _parse_candle(msg["data"])
                if not candle.get("closed"):
                    continue

                config = await _load_config(redis, symbol, initial_config)

                status = await redis.get("state.bot.status")
                if status != "running":
                    continue

                candle_buffer = _update_buffer(candle_buffer, candle, maxlen=500)

                if candle["tf"] != config.get("timeframe", "1h"):
                    continue

                await _evaluate_and_publish(
                    symbol, config, candle_buffer, candle, redis, log
                )
    finally:
        await r_sub.aclose()
        log.info("Stopped")


async def _evaluate_and_publish(symbol: str, config: dict,
                                  buffer: list[dict], latest: dict,
                                  redis, log) -> None:
    """Evaluate strategy and publish signal if criteria met."""
    try:
        df  = _buffer_to_df(buffer)
        tf  = config.get("timeframe", "1h")

        # Fetch extended data — degrade gracefully on miss
        cvd_df = await get_cvd_series(redis, symbol, tf)
        liq_s  = await get_liquidation_summary(redis, symbol)

        signal = await _route_strategy(symbol, config, df, latest,
                                        redis, cvd_df, liq_s)
        if signal is None:
            return

        signal.update({
            "symbol":    symbol,
            "strategy":  config["strategy"],
            "signal_ts": str(int(time.time() * 1000)),
        })
        await redis.xadd("stream.signals", signal, maxlen=100_000, approximate=True)
        log.info("Signal published",
                 direction=signal["direction"],
                 confidence=signal["confidence"],
                 regime=signal.get("regime", "?"))

    except Exception:
        log.exception("Error evaluating strategy")
```

---

## Strategy router

```python
async def _route_strategy(symbol: str, config: dict, df: pd.DataFrame,
                           latest: dict, redis,
                           cvd_df: "pd.DataFrame | None",
                           liq_s:  dict) -> "dict | None":
    """
    Route to the correct strategy function based on config["strategy"].
    Returns signal dict or None.

    All strategy functions must return None or a dict with:
      {direction, confidence, entry_price, atr, regime,
       confluence_score, confluence_details (JSON str),
       llm_score (opt), llm_direction (opt)}
    """
    strategy = config.get("strategy", "trend")
    llm      = await _get_llm_signal(redis, symbol)

    strategies = {
        "trend":       _strategy_trend,
        "breakout":    _strategy_breakout,
        "momentum":    _strategy_momentum,
        "sr_bounce":   _strategy_sr_bounce,
        "funding":     _strategy_funding_reversal,
        "liquidation": _strategy_liquidation,
    }
    fn = strategies.get(strategy)
    if not fn:
        raise ValueError(f"Unknown strategy: {strategy}")

    return await fn(symbol, config, df, llm, redis, cvd_df, liq_s)
```

---

## Strategy: trend

```python
async def _strategy_trend(symbol, config, df, llm, redis,
                            cvd_df, liq_s) -> "dict | None":
    """
    Trend following — EMA ribbon 9/21/50, pullback zone entry.
    See crypto-futures-strategies/references/trend.md.
    """
    close = df["close"]

    ema9  = ta.ema(close, length=9)
    ema21 = ta.ema(close, length=21)
    ema50 = ta.ema(close, length=50)
    atr   = ta.atr(df["high"], df["low"], close, length=14)
    rsi   = ta.rsi(close, length=14)

    if ema9.isna().iloc[-1] or atr.isna().iloc[-1]:
        return None

    e9  = float(ema9.iloc[-1])
    e21 = float(ema21.iloc[-1])
    e50 = float(ema50.iloc[-1])
    price = float(close.iloc[-1])

    ribbon_bull = e9 > e21 > e50
    ribbon_bear = e9 < e21 < e50

    in_bull_zone = ribbon_bull and (e21 <= price <= e9 * 1.005)
    in_bear_zone = ribbon_bear and (e21 >= price >= e9 * 0.995)

    rsi_val = float(rsi.iloc[-1])
    vol_ok  = float(df["vol"].iloc[-1]) > float(df["vol"].rolling(20).mean().iloc[-1])

    direction = None
    if in_bull_zone and 40 < rsi_val < 70:  direction = "long"
    if in_bear_zone and 30 < rsi_val < 60:  direction = "short"
    if not direction: return None

    signals = {
        "ribbon_aligned":    ribbon_bull if direction == "long" else ribbon_bear,
        "in_pullback_zone":  in_bull_zone if direction == "long" else in_bear_zone,
        "rsi_not_extreme":   True,
        "volume_confirms":   vol_ok,
        "llm_aligned":       _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    if score < config.get("confluence_threshold", 3):
        return None

    atr_val = float(atr.iloc[-1])
    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "regime":             "trending_bull" if direction == "long" else "trending_bear",
        "confluence_score":   str(score),
        "confluence_details": json.dumps(signals),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }
```

---

## Strategy: breakout

```python
async def _strategy_breakout(symbol, config, df, llm, redis,
                               cvd_df, liq_s) -> "dict | None":
    """
    Compression breakout — ATR contraction, range boundary break, retest entry.
    See crypto-futures-strategies/references/breakout.md.

    Entry logic:
      1. ATR compressed < 60% of 20-bar average (energy coiling)
      2. Price broke out of range with volume (N confirmed closed bars beyond level)
      3. Prefer retest_hold entry (price returns to broken level and holds)
      4. Volume on breakout bar >= 1.5x 20-bar average
    """
    if len(df) < 30:
        return None

    atr_series = ta.atr(df["high"], df["low"], df["close"], length=14)
    if atr_series.isna().iloc[-1]:
        return None

    atr_now = float(atr_series.iloc[-1])
    atr_avg = float(atr_series.iloc[-20:].mean())

    # Must have compression in the recent window
    compressed = (atr_now / atr_avg) < config.get("compression_threshold", 0.6)
    if not compressed:
        return None

    # Range boundaries from the compression zone (lookback 20 bars)
    lookback = 20
    recent = df.iloc[-(lookback + 4):-4]   # exclude last 4 bars (confirmation bars)
    range_high = float(recent["high"].max())
    range_low  = float(recent["low"].min())
    price = float(df["close"].iloc[-1])

    # Determine breakout direction from last 2 closed bars beyond level
    confirm_bars = config.get("breakout_confirm_bars", 2)
    closed_above = all(
        float(df["close"].iloc[-(i + 1)]) > range_high
        for i in range(confirm_bars)
    )
    closed_below = all(
        float(df["close"].iloc[-(i + 1)]) < range_low
        for i in range(confirm_bars)
    )

    if closed_above:
        direction     = "long"
        broken_level  = range_high
    elif closed_below:
        direction     = "short"
        broken_level  = range_low
    else:
        return None  # no confirmed breakout yet

    # Volume check on the breakout bar (bar that first closed beyond level)
    vol_avg     = float(df["vol"].iloc[-21:-1].mean())
    vol_breakout = float(df["vol"].iloc[-(confirm_bars + 1)])
    vol_ok = vol_breakout >= vol_avg * config.get("breakout_volume_mult", 1.5)

    # Entry type: is price retesting the broken level?
    tolerance = broken_level * 0.002   # 0.2% tolerance band
    at_retest = abs(price - broken_level) <= tolerance
    held_long  = direction == "long"  and price > broken_level - tolerance
    held_short = direction == "short" and price < broken_level + tolerance
    retest_hold = at_retest and (held_long or held_short)

    # Range height for measured-move TP reference
    range_height = range_high - range_low

    signals = {
        "compression_detected": True,             # passed the ATR check above
        "volume_on_break":      vol_ok,           # non-negotiable
        "closed_beyond_level":  True,             # passed confirmation above
        "retest_entry":         retest_hold,
        "htf_no_resistance":    True,             # simplified — no HTF check here
        "llm_aligned":          _llm_aligned(llm, direction),
    }
    score = sum(signals.values())

    # volume_on_break is non-negotiable; min 4/6 total
    if not vol_ok:
        return None
    if score < config.get("confluence_threshold", 4):
        return None

    # SL: just inside broken level with ATR buffer
    sl_buffer = atr_now * 0.3
    if direction == "long":
        sl = broken_level - sl_buffer
        tp = broken_level + range_height
    else:
        sl = broken_level + sl_buffer
        tp = broken_level - range_height

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_now, 4)),
        "sl_price":           str(round(sl, 4)),
        "tp_price":           str(round(tp, 4)),
        "regime":             "breakout",
        "confluence_score":   str(score),
        "confluence_details": json.dumps({
            **signals,
            "range_height": round(range_height, 4),
            "entry_type":   "retest_hold" if retest_hold else "extended",
        }),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }
```

---

## Strategy: momentum (requires CVD)

```python
async def _strategy_momentum(symbol, config, df, llm, redis,
                               cvd_df, liq_s) -> "dict | None":
    """
    Momentum continuation — fib pullback + CVD divergence + VWAP reclaim.
    See crypto-futures-strategies/references/momentum.md.
    Returns None if CVD data unavailable.
    """
    if cvd_df is None or len(cvd_df) < 20:
        return None

    close  = df["close"]
    high   = df["high"]
    low    = df["low"]
    volume = df["vol"]

    ema50  = ta.ema(close, length=50)
    ema200 = ta.ema(close, length=200)
    atr    = ta.atr(high, low, close, length=14)
    rsi    = ta.rsi(close, length=14)

    if ema50.isna().iloc[-1] or atr.isna().iloc[-1]:
        return None

    price   = float(close.iloc[-1])
    atr_val = float(atr.iloc[-1])

    trend_bull = float(ema50.iloc[-1]) > float(ema200.iloc[-1])
    trend_bear = float(ema50.iloc[-1]) < float(ema200.iloc[-1])

    # VWAP (rolling session proxy using full buffer)
    tp_s  = (high + low + close) / 3
    vwap  = (tp_s * volume).cumsum() / volume.cumsum()
    prev_c  = float(close.iloc[-2])
    curr_c  = float(close.iloc[-1])
    vwap_p  = float(vwap.iloc[-2])
    vwap_c  = float(vwap.iloc[-1])

    vwap_reclaim_long  = prev_c < vwap_p and curr_c > vwap_c
    vwap_reclaim_short = prev_c > vwap_p and curr_c < vwap_c

    # CVD divergence over last 20 candles
    price_col = pd.Series(df["close"].values[-len(cvd_df):])
    cvd_col   = cvd_df["cvd"].values[-len(price_col):]
    if len(price_col) < 20 or len(cvd_col) < 20:
        return None

    bullish_div = price_col.iloc[-1] < price_col.iloc[-20] and \
                  float(cvd_col[-1]) > float(cvd_col[-20])
    bearish_div = price_col.iloc[-1] > price_col.iloc[-20] and \
                  float(cvd_col[-1]) < float(cvd_col[-20])

    rsi_val = float(rsi.iloc[-1])

    direction = None
    if trend_bull and vwap_reclaim_long  and bullish_div and 40 < rsi_val < 65:
        direction = "long"
    elif trend_bear and vwap_reclaim_short and bearish_div and 35 < rsi_val < 60:
        direction = "short"
    if not direction:
        return None

    signals = {
        "htf_trend_aligned": trend_bull if direction == "long" else trend_bear,
        "vwap_reclaim":      vwap_reclaim_long if direction == "long" else vwap_reclaim_short,
        "cvd_divergence":    bullish_div if direction == "long" else bearish_div,
        "rsi_in_range":      True,
        "llm_aligned":       _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    if score < config.get("confluence_threshold", 3):
        return None

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "regime":             "momentum",
        "confluence_score":   str(score),
        "confluence_details": json.dumps(signals),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }
```

---

## Strategy: sr\_bounce

```python
async def _strategy_sr_bounce(symbol, config, df, llm, redis,
                                cvd_df, liq_s) -> "dict | None":
    """
    Support/resistance bounce — swing-based SR levels, rejection candle entry.
    See crypto-futures-strategies/references/sr-bounce.md.

    Entry logic:
      1. Find swing highs/lows from recent 100 bars
      2. Detect if price is within ATR band of an SR level
      3. Require rejection candle: wick touching level, body closed away
      4. RSI not extreme in wrong direction, volume confirms rejection
    """
    if len(df) < 50:
        return None

    atr_series = ta.atr(df["high"], df["low"], df["close"], length=14)
    rsi_series = ta.rsi(df["close"], length=14)
    if atr_series.isna().iloc[-1]:
        return None

    atr_val = float(atr_series.iloc[-1])
    rsi_val = float(rsi_series.iloc[-1])
    price   = float(df["close"].iloc[-1])

    # Swing detection: local high/low with 5-bar window on each side
    swing_window = config.get("sr_swing_window", 5)
    resistance_levels, support_levels = _find_swing_levels(
        df.iloc[-100:], window=swing_window, n_levels=6
    )

    # Tolerance band for "touching" a level
    tolerance = atr_val * config.get("sr_tolerance_atr", 0.5)

    # Find nearest SR level that price is touching
    nearest_res = min(
        (lvl for lvl in resistance_levels if lvl > price - tolerance),
        default=None,
        key=lambda lvl: abs(lvl - price),
    )
    nearest_sup = min(
        (lvl for lvl in support_levels if lvl < price + tolerance),
        default=None,
        key=lambda lvl: abs(lvl - price),
    )

    touching_res = nearest_res is not None and abs(nearest_res - price) <= tolerance
    touching_sup = nearest_sup is not None and abs(nearest_sup - price) <= tolerance

    if not touching_res and not touching_sup:
        return None

    last    = df.iloc[-1]
    o, h, l, c = float(last["open"]), float(last["high"]), float(last["low"]), float(last["close"])
    body    = abs(c - o)
    up_wick = h - max(o, c)
    dn_wick = min(o, c) - l
    vol_avg = float(df["vol"].iloc[-20:].mean())
    vol_ok  = float(df["vol"].iloc[-1]) > vol_avg

    direction = None

    if touching_res:
        # Resistance bounce → short
        wick_significant = up_wick > atr_val * 0.4 and up_wick > body * 0.5
        body_away        = c < nearest_res - tolerance * 0.5
        if wick_significant and body_away and rsi_val < 80:
            direction = "short"

    if touching_sup and direction is None:
        # Support bounce → long
        wick_significant = dn_wick > atr_val * 0.4 and dn_wick > body * 0.5
        body_away        = c > nearest_sup + tolerance * 0.5
        if wick_significant and body_away and rsi_val > 20:
            direction = "long"

    if not direction:
        return None

    level = nearest_res if direction == "short" else nearest_sup

    signals = {
        "sr_level_touched":   True,
        "rejection_candle":   True,
        "rsi_not_exhausted":  (direction == "short" and rsi_val < 80) or
                              (direction == "long"  and rsi_val > 20),
        "volume_confirms":    vol_ok,
        "llm_aligned":        _llm_aligned(llm, direction),
    }
    score = sum(signals.values())

    # Both structural signals are non-negotiable; min 3/5 total
    if not (signals["sr_level_touched"] and signals["rejection_candle"]):
        return None
    if score < config.get("confluence_threshold", 3):
        return None

    # SL: beyond wick extreme with ATR buffer
    sl_buffer = atr_val * 0.2
    if direction == "short":
        sl = h + sl_buffer
        tp = price - atr_val * 2.0   # 2 ATR target toward opposite side
    else:
        sl = l - sl_buffer
        tp = price + atr_val * 2.0

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "sl_price":           str(round(sl, 4)),
        "tp_price":           str(round(tp, 4)),
        "regime":             "sr_bounce",
        "confluence_score":   str(score),
        "confluence_details": json.dumps({
            **signals,
            "level": round(level, 4),
            "up_wick": round(up_wick, 4),
            "dn_wick": round(dn_wick, 4),
        }),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }


def _find_swing_levels(df: pd.DataFrame,
                        window: int = 5,
                        n_levels: int = 6) -> "tuple[list[float], list[float]]":
    """
    Detect swing highs and swing lows using a simple pivot algorithm.
    Returns (resistance_list, support_list) — each sorted ascending,
    returning up to n_levels most recent levels.
    """
    highs: list[float] = []
    lows:  list[float] = []

    for i in range(window, len(df) - window):
        h_i = float(df["high"].iloc[i])
        l_i = float(df["low"].iloc[i])

        is_swing_high = all(
            h_i > float(df["high"].iloc[i - j]) and
            h_i > float(df["high"].iloc[i + j])
            for j in range(1, window + 1)
        )
        is_swing_low = all(
            l_i < float(df["low"].iloc[i - j]) and
            l_i < float(df["low"].iloc[i + j])
            for j in range(1, window + 1)
        )

        if is_swing_high:
            highs.append(h_i)
        if is_swing_low:
            lows.append(l_i)

    return highs[-n_levels:], lows[-n_levels:]
```

---

## Strategy: funding\_reversal

```python
async def _strategy_funding_reversal(symbol, config, df, llm, redis,
                                       cvd_df, liq_s) -> "dict | None":
    """
    Funding rate reversal — extreme funding percentile + price confirmation.
    See crypto-futures-strategies/references/funding-reversal.md.

    Funding data is read from Redis cache (refreshed every 8 min via REST).
    Counter-trend by nature: confluence threshold is lower (default 2).
    """
    funding = await _get_or_refresh_funding(redis, symbol, config)
    if not funding:
        return None

    rate = funding["rate"]
    pct  = _funding_percentile(rate, funding["history"])

    if pct > 0.90:       direction = "short"
    elif pct < 0.10:     direction = "long"
    else:                return None

    atr_series = ta.atr(df["high"], df["low"], df["close"], length=14)
    rsi_series = ta.rsi(df["close"], length=14)
    if atr_series.isna().iloc[-1]:
        return None

    atr_val = float(atr_series.iloc[-1])
    rsi_val = float(rsi_series.iloc[-1])

    # RSI at extreme confirms crowding at price level too
    rsi_extreme = (direction == "short" and rsi_val > 70) or \
                  (direction == "long"  and rsi_val < 30)

    # Rejection candle: upper/lower wick > 0.4x ATR
    last    = df.iloc[-1]
    o, h, l, c = float(last["open"]), float(last["high"]), float(last["low"]), float(last["close"])
    up_wick = h - max(o, c)
    dn_wick = min(o, c) - l

    rejection = (direction == "short" and up_wick > atr_val * 0.4) or \
                (direction == "long"  and dn_wick > atr_val * 0.4)

    # Non-negotiable: at least one price confirmation must be present
    if not rsi_extreme and not rejection:
        return None

    signals = {
        "rate_percentile_extreme": True,
        "rsi_confirms":            rsi_extreme,
        "rejection_candle":        rejection,
        "llm_aligned":             _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    # Counter-trend: lower default threshold (2 instead of 3)
    if score < config.get("confluence_threshold", 2):
        return None

    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(float(df["close"].iloc[-1]), 4)),
        "atr":                str(round(atr_val, 4)),
        "regime":             "funding_reversal",
        "confluence_score":   str(score),
        "confluence_details": json.dumps({
            **signals,
            "rate":       round(rate, 6),
            "percentile": round(pct, 4),
        }),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }
```

---

## Strategy: liquidation (requires liquidation data)

```python
async def _strategy_liquidation(symbol, config, df, llm, redis,
                                  cvd_df, liq_s) -> "dict | None":
    """
    Liquidation-based — cascade detection from rolling notional volume.
    See crypto-futures-strategies/references/liquidation.md.
    Returns None if no liquidation data (non-Binance exchange or stream not started).
    """
    cascade_threshold = config.get("liq_cascade_threshold_usd", 2_000_000)
    five_min = liq_s.get("5m", {})

    if not five_min:
        return None

    long_liq  = float(five_min.get("long_vol",  0))
    short_liq = float(five_min.get("short_vol", 0))

    if long_liq > cascade_threshold:
        direction = "short"   # mass long liquidations = price dropped hard
    elif short_liq > cascade_threshold:
        direction = "long"    # mass short liquidations = price rose hard
    else:
        return None

    atr_series = ta.atr(df["high"], df["low"], df["close"], length=14)
    if atr_series.isna().iloc[-1]:
        return None
    atr_val = float(atr_series.iloc[-1])

    signals = {
        "cascade_volume_exceeded": True,
        "direction_clear":         long_liq != short_liq,
        "llm_aligned":             _llm_aligned(llm, direction),
    }
    score = sum(signals.values())
    if score < 2:
        return None

    price = float(df["close"].iloc[-1])
    return {
        "direction":          direction,
        "confidence":         str(round(score / len(signals), 4)),
        "entry_price":        str(round(price, 4)),
        "atr":                str(round(atr_val, 4)),
        "regime":             "liquidation_cascade",
        "confluence_score":   str(score),
        "confluence_details": json.dumps({
            **signals,
            "long_liq_usd":  round(long_liq,  0),
            "short_liq_usd": round(short_liq, 0),
        }),
        "llm_score":          str(llm["score"]) if llm else "",
        "llm_direction":      llm["direction"]  if llm else "",
    }
```

---

## CVD and liquidation helpers

These helpers read from Redis data written by `DataCollector` (CVD) and
`LiquidationCollector`. See `data-stream-extensions.md` for how that data
is produced. All return safe defaults when data is missing.

```python
async def get_cvd_series(redis, symbol: str, tf: str,
                          n: int = 200) -> "pd.DataFrame | None":
    """
    Read last N closed-candle CVD records.
    Returns DataFrame[ts, delta, buy_vol, sell_vol, cvd] or None if < 20 rows.
    cvd = cumulative sum of delta over the window.
    """
    raw_list = await redis.lrange(f"cvd.candles.{symbol}.{tf}", -n, -1)
    if len(raw_list) < 20:
        return None
    rows = [json.loads(r) for r in raw_list]
    df   = pd.DataFrame(rows)
    df["cvd"] = df["delta"].cumsum()
    return df


async def get_liquidation_summary(redis, symbol: str) -> dict:
    """
    Returns {5m: {long_vol, short_vol, window_start},
             30m: {long_vol, short_vol, window_start}}.
    Empty dicts if no data — callers must handle gracefully.
    """
    raw_5m  = await redis.get(f"liq.summary.{symbol}.5m")
    raw_30m = await redis.get(f"liq.summary.{symbol}.30m")
    return {
        "5m":  json.loads(raw_5m)  if raw_5m  else {},
        "30m": json.loads(raw_30m) if raw_30m else {},
    }


async def get_recent_liquidations(redis, symbol: str,
                                   window_s: int = 300) -> list[dict]:
    """
    Individual liquidation events from Redis Stream for the last window_s seconds.
    Returns list of {ts, side, qty, price, notional}, newest last.
    Used when per-event detail is needed (e.g. fade the liquidity grab).
    """
    min_id  = f"{(int(time.time()) - window_s) * 1000}-0"
    entries = await redis.xrange(f"liq.events.{symbol}", min=min_id, count=500)
    return [
        {
            "ts":       int(msg_id.split("-")[0]),
            "side":     data["side"],
            "qty":      float(data["qty"]),
            "price":    float(data["price"]),
            "notional": float(data["notional"]),
        }
        for msg_id, data in entries
    ]
```

---

## Funding rate helpers

```python
async def _get_or_refresh_funding(redis, symbol: str,
                                    config: dict) -> "dict | None":
    """
    Return cached funding data {rate: float, history: [float, ...]}.
    Reads from Redis (key: funding.cache.{symbol}).
    If missing or expired (TTL 8 min), fetches from exchange via REST and caches.
    """
    cache_key = f"funding.cache.{symbol}"
    cached    = await redis.get(cache_key)
    if cached:
        return json.loads(cached)

    exchange_name = config.get("exchange", "binance")
    ExClass = getattr(ccxt_async, exchange_name)
    ex = ExClass({"options": {"defaultType": "future"}})

    try:
        fr   = await ex.fetch_funding_rate(symbol)
        rate = float(fr["fundingRate"])

        hist    = await ex.fetch_funding_rate_history(symbol, limit=90)
        history = [float(h["fundingRate"]) for h in hist]

        data = {"rate": rate, "history": history}
        await redis.set(cache_key, json.dumps(data), ex=480)  # 8 min TTL
        return data

    except Exception:
        return None
    finally:
        await ex.close()


def _funding_percentile(rate: float, history: list[float]) -> float:
    """Where does current rate sit in historical distribution? Returns 0–1."""
    if not history:
        return 0.5
    below = sum(1 for r in history if r < rate)
    return below / len(history)
```

---

## Config hot-reload

```python
async def _load_config(redis, symbol: str, fallback: dict) -> dict:
    """
    Read config from Redis on every candle.
    If Redis read fails, use the last known config (fallback).
    """
    try:
        raw = await redis.get(f"config.worker.{symbol}")
        return json.loads(raw) if raw else fallback
    except Exception:
        return fallback
```

---

## Helpers

```python
def _parse_candle(raw: str) -> dict:
    data = json.loads(raw)
    return {
        "open":   Decimal(data["open"]),
        "high":   Decimal(data["high"]),
        "low":    Decimal(data["low"]),
        "close":  Decimal(data["close"]),
        "vol":    Decimal(data["vol"]),
        "ts":     int(data["ts"]),
        "tf":     data["tf"],
        "closed": data["closed"],
    }


def _update_buffer(buf: list[dict], candle: dict, maxlen: int = 500) -> list[dict]:
    if buf and buf[-1]["ts"] == candle["ts"]:
        buf[-1] = candle
    else:
        buf.append(candle)
    return buf[-maxlen:]


def _buffer_to_df(buf: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(buf)
    for col in ("open", "high", "low", "close", "vol"):
        df[col] = df[col].astype(float)   # pandas-ta needs float
    return df


async def _fetch_initial_candles(symbol: str, redis, log,
                                   n: int = 300) -> list[dict]:
    """
    Fetch candle history at startup to warm up indicators.
    Returns list of candle dicts (oldest first).
    """
    try:
        config_raw = await redis.get(f"config.worker.{symbol}")
        config     = json.loads(config_raw) if config_raw else {}
        exchange   = config.get("exchange", "binance")

        ExClass = getattr(ccxt_async, exchange)
        ex  = ExClass({"options": {"defaultType": "future"}})
        tf  = config.get("timeframe", "1h")
        raw = await ex.fetch_ohlcv(symbol, tf, limit=n)
        await ex.close()

        return [
            {"open": Decimal(str(o)), "high": Decimal(str(h)),
             "low":  Decimal(str(l)), "close": Decimal(str(c)),
             "vol":  Decimal(str(v)), "ts": ts, "tf": tf, "closed": True}
            for ts, o, h, l, c, v in raw
        ]
    except Exception as e:
        log.warning("Could not pre-fetch candle history", error=str(e))
        return []


async def _get_llm_signal(redis, symbol: str) -> "dict | None":
    try:
        raw = await redis.get(f"llm.signal.{symbol}")
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _llm_aligned(llm: "dict | None", direction: str) -> bool:
    if not llm:
        return False
    score = float(llm.get("score", 0.5))
    return (direction == "long"  and score > 0.6) or \
           (direction == "short" and score < 0.4)
```
