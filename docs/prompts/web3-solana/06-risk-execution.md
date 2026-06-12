# Fase 06 — RiskManager (Safety Gate) + Execution (Jupiter Swap)

Tujuan: RiskManager sebagai safety gate antara signal dan swap, plus Execution
sebagai satu-satunya komponen yang memegang keypair dan memanggil Jupiter.
Prasyarat: Fase 03-05 dan 07 selesai — stream.agent.approved sudah aktif.

---

## Prompt 6.1 — RiskManager

```
Gunakan @web3-solana-risk secara lengkap, termasuk semua references/.
Gunakan @web3-solana-architecture untuk Redis schema dan stream names.

Buat components/risk_manager.py:

Hard-coded constants (BUKAN config — tidak bisa di-override):
  MAX_POSITION_USDC        = Decimal("500")
  MAX_CONCURRENT_POSITIONS = 5
  MIN_SOL_RESERVE          = Decimal("0.05")
  MIN_VIABLE_POSITION_USDC = Decimal("5")
  TAKE_PROFIT_PCT          = Decimal("1.0")   # 2× entry
  SL_TIERS: ≥500k→15%, ≥50k→20%, ≥10k→30%, <10k→40%  (lihat @web3-solana-risk references/position-sizing.md)

Per-strategy size multipliers (dari skill):
  kol_copy_trade: 1.0, graduation_trade: 1.0, smart_money_confluence: 1.0,
  momentum_spike: 0.8, new_launch_snipe: 0.5, social_alpha: 0.5

Slippage tiers berdasarkan liquidity_usdc:
  >= 500000: 50bps, >= 50000: 100bps, >= 10000: 200bps,
  < 10000: 500bps, emergency SELL: 1000bps

class RiskManager:
  - BUY path:  consumer group risk-group / risk-manager-1 pada stream.agent.approved
  - SELL path: consumer group risk-sell-group / risk-manager-1 pada stream.signals

  Safety gate sequence (BUY) — urutan penting, stop di failure pertama:
    1. Cek state.position.{mint} → reject jika sudah ada posisi
    2. Hitung concurrent positions (len SMEMBERS state.bot.tokens) → reject jika >= MAX
    3. Cek stats.daily_pnl vs config.risk.max_daily_loss_usdc (circuit breaker)
    4. Cek state.bot.status == "running" → reject jika tidak
    5. Hitung wallet USDC balance (dari state.wallet.usdc_balance di Redis)
    6. Cek SOL reserve >= MIN_SOL_RESERVE
    7. Kalkulasi position size: final_score/100 × multiplier × wallet_usdc,
       capped MAX_POSITION_USDC, minimum MIN_VIABLE_POSITION_USDC
    8. Reject jika final size < MIN_VIABLE_POSITION_USDC

  Setelah gate pass (BUY):
    - Derive slippage dari liquidity_usdc
    - Hitung stop_loss_price via calculate_stop_loss_price(entry_price, liquidity_usdc)
    - Hitung take_profit_price = entry_price * (1 + TAKE_PROFIT_PCT)
    - XADD stream.swaps dengan schema lengkap (lihat skill)
    - XACK stream.agent.approved

  SELL signals: bypass safety gate (exit tidak boleh diblokir)
    - Hanya derive slippage (emergency: 1000bps untuk stop_loss/emergency_stop)
    - XADD stream.swaps langsung
    - XACK stream.signals

  Jika reject: log reason, XACK stream.agent.approved, lanjut ke signal berikutnya.
  Jangan crash — rejection adalah flow normal, bukan error.
```

---

## Prompt 6.2 — PositionTracker

```
Gunakan @web3-solana-architecture Redis keys state.position.{mint} dan state.bot.tokens.
Gunakan @web3-solana-engine references/position-tracker.md.

Buat components/position_tracker.py:

class PositionTracker:
  - Consumer group: fill-group / position-tracker-1
  - Baca dari stream.fills (XREADGROUP)

  Untuk fill dengan side=BUY, status=confirmed:
    - SET state.position.{mint} = JSON:
      { mint, symbol, entry_price, amount_tokens, size_usdc,
        stop_loss_price, take_profit_price, strategy, opened_at (epoch s),
        max_hold_time (dari config.risk) }
    - SADD state.bot.tokens {mint}
    - PUBLISH position.updates: { event="opened", mint, symbol, entry_price,
      size_usdc, strategy }

  Untuk fill dengan side=SELL, status=confirmed:
    - Ambil position dari state.position.{mint}
    - Kalkulasi pnl_usdc = sell_amount_usdc - position.size_usdc
    - PUBLISH position.updates: { event="closed", mint, symbol, pnl_usdc,
      pnl_pct, reason }
    - DEL state.position.{mint}
    - SREM state.bot.tokens {mint}

  Untuk fill status=failed/timeout:
    - PUBLISH position.updates: { event="fill_failed", mint, symbol, status, reason }
    - Jangan hapus posisi — posisi mungkin masih open jika BUY sebelumnya confirmed

  XACK stream.fills setelah setiap message diprocess.
```

---

## Prompt 6.3 — DBWriter

```
Gunakan @web3-solana-db-schema references/dbwriter.md.
Gunakan @web3-solana-architecture untuk stream.fills schema.

Buat components/db_writer.py:

class DBWriter:
  - Consumer group: fill-group / db-writer-1
  - Baca dari stream.fills (XREADGROUP, SAMA dengan PositionTracker — keduanya
    punya consumer yang berbeda dalam group yang sama)
  - Subscribe ke scanner.safety.rejected (pub/sub)

  Untuk stream.fills:
    - side=BUY: panggil db/queries.py → insert_buy_fill(pool, fill_data)
    - side=SELL, status=confirmed:
      1. Ambil buy row: get_open_buy(pool, mint)
      2. Kalkulasi pnl: update_sell_fill(pool, fill_data, buy_row.amount_usdc)
    - status=failed/timeout/dry_run: insert_buy_fill atau update dengan status tersebut
    - Semua INSERT menggunakan ON CONFLICT DO NOTHING (idempotency via fill_id)

  Untuk scanner.safety.rejected pub/sub:
    - insert_rejection(pool, rejection_data)

  Nightly rebuild (midnight UTC):
    - Jalankan rebuild_strategy_stats(pool)
    - Log statistik yang dihasilkan

  DBWriter TIDAK boleh memblokir komponen lain — semua operasi DB async.
  Jika DB unavailable: log error, skip message (jangan crash bot).
```

---

## Prompt 6.4 — Execution component

```
Gunakan @web3-solana-execution secara lengkap, termasuk semua references/.
Gunakan @web3-solana safety rules — terutama rules 1, 2, 3, 5, 7.

Buat dua file:

1. components/execution/jupiter.py
   Implementasikan fungsi lengkap:
   - get_jupiter_quote(session, input_mint, output_mint, amount, slippage_bps) → dict
   - get_jupiter_swap_transaction(session, quote_response, user_public_key, priority_fee) → str
   - sign_transaction(swap_tx_b64: str, keypair: Keypair) → bytes
   - send_transaction_with_fallback(tx_bytes, primary_url, fallback_url) → str
   - wait_for_confirmation(signature, rpc_url, timeout_s=60, poll_interval_s=2) → str
     Return: "confirmed" | "failed" | "timeout"
   - execute_swap(session, keypair, rpc_url, rpc_fallback_url, ..., dry_run=True) → SwapResult

   Error handling wajib (inline di SKILL.md execution):
   - SlippageToleranceExceeded → return status="failed", JANGAN retry otomatis
   - InsufficientFunds → return status="failed", log error
   - BlockhashNotFound → return status="failed", jangan re-sign bytes yang sama
   - Confirmation "timeout" → return status="timeout", kemudian async cek on-chain

2. components/execution/execution.py
   class Execution:
   - Keypair disimpan di __init__, TIDAK pernah keluar dari class
   - _locks: dict[str, asyncio.Lock] — satu lock per mint
   - Consumer group: exec-group / execution-1
   - Baca dari stream.swaps

   _execute_buy: USDC → token
     - Konversi amount_usdc string ke integer micro-units (6 desimal)
     - priority_fee = "auto"
     - execute_swap → SwapResult
     - Kalkulasi price_usdc dari actual amount_out (bukan quote estimate)

   _execute_sell: token → USDC
     - amount_tokens sudah dalam integer units dari stream.swaps
     - priority_fee = "autoMultiplier:3" untuk stop_loss/emergency_stop, "auto" untuk lainnya
     - execute_swap → SwapResult

   Publish stream.fills untuk SETIAP attempt: confirmed | failed | timeout | dry_run
   Tidak ada exceptions yang boleh menyebabkan fill tidak dipublish.
   XACK stream.swaps setelah setiap message.
```

---

## Prompt 6.5 — CommandListener

```
Gunakan @web3-solana-architecture references/control-interface.md.

Buat components/command_listener.py:

class CommandListener:
  - Consumer group: cmd-group / cmd-listener-1
  - Baca dari stream.commands

  Commands yang dihandle:
  - START: spawn Scanner + Strategy + RiskManager + Execution + PositionTracker + DBWriter
    → SET state.bot.status = "running"
  - STOP: cancel Scanner + Strategy tasks
    → SET state.bot.status = "stopped"
  - PAUSE: SET state.bot.status = "paused" (RiskManager akan reject semua BUY)
  - RESUME: SET state.bot.status = "running"
  - EMERGENCY_STOP:
    1. SET state.bot.status = "stopping"
    2. Publish SELL signal untuk semua mint di state.bot.tokens
       (reason=emergency_stop, slippage=1000bps)
    3. Wait konfirmasi semua sells (max 60s)
    4. SET state.bot.status = "stopped"
  - ADD_KOL_WALLET {address, label}: SADD state.kol.wallets, upsert kol_wallets DB
  - REMOVE_KOL_WALLET {address}: SREM state.kol.wallets, SET kol_wallets.active=false

  XACK setelah setiap command.
  Unknown commands: log warning, XACK, lanjut.
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/risk_manager.py — safety gate 7 langkah, size calc, slippage tiers
- [ ] components/position_tracker.py — open/close posisi di Redis
- [ ] components/db_writer.py — insert fills, rejection log, nightly rebuild
- [ ] components/execution/jupiter.py — quote, swap, sign, send, confirm
- [ ] components/execution/execution.py — Keypair isolation, per-mint locks
- [ ] components/command_listener.py — START/STOP/EMERGENCY_STOP
- [ ] DRY_RUN=true: bot bisa start dan terima signal tanpa kirim transaksi
