# Fase 04 — Scanner (Data Fetching Layer)

Tujuan: Semua 10 sumber data berjalan sebagai asyncio tasks, normalisasi ke
unified signal format, dedup, dan publish ke Redis pub/sub.
Prasyarat: Fase 01-03 selesai — Redis berjalan, config tersedia.

---

## Prompt 4.1 — Unified signal models dan dedup

```
Gunakan @web3-solana-scanner SKILL.md bagian "Unified Signal Format" dan "Deduplication".

Buat components/scanner/models.py:
- Enum SignalSource dengan semua 10 nilai:
  DEXSCREENER, GMGN, PUMPFUN, BIRDEYE, HELIUS_WEBHOOK, CIELO,
  KOL_WALLET, RUGCHECK, TWITTER, TELEGRAM
- Pydantic BaseModel untuk tiga jenis signal:
  NewTokenSignal: mint, symbol, source, liquidity_usdc, age_seconds, ts (epoch ms)
  TrendingSignal: mint, symbol, source, volume_1h_usdc, price_change_1h_pct, liquidity_usdc, ts
  WalletBuySignal: wallet, wallet_label, mint, symbol, amount_sol, tx_signature, source, ts
- Semua field amount menggunakan float (bukan Decimal — ini data inbound, bukan order)

Buat components/scanner/dedup.py:
async def is_duplicate(redis, source: str, mint: str, window_s: int) -> bool:
  - Key: scanner.seen.{source}.{mint}
  - Cek EXISTS, return True jika ada
  - SET dengan EX=window_s jika belum ada, return False
  - Window default: 300s untuk trending, 3600s untuk new token

async def publish_signal(redis, channel: str, signal: BaseModel) -> None:
  - Serialize signal ke JSON
  - PUBLISH ke channel
  - Log level DEBUG: "published {signal.mint[:8]} → {channel}"
```

---

## Prompt 4.2 — DEXScreener dan GMGN scanner

```
Gunakan @web3-solana-scanner references/dexscreener.md dan references/gmgn.md.

Buat components/scanner/dexscreener.py:

class DexScreenerScanner:
  - __init__(self, session, redis, settings)
  - async def run_new_pairs(self, stop_event) → task untuk scanner.token.new
    - Poll /latest/dex/pairs/solana setiap 10s
    - Filter: age_seconds < 300 (token baru < 5 menit), liquidity_usdc > 5000
    - Normalize ke NewTokenSignal
    - Dedup dengan window 3600s
    - Publish ke scanner.token.new
  - async def run_trending(self, stop_event) → task untuk scanner.token.trending
    - Poll /token-profiles/latest/v1 setiap 30s
    - Normalize ke TrendingSignal
    - Dedup dengan window 300s
    - Publish ke scanner.token.trending
  - Jika API error: log warning, sleep 30s, retry — JANGAN crash task

Buat components/scanner/gmgn.py:

class GmgnScanner:
  - __init__(self, session, redis, settings)
  - async def run_trending(self, stop_event) → task
    - Poll GMGN trending Solana tokens setiap 60s
    - Normalize ke TrendingSignal
    - Sertakan field: volume_1h_usdc, price_change_1h_pct, liquidity_usdc
    - Dedup 300s, publish ke scanner.token.trending
  - Error handling: log warning + sleep 60s pada setiap exception
```

---

## Prompt 4.3 — Pump.fun, Birdeye, dan Rugcheck scanner

```
Gunakan @web3-solana-scanner references/pumpfun.md, references/birdeye.md,
dan references/rugcheck.md.

Buat components/scanner/pumpfun.py:

class PumpFunScanner:
  - async def run_launches(self, stop_event)
    - Poll Pump.fun API untuk new token launches setiap 5s
    - Filter: bonding curve tidak selesai (graduation belum terjadi)
    - Normalize ke NewTokenSignal dengan age_seconds dari created_at
    - Dedup 3600s, publish ke scanner.token.new

Buat components/scanner/birdeye.py:

class BirdeyeScanner:
  - __init__(self, session, redis, settings)
  - async def run_trending(self, stop_event)
    - Poll Birdeye /defi/token_trending?chain=solana setiap 30s
    - Normalize ke TrendingSignal
    - Dedup 300s, publish ke scanner.token.trending

Buat components/scanner/rugcheck.py:

class RugcheckValidator:
  - __init__(self, session, settings)
  - async def is_safe(self, mint: str) -> tuple[bool, str]:
    - GET rugcheck.xyz/v1/tokens/{mint}/report/summary
    - Return (True, "") jika score > threshold
    - Return (False, reason) jika failed
    - Timeout: 5s — return (True, "timeout") jika lambat (fail open)
    - Ini on-demand validator, bukan continuous poller
```

---

## Prompt 4.4 — Helius webhook, KOL wallet, dan Cielo scanner

```
Gunakan @web3-solana-scanner references/helius.md, references/kol-wallet.md,
dan references/cielo.md.

Buat components/scanner/helius.py:

class HeliusWebhookScanner:
  - __init__(self, redis, settings)
  - async def start_webhook_server(self, stop_event)
    - aiohttp web server di port 8080 (atau dari config)
    - POST /webhook endpoint
    - Validasi HELIUS_WEBHOOK_SECRET dari header
    - Parse transaction events: filter hanya swap transactions
    - Untuk setiap swap yang melibatkan KOL wallet (cek state.kol.wallets di Redis):
      Normalize ke WalletBuySignal, dedup 60s, publish ke scanner.wallet.buy
  - Jika HELIUS_API_KEY kosong: log warning, skip — jangan crash bot

Buat components/scanner/kol_wallet.py:

class KolWalletScanner:
  - __init__(self, session, redis, rpc_client, settings)
  - async def run_poll(self, stop_event)
    - Setiap 15s: baca SET state.kol.wallets dari Redis
    - Untuk tiap wallet: getSignaturesForAddress (limit=5, commitment=confirmed)
    - Filter transaksi < 60s yang melibatkan SPL token swap
    - Normalize ke WalletBuySignal
    - Dedup 60s (tx_signature sebagai key tambahan)
    - Publish ke scanner.wallet.buy
  - Jika wallet list kosong: sleep 60s, log info

Buat components/scanner/cielo.py:

class CieloScanner:
  - __init__(self, session, redis, settings)
  - async def run_smart_money(self, stop_event)
    - Poll Cielo smart money feed setiap 30s
    - Normalize setiap entry ke WalletBuySignal dengan source=CIELO
    - Dedup 300s, publish ke scanner.wallet.buy
```

---

## Prompt 4.5 — Twitter dan Telegram scanner

```
Gunakan @web3-solana-scanner references/twitter.md dan references/telegram.md.

Buat components/scanner/twitter.py:

class TwitterScanner:
  - __init__(self, session, redis, settings)
  - async def run_mentions(self, stop_event)
    - Poll Twitter/X API v2 recent search setiap 60s
    - Query: crypto/Solana token mentions dengan high engagement
    - Extract mint addresses dari tweet text (regex: base58 44 chars)
    - Normalize ke TrendingSignal dengan source=TWITTER
    - Dedup 300s, publish ke scanner.token.trending
  - Jika TWITTER_BEARER_TOKEN kosong: log info "Twitter scanner disabled", return

Buat components/scanner/telegram.py:

class TelegramScanner:
  - __init__(self, redis, settings)
  - async def run_listener(self, stop_event)
    - Gunakan Telethon untuk listen ke alpha channels yang dikonfigurasi
    - Channel list dari Redis key: config.scanner.telegram_channels (JSON array)
    - Extract mint addresses dari pesan menggunakan regex
    - Normalize ke NewTokenSignal dengan source=TELEGRAM
    - Dedup 3600s, publish ke scanner.token.new
  - Jika TELEGRAM_API_ID/HASH kosong: log info "Telegram scanner disabled", return
  - Handle FloodWaitError: sleep sesuai durasi yang diminta Telegram
```

---

## Prompt 4.6 — Scanner runner (wiring semua tasks)

```
Gunakan @web3-solana-engine references/scanner-runner.md.
Gunakan @web3-solana-architecture bagian "Component Responsibilities".

Buat components/scanner/runner.py:

class ScannerRunner:
  - __init__(self, redis, pool, session, rpc_client, settings)
  - Instansiasi semua 9 scanner classes di __init__

  async def start(self, stop_event: asyncio.Event) -> list[asyncio.Task]:
    - Spawn semua scanner sebagai named asyncio tasks:
      asyncio.create_task(scanner.run_new_pairs(stop_event),   name="scanner.dexscreener.new")
      asyncio.create_task(scanner.run_trending(stop_event),    name="scanner.dexscreener.trending")
      asyncio.create_task(gmgn.run_trending(stop_event),       name="scanner.gmgn")
      asyncio.create_task(pumpfun.run_launches(stop_event),    name="scanner.pumpfun")
      asyncio.create_task(birdeye.run_trending(stop_event),    name="scanner.birdeye")
      asyncio.create_task(helius.start_webhook_server(stop_event), name="scanner.helius")
      asyncio.create_task(kol.run_poll(stop_event),            name="scanner.kol_wallet")
      asyncio.create_task(cielo.run_smart_money(stop_event),   name="scanner.cielo")
      asyncio.create_task(twitter.run_mentions(stop_event),    name="scanner.twitter")
      asyncio.create_task(telegram.run_listener(stop_event),   name="scanner.telegram")
    - Return list of tasks (untuk cancel di shutdown)
    - Log: "Scanner started: {len(tasks)} tasks"

  async def stop(self, tasks: list[asyncio.Task]) -> None:
    - Cancel semua tasks
    - await asyncio.gather(*tasks, return_exceptions=True)
    - Log: "Scanner stopped"
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/scanner/models.py — 3 signal models, 10 SignalSource
- [ ] components/scanner/dedup.py — is_duplicate, publish_signal
- [ ] components/scanner/dexscreener.py — new pairs + trending
- [ ] components/scanner/gmgn.py — trending
- [ ] components/scanner/pumpfun.py — new launches
- [ ] components/scanner/birdeye.py — trending
- [ ] components/scanner/rugcheck.py — on-demand validator
- [ ] components/scanner/helius.py — webhook server
- [ ] components/scanner/kol_wallet.py — RPC polling
- [ ] components/scanner/cielo.py — smart money
- [ ] components/scanner/twitter.py — mentions (disabled jika no token)
- [ ] components/scanner/telegram.py — alpha channels (disabled jika no creds)
- [ ] components/scanner/runner.py — wiring semua tasks dengan nama
