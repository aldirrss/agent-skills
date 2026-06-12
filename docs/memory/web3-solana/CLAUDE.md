# Solana DEX Trading Bot — Claude Code Rules

Baca file ini sebelum menulis kode apapun untuk proyek ini.

---

## Non-Negotiable Safety Rules

1. **Private key tidak pernah keluar dari `Execution`** — Keypair hanya di `__init__` Execution,
   tidak pernah di-pass ke komponen lain, tidak pernah di-log, tidak pernah di-serialize
2. **DRY_RUN=true default** — setiap kode baru harus bisa jalan tanpa transaksi nyata
3. **Slippage wajib non-zero** — tidak ada swap tanpa `slippage_bps` eksplisit
4. **Cek on-chain sebelum retry** — jangan kirim ulang transaksi tanpa verifikasi on-chain
5. **Semua amounts monetary = Decimal** — bukan float, kecuali data inbound dari API

---

## Pipeline (urutan wajib, tidak boleh diubah)

```
stream.signals → SignalAggregator (GATE 1) → stream.agent.eligible
             → OrchestratorAgent (GATE 2) → stream.agent.approved
             → RiskManager (BUY path)     → stream.swaps
             → Execution                  → stream.fills
```

SELL path: `stream.signals` → RiskManager langsung (bypass GATE 1 & 2).

---

## Consumer Groups (jangan diubah)

| Stream | Group | Komponen |
|---|---|---|
| stream.signals | aggregator-group | SignalAggregator |
| stream.signals | risk-sell-group | RiskManager (SELL only) |
| stream.agent.eligible | orchestrator-group | OrchestratorAgent |
| stream.agent.approved | risk-group | RiskManager (BUY) |
| stream.swaps | exec-group | Execution |
| stream.fills | tracker-group | PositionTracker |
| stream.fills | db-group | DBWriter |
| stream.commands | cmd-group | CommandListener |

---

## TP/SL Code Constants (tidak boleh di-config)

```python
TAKE_PROFIT_PCT = Decimal("1.0")   # 2× entry

SL_TIERS = [
    (500_000, Decimal("0.15")),
    ( 50_000, Decimal("0.20")),
    ( 10_000, Decimal("0.30")),
    (      0, Decimal("0.40")),
]
```

**config.risk tidak boleh punya `stop_loss_pct` atau `take_profit_pct`.**

---

## Agent Layer Rules

- `KeyPoolManager` diinstansiasi pertama kali di `main.py` — jika < 3 keys per provider,
  bot tidak start (`ValueError` di `__init__`)
- `OrchestratorAgent` wajib berjalan — tidak ada flag `AGENT_ENABLED`
- Gate threshold: `final_score ≥ 80` untuk lolos ke `stream.agent.approved`
- Fail-open: agent timeout/error → score sub-agent = 50, bot tetap lanjut
- Response format sub-agent: `SCORE: 75\nREASON: ...` (bukan JSON)

---

## Redis Naming Conventions

- State: `state.{entity}.{identifier}` → `state.position.{mint}`, `state.bot.status`
- Config: `config.{domain}` → `config.risk`, `config.strategy`
- Stats: `stats.{metric}` → `stats.daily_pnl`, `stats.wins.{strategy}`
- Signal tracking: `signal.match.{mint}` (Hash, TTL 900s)
- LLM cache: `llm.score.{mint}` (TTL 300s)

---

## PositionTracker Rule

PositionTracker **tidak boleh** menghitung SL/TP. Nilai `stop_loss_price` dan
`take_profit_price` dibaca langsung dari `fill.get("stop_loss_price")` — sudah
dihitung oleh RiskManager saat approval dan diteruskan melalui `stream.swaps` → `stream.fills`.

---

## Logging

- Semua komponen menggunakan `logger.bind(component="name")` — bukan bare `logger`
- Jangan log: `WALLET_KEYPAIR_B64`, `GROQ_API_KEYS`, `GEMINI_API_KEYS`
- Trade outcome selalu di-log: `symbol`, `pnl_usdc`, `pnl_pct`, `reason`

---

## Skills yang Relevan

Gunakan `@web3-solana-architecture` untuk Redis topology dan stream schema.
Gunakan `@web3-solana-risk` untuk TP/SL constants dan position sizing.
Gunakan `@web3-solana-agent` untuk OrchestratorAgent dan KeyPoolManager detail.
Gunakan `@web3-solana-signal-aggregator` untuk GATE 1 logic.
Gunakan `@web3-solana` untuk semua safety rules Solana on-chain.
