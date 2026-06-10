# Fase 04 — Bot Engine Components

Tujuan: Implementasi semua komponen bot engine.
Prasyarat: Fase 03 selesai (main.py bisa import semua komponen).
Jalankan setiap prompt dalam sesi terpisah atau berurutan dalam satu sesi panjang.

---

## Prompt 4.1 — DataCollector

```
Gunakan @crypto-futures-bot-engine references/data-collector.md dan
references/data-stream-extensions.md.

Buat bot_engine/components/data_collector.py dengan implementasi lengkap:

1. async def run_data_collector(symbol, redis, stop_event):
   - Satu instance per symbol
   - Buat exchange instance dari config Redis: config.worker.{symbol}
   - Subscribe semua timeframes dari config (default ["1h", "15m"])
   - Publish closed candles ke Redis pub/sub: market.{symbol}.candle.{tf}
   - Update state.price.{symbol} setiap candle (TTL 10s)

2. _watch_loop — inner loop, re-entered on reconnect:
   - Task untuk setiap timeframe: _watch_ohlcv
   - Task tambahan: _watch_trades_cvd (CVD stream)
   - Reconnect handling: NetworkError 2s, ExchangeNotAvailable 10s, Exception 5s

3. _watch_ohlcv — publish hanya closed candles:
   - Cek candle_close_ts > now sebelum publish
   - Format payload: {open, high, low, close, vol, ts, tf, closed}
   - Semua nilai harga sebagai string Decimal

4. _watch_trades_cvd — CVD aggregation per candle bucket:
   - In-memory accumulation: delta, buy_vol, sell_vol per bucket
   - Flush ke Redis LIST cvd.candles.{symbol}.{tf} saat bucket berganti
   - Atomic: pipeline rpush + ltrim (maxlen 500)
   - trade["side"] "buy" = positive delta, "sell" = negative delta

5. _make_exchange — build ccxt.pro instance dari Redis config:
   - API key dari env var (api_key_ref), JANGAN simpan key di Redis
   - await ex.load_markets() — WAJIB async

Candle payload harus string Decimal, BUKAN float.
```

---

## Prompt 4.2 — StrategyWorker

```
Gunakan @crypto-futures-bot-engine references/strategy-worker.md secara penuh.

Buat bot_engine/components/strategy_worker.py dengan implementasi LENGKAP
semua 6 strategi. File ini BESAR — pastikan semua fungsi ada, tidak ada stub.

Komponen utama:
1. run_strategy_worker(symbol, initial_config, redis, stop_event)
   - Dedicated pub/sub connection (r_sub)
   - Pre-fetch candle history (300 candles) untuk warm-up indikator
   - Subscribe ke market.{symbol}.candle.{tf} channels
   - Hot-reload config dari Redis setiap candle
   - Cek state.bot.status == "running" sebelum evaluate

2. _evaluate_and_publish:
   - Fetch cvd_df = await get_cvd_series(redis, symbol, tf)
   - Fetch liq_s = await get_liquidation_summary(redis, symbol)
   - Route ke strategy function
   - Publish ke stream.signals jika signal tidak None

3. _route_strategy dengan semua 6 strategi wired:
   trend, breakout, momentum, sr_bounce, funding, liquidation

4. Semua 6 strategy functions LENGKAP (tidak ada return None placeholder):
   - _strategy_trend: EMA 9/21/50 ribbon + RSI + volume
   - _strategy_breakout: ATR compression + confirmed break + volume
   - _strategy_momentum: EMA50/200 + VWAP reclaim + CVD divergence
   - _strategy_sr_bounce: swing pivot + rejection candle + ATR band
   - _strategy_funding_reversal: funding percentile + RSI/pin bar confirm
   - _strategy_liquidation: 5m liquidation cascade dari liq_s

5. Helper functions:
   - get_cvd_series, get_liquidation_summary, get_recent_liquidations
   - _get_or_refresh_funding (Redis cache 8 min, REST fallback)
   - _funding_percentile, _find_swing_levels
   - _parse_candle, _update_buffer, _buffer_to_df, _fetch_initial_candles
   - _get_llm_signal, _llm_aligned

Semua kalkulasi harga HARUS float di dalam fungsi (df sudah float setelah
_buffer_to_df). Return dict nilai harga sebagai str(round(value, 4)).
```

---

## Prompt 4.3 — Price Structure helper

```
Gunakan @crypto-futures-strategies references/price-structure.md.

Buat bot_engine/components/price_structure.py sebagai module terpisah
yang bisa di-import dari strategy_worker.py.

Implementasikan semua fungsi dan dataclass:
- @dataclass SwingPoint (price, bar_index, ts, kind)
- @dataclass BosEvent (type, broken_level, bar_index, ts)
- @dataclass ChochEvent (type, broken_level, bar_index, ts)
- @dataclass OrderBlock (type, top, bottom, open, close, bar_index, ts, valid)
- @dataclass FVG (type, top, bottom, ts, bar_index, filled)

Fungsi:
- find_swings(df, window=5) → (list[SwingPoint], list[SwingPoint])
- detect_bos(df, swing_highs, swing_lows, confirm_close=True) → BosEvent|None
- detect_choch(df, swing_highs, swing_lows, current_trend) → ChochEvent|None
- find_order_blocks(df, atr_val, impulse_min_atr=2.0, lookback=50) → list[OrderBlock]
- price_in_order_block(price, blocks, kind) → OrderBlock|None
- find_fvgs(df, lookback=30, min_gap_pct=0.001) → list[FVG]
- price_in_fvg(price, fvgs, kind) → FVG|None
- premium_discount(price, range_high, range_low) → dict
- get_structure_context(df, swing_window=5, ob_lookback=50, fvg_lookback=30) → dict

File ini TIDAK boleh import dari strategy_worker.py (one-way dependency).
```

---

## Prompt 4.4 — RiskManager

```
Gunakan @crypto-futures-bot-engine references/risk-order-executor.md
bagian RiskManager.

Buat bot_engine/components/risk_manager.py dengan class RiskManager:

class RiskManager:
  def __init__(self, redis, AsyncSessionLocal, settings): ...

  async def run(self, stop_event):
    - Consumer dari stream.signals (group: risk-manager)
    - xreadgroup loop dengan count=1, block=1000ms
    - Panggil _process_signal untuk setiap message
    - xack setelah berhasil process (ACK dulu sebelum publish order!)

  async def _process_signal(self, data, msg_id):
    5 gate checks berurutan (skip jika gagal):
    1. State check: state.bot.status == "running"
    2. Position check: tidak ada open position untuk symbol ini
    3. Circuit breaker: cek state.circuit.{symbol}
    4. Equity check: fetch balance, pastikan >= minimum
    5. Daily drawdown: cek cumulative loss hari ini

    Jika semua pass: hitung qty via position_size(), publish ke stream.orders
    stream.orders payload HARUS include: symbol, direction, qty, order_type,
    sl_price, tp_price, atr, leverage, strategy, signal_id, confidence, ts

  def position_size(self, equity, risk_pct, entry, sl, leverage) → Decimal:
    - qty = (equity * risk_pct) / abs(entry - sl)
    - qty di-round ke precision exchange (ambil dari config)
    - JANGAN return lebih dari max_position_pct * equity / entry

CircuitBreaker class:
  - trip() — set state.circuit.{symbol} dengan TTL dari config
  - is_tripped() — cek Redis key
```

---

## Prompt 4.5 — OrderExecutor

```
Gunakan @crypto-futures-bot-engine references/risk-order-executor.md
bagian OrderExecutor.

Buat bot_engine/components/order_executor.py dengan class OrderExecutor:

class OrderExecutor:
  def __init__(self, redis, AsyncSessionLocal, settings):
    self._locks: dict[str, asyncio.Lock] = {}  # per-symbol Lock
    self._exchanges: dict[str, ccxt.pro.Exchange] = {}  # exchange instances

  async def run(self, stop_event):
    - Consumer dari stream.orders (group: order-executor)
    - Satu Lock per symbol (buat jika belum ada)
    - async with self._locks[symbol]: process order
    - Ini mencegah duplicate order untuk symbol yang sama

  async def _execute(self, data, msg_id):
    - Ambil/buat exchange instance untuk account
    - set_leverage() jika berbeda dari current
    - create_order() market entry
    - _assert_filled() — verifikasi order benar-benar terisi
    - Pasang SL order (stop_market, reduce_only=True)
    - Pasang TP order (take_profit_market, reduce_only=True)
    - Publish ke stream.fills dengan semua detail
    - xack msg_id

  async def _assert_filled(self, ex, order_id, symbol, max_wait=10):
    - Poll fetch_order() setiap 500ms
    - Raise jika status != "closed" setelah max_wait detik
    - Jika gagal: trigger emergency_close

  async def modify_sl(self, symbol, new_sl, old_sl_order_id):
    - Cancel SL lama
    - Pasang SL baru (stop_market, reduce_only=True)
    - Jika SL baru gagal: publish CRITICAL alert + emergency_close
    - Brief unprotected window ~200ms antara cancel dan baru — ini acceptable

  async def partial_close(self, symbol, close_qty, tp_order_id, reason):
    - Cancel TP yang ada
    - Market close sejumlah close_qty (reduce_only=True)
    - Re-pasang TP untuk sisa qty
    - Publish fill event dengan outcome "partial_close:{reason}"

  async def emergency_close(self, symbol, position, reason):
    - Cancel semua open orders untuk symbol
    - Market close seluruh position (reduce_only=True)
    - Publish fill event dengan outcome "emergency_close"

  async def _get_or_create_exchange(self, account_id, config) → ccxt.pro.Exchange:
    - Cache exchange instance per account_id
    - await ex.load_markets() saat pertama kali buat
```

---

## Prompt 4.6 — PositionTracker dan DBWriter

```
Gunakan @crypto-futures-bot-engine references/position-tracker.md secara penuh.

Buat dua file:

1. bot_engine/components/db_writer.py
   class DBWriter:
   - Consumer dari stream.fills (group: fill-processors, consumer: db-writer)
   - Tulis Trade record ke PostgreSQL untuk setiap fill
   - Update DailyPnl menggunakan upsert_daily_pnl dari db/queries.py
   - Fallback: jika DB unavailable, append ke logs/db_fallback.jsonl
   - drain_pending() untuk crash recovery saat startup

2. bot_engine/components/position_tracker.py
   class PositionTracker:
   - Consumer dari stream.fills (group: fill-processors, consumer: position-tracker)
   - _fill_loop(): proses fills, update state.position.{symbol} di Redis
   - _open_position(): simpan posisi baru ke Redis JSON
   - _close_position(): hapus dari Redis, publish ke position.updates pub/sub
   - _partial_close_position(): update qty dan tp_order_id, publish update
   - _reconcile_loop(): setiap 30s bandingkan Redis state vs exchange actual
     Jika ada perbedaan: update Redis, log WARNING
   - drain_pending() untuk crash recovery

   Format state.position.{symbol} di Redis:
   {symbol, direction, qty, entry_price, sl_price, tp_price, atr,
    sl_order_id, tp_order_id, opened_at, pm_stage, pm_trail_peak,
    partial_tp_done}

   Publish ke position.updates pub/sub setiap perubahan:
   {symbol, status: "open"|"closed"|"partial", position: {...}, ts}
```

---

## Prompt 4.7 — PositionManager

```
Gunakan @crypto-futures-bot-engine references/position-manager.md secara penuh.

Buat bot_engine/components/position_manager.py dengan class PositionManager:

class PositionManager:
  def __init__(self, redis, registry, order_executor): ...

  async def run(self, stop_event):
    - Polling loop setiap 10 detik
    - Panggil _check_all() untuk semua active symbols

  async def _check_all(self):
    - Untuk setiap symbol di registry.all_symbols():
      ambil state.position.{symbol}, panggil _check_position

  async def _check_position(self, symbol, position):
    Evaluasi 5 rules berurutan (priority order):
    1. Time exit: jika open > max_hours dan belum capai 1R → emergency_close
    2. Trailing active: update peak, jika price menyentuh trail level → modify_sl
    3. Trailing activate: jika profit >= activate_r → switch ke trailing mode
    4. Break-even: jika profit >= trigger_r → pindah SL ke entry + buffer
    5. Partial TP: jika profit >= tp1_r dan belum partial → partial_close 50%

  async def _apply_break_even(self, symbol, position, config):
    - new_sl = entry + (entry * buffer_pct) untuk long
    - Only improve (new_sl > old_sl untuk long)
    - Panggil order_executor.modify_sl()
    - Update pm_stage = "break_even_set" via _patch_position

  async def _apply_trailing_stop(self, symbol, position, config):
    - Update peak: max(current_peak, price) untuk long
    - trail_dist = atr * trail_atr_mult
    - new_sl = peak - trail_dist untuk long
    - Only improve SL
    - Panggil order_executor.modify_sl()
    - Update pm_trail_peak via _patch_position

  async def _apply_partial_tp(self, symbol, position, config):
    - close_qty = qty * tp1_pct (default 50%)
    - Panggil order_executor.partial_close()
    - Update partial_tp_done = True via _patch_position

  async def _patch_position(self, symbol, updates: dict):
    - Atomic read-modify-write pada state.position.{symbol}
    - Merge updates ke existing dict, simpan kembali ke Redis

  Config keys yang dibaca dari config.worker.{symbol}:
  position_management.break_even.{trigger_r, buffer_pct}
  position_management.trailing_stop.{activate_r, trail_atr_mult}
  position_management.partial_tp.{tp1_r, tp1_pct}
  position_management.time_exit.{max_hours, min_r_to_skip}
```

---

## Prompt 4.8 — CommandListener, DBWriter drain, LiquidationCollector, LLMSignalAgent

```
Gunakan @crypto-futures-bot-engine dan @crypto-futures-bot-architecture
references/control-interface.md.

Buat 3 file berikut:

1. bot_engine/components/command_listener.py
   class CommandListener:
   - Consumer dari stream.commands (group: command-listener)
   - Handle commands: ADD_SYMBOL, REMOVE_SYMBOL, PAUSE_SYMBOL, RESUME_SYMBOL,
     UPDATE_CONFIG, EMERGENCY_STOP
   - Setiap command publish response ke bot.status pub/sub dengan req_id
   - ADD_SYMBOL: validasi config, panggil spawn_worker dari registry
   - REMOVE_SYMBOL: panggil stop_worker
   - EMERGENCY_STOP: stop semua workers, panggil emergency_close untuk semua posisi
   - UPDATE_CONFIG: update config.worker.{symbol} di Redis (hot-reload otomatis)

2. bot_engine/components/liquidation_collector.py
   class LiquidationCollector:
   - Binance USDM WebSocket: wss://fstream.binance.com/ws/!forceOrder@arr
   - Gunakan library websockets (bukan ccxt)
   - Hanya proses symbols yang ada di registry.all_symbols()
   - Tulis ke liq.events.{symbol} Stream (maxlen 1000)
   - Update liq.summary.{symbol}.5m dan .30m (rolling window, JSON, TTL)
   - Reconnect otomatis dengan delay 5s jika stream error
   - Parsing: order side SELL = long dilikuidasi, BUY = short dilikuidasi

3. bot_engine/components/llm_signal_agent.py
   class LLMSignalAgent:
   - Refresh setiap settings.llm_refresh_interval_s detik (default 240)
   - Untuk setiap symbol aktif: kirim prompt ke LLM provider
   - Simpan hasil ke llm.signal.{symbol} Redis (TTL 480s)
   - Format: {score: 0-1, direction: bullish/bearish/neutral, reason: str, ts}
   - Gunakan httpx untuk REST call ke LLM API
   - Jangan block event loop: jalankan semua symbol concurrently
   - Graceful: jika LLM gagal, biarkan cache lama expire secara natural
```
