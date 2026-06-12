# Fase 05 — Strategy Layer (Pre-filter + Layer 1 Scoring)

Tujuan: SignalBuffer, 6 strategi trading, confluence engine (Layer 1 scoring),
dan position monitor loop.
Prasyarat: Fase 04 selesai — Scanner berjalan dan publish ke Redis pub/sub.

---

## Prompt 5.1 — SignalBuffer

```
Gunakan @web3-solana-strategy references/confluence-engine.md bagian SignalBuffer.
Gunakan @web3-solana-architecture untuk Redis naming convention.

Buat components/strategy/buffer.py:

class SignalBuffer:
  - In-memory buffer, bukan Redis — satu instance shared ke semua Strategy tasks
  - Gunakan asyncio.Lock untuk thread safety
  - Internal: dict[mint, list[dict]] — list signal per mint

  async def add(self, mint: str, signal: dict) -> None:
    - Tambahkan signal ke buffer mint tersebut
    - Sertakan timestamp saat ditambahkan

  async def get_signals(self, mint: str, window_s: int) -> list[dict]:
    - Return semua signal untuk mint dalam window_s detik terakhir
    - Auto-prune signal yang sudah expired dari memory

  async def clear(self, mint: str) -> None:
    - Hapus semua signal untuk mint (dipanggil setelah BUY signal dipublish)

  async def prune_expired(self, max_window_s: int = 900) -> int:
    - Hapus semua signal yang lebih tua dari max_window_s
    - Return jumlah yang di-prune
    - Dipanggil periodik dari strategy runner
```

---

## Prompt 5.2 — Confluence engine

```
Gunakan @web3-solana-strategy SKILL.md bagian "Confluence Model" dan "Confidence Score".
Gunakan @web3-solana-strategy references/confluence-engine.md secara lengkap.

Buat components/strategy/confluence.py:

SIGNAL_WEIGHTS = {
  "kol_wallet": 40, "smart_money_multi": 35, "pumpfun_graduation": 30,
  "gmgn_trending": 25, "birdeye_trending": 20, "dexscreener_volume": 20,
  "pumpfun_new": 15, "twitter_spike": 15, "telegram_alpha": 10,
}

async def evaluate_confluence(
  mint: str,
  signals: list[dict],
  strategy_name: str,
  min_score: int,
  anchor_sources: list[str],
  redis,
) -> tuple[bool, int, list[str]]:
  - Return (should_buy, confidence_score, active_sources)
  - Step 1 — Pre-filter: cek apakah minimal SATU anchor_source ada di signals
    Jika tidak ada → return (False, 0, []) TANPA kalkulasi lebih lanjut
  - Step 2 — Score: sum SIGNAL_WEIGHTS untuk semua sources yang ada di signals
  - Step 3 — Threshold: jika score < min_score → return (False, score, sources)
  - Step 4 — Safety gate: cek token via RugcheckValidator
    Jika gagal rugcheck → return (False, score, sources)
  - Return (True, score, sources) jika semua pass

async def publish_buy_signal(
  mint: str, symbol: str, strategy: str,
  confidence: int, liquidity_usdc: float,
  sources: list[str], redis: Redis,
) -> str:
  - Buat signal_id: f"sig_{uuid4().hex[:12]}"
  - XADD stream.signals (selalu — SignalAggregator yang handle routing ke GATE 1)
  - Return signal_id

Schema stream.signals BUY:
  signal_id, mint, symbol, action="BUY", strategy, confidence (str),
  liquidity_usdc (str), sources (JSON list), ts (epoch ms str)
```

---

## Prompt 5.3 — KOL Copy Trade dan New Launch Snipe

```
Gunakan @web3-solana-strategy references/strategy-kol-copy.md dan
references/strategy-new-launch.md.
Gunakan @web3-solana-architecture untuk Redis pub/sub channel names.

Buat components/strategy/kol_copy.py:

class KolCopyTradeStrategy:
  - __init__(self, buffer: SignalBuffer, redis, settings)
  - anchor_sources = ["kol_wallet", "smart_money_multi"]
  - min_score = 50, signal_window = 300s

  async def run(self, stop_event: asyncio.Event) -> None:
    - Subscribe ke scanner.wallet.buy
    - Untuk setiap WalletBuySignal:
      1. Tambahkan ke SignalBuffer dengan source dari signal
      2. Ambil semua signal untuk mint dalam 300s window
      3. evaluate_confluence(mint, signals, "kol_copy_trade", 50, anchor_sources)
      4. Jika should_buy: publish_buy_signal(), clear buffer untuk mint
    - Handle asyncio.CancelledError untuk graceful stop

Buat components/strategy/new_launch.py:

class NewLaunchSnipeStrategy:
  - anchor_sources = ["pumpfun_new"]
  - min_score = 65, signal_window = 60s  ← window paling ketat, harus cepat

  async def run(self, stop_event: asyncio.Event) -> None:
    - Subscribe ke scanner.token.new
    - Filter: hanya source=PUMPFUN
    - Signal window 60s — jika tidak cukup score dalam 60s, token dilewati
    - evaluate_confluence dengan min_score=65
    - Jika should_buy: publish, clear buffer
```

---

## Prompt 5.4 — Graduation, Momentum, Smart Money, Social Alpha

```
Gunakan @web3-solana-strategy references/strategy-graduation.md,
references/strategy-momentum.md, references/strategy-smart-money.md,
references/strategy-social-alpha.md.

Buat 4 file strategy:

components/strategy/graduation.py — GraduationTradeStrategy
  - Subscribe ke scanner.token.new (filter: graduation events dari Pump.fun)
  - anchor_sources = ["pumpfun_graduation"], min_score = 55, window = 600s
  - Pumpfun graduation = token mencapai bonding curve threshold

components/strategy/momentum.py — MomentumSpikeStrategy
  - Subscribe ke scanner.token.trending
  - anchor_sources = ["gmgn_trending", "dexscreener_volume"]
  - min_score = 60, window = 300s
  - Kedua anchor harus hadir (AND, bukan OR) — volume spike harus dikonfirmasi

components/strategy/smart_money.py — SmartMoneyConfluenceStrategy
  - Subscribe ke scanner.wallet.buy
  - anchor_sources = ["smart_money_multi"]
  - min_score = 70, window = 600s
  - "smart_money_multi" = minimal 2 Cielo wallet berbeda buy token yang sama

components/strategy/social_alpha.py — SocialAlphaStrategy
  - Subscribe ke scanner.token.new + scanner.token.trending
  - anchor_sources = ["telegram_alpha", "twitter_spike"]
  - min_score = 75, window = 900s  ← threshold tertinggi karena noise paling tinggi
  - Kedua anchor harus hadir (telegram call + twitter volume)

Semua strategy menggunakan SignalBuffer dan evaluate_confluence yang sama.
Semua stop pada asyncio.CancelledError.
```

---

## Prompt 5.5 — Position monitor

```
Gunakan @web3-solana-strategy references/confluence-engine.md bagian "exit logic".
Gunakan @web3-solana-architecture Redis key: state.position.{mint}, state.price.{mint}.

Buat components/strategy/position_monitor.py:

async def position_monitor_loop(redis, stop_event: asyncio.Event) -> None:
  - Jalankan setiap 5s
  - Baca SET state.bot.tokens → list mint yang sedang open
  - Untuk tiap mint:
    1. GET state.position.{mint} → JSON position data
    2. GET state.price.{mint} → current price (Decimal)
    3. Jalankan _check_exit_conditions(mint, position, price, redis)

async def _check_exit_conditions(mint, position, price, redis) -> None:
  - Ambil dari position: entry_price, stop_loss_price, take_profit_price,
    opened_at, max_hold_time
  - Stop loss: jika price <= stop_loss_price
    → XADD stream.signals: action=SELL, reason=stop_loss
  - Take profit: jika price >= take_profit_price
    → XADD stream.signals: action=SELL, reason=take_profit
  - Max hold time: jika (now - opened_at) >= max_hold_time
    → XADD stream.signals: action=SELL, reason=max_hold_time

Schema stream.signals SELL:
  signal_id, mint, symbol, action="SELL", reason, strategy, confidence="100", ts

Position monitor tidak pernah call Jupiter atau sign transaksi.
Hanya publish ke stream.signals — RiskManager dan Execution yang handle.
```

---

## Prompt 5.6 — Strategy runner (wiring semua tasks)

```
Gunakan @web3-solana-engine references/strategy-runner.md.

Buat components/strategy/runner.py:

class StrategyRunner:
  - __init__(self, redis, settings)
  - Instansiasi SignalBuffer satu kali
  - Instansiasi semua 6 strategy classes dengan buffer yang sama

  async def start(self, stop_event: asyncio.Event) -> list[asyncio.Task]:
    - Spawn semua strategy sebagai named tasks:
      asyncio.create_task(kol.run(stop_event),         name="strategy.kol_copy")
      asyncio.create_task(new_launch.run(stop_event),  name="strategy.new_launch")
      asyncio.create_task(graduation.run(stop_event),  name="strategy.graduation")
      asyncio.create_task(momentum.run(stop_event),    name="strategy.momentum")
      asyncio.create_task(smart_money.run(stop_event), name="strategy.smart_money")
      asyncio.create_task(social_alpha.run(stop_event),name="strategy.social_alpha")
      asyncio.create_task(
        position_monitor_loop(redis, stop_event),      name="strategy.position_monitor"
      )
    - Tambahkan periodic prune task: setiap 60s jalankan buffer.prune_expired()
    - Return list tasks

  async def stop(self, tasks: list[asyncio.Task]) -> None:
    - await stop semua tasks dengan timeout 5s sebelum cancel
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/strategy/buffer.py — SignalBuffer dengan asyncio.Lock
- [ ] components/strategy/confluence.py — evaluate_confluence, publish_buy_signal
- [ ] components/strategy/kol_copy.py
- [ ] components/strategy/new_launch.py
- [ ] components/strategy/graduation.py
- [ ] components/strategy/momentum.py
- [ ] components/strategy/smart_money.py
- [ ] components/strategy/social_alpha.py
- [ ] components/strategy/position_monitor.py
- [ ] components/strategy/runner.py — wiring semua tasks dengan nama
