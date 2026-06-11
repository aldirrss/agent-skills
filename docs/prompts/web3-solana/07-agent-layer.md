# Fase 07 — Agent Layer / LLM Scoring (Layer 2, Opsional)

Tujuan: AgentConfirmer sebagai LLM scoring layer antara Strategy dan RiskManager.
Aktif hanya jika AGENT_ENABLED=true. Default: disabled.
Prasyarat: Fase 05-06 selesai — stream.signals.raw dan stream.signals sudah ada.

---

## Prompt 7.1 — AgentConfirmer core

```
Gunakan @web3-solana-agent secara lengkap, termasuk semua references/.
Gunakan @web3-solana-architecture untuk stream routing (signals.raw → signals).

Prinsip utama sebelum mulai:
- AGENT_ENABLED=false adalah default. Bot harus berfungsi penuh tanpa agent.
- Fail open: jika Claude timeout atau error, signal pass through dengan confidence original.
- SELL signals bypass LLM sepenuhnya — exit harus cepat.
- LLM hanya menyumbang 30% dari confidence final.

Buat components/agent_confirmer.py:

class AgentConfirmer:
  - Consumer group: agent-group / agent-confirmer-1
  - Baca dari stream.signals.raw
  - Output ke stream.signals (sama dengan output Strategy jika agent disabled)

  Untuk BUY signal:
    1. Cek cache: GET llm.score.{mint} (TTL 300s)
       Jika hit → gunakan cached score, skip LLM call
    2. Jika cache miss:
       a. Hitung prompt hash dari: mint + strategy + signal_sources + price_bucket + liquidity_bucket
       b. Cek llm.cache.{hash} (TTL 600s) — deduplicate identical prompts
       c. Jika cache miss: panggil Claude dengan timeout sesuai strategy
          AGENT_TIMEOUTS: new_launch_snipe=2s, kol_copy_trade=5s, lainnya=8s
       d. Parse response → float score 0.0-1.0
       e. Simpan ke llm.score.{mint} (TTL 300s) dan llm.cache.{hash} (TTL 600s)
    3. Kalkulasi: final_confidence = original_confidence * 0.7 + llm_score * 100 * 0.3
    4. Re-publish ke stream.signals dengan:
       - confidence = str(int(final_confidence))
       - llm_scored = "true"
       - llm_score = str(llm_score)

  Untuk SELL signal:
    - Pass through langsung ke stream.signals tanpa LLM call
    - Tambahkan llm_scored = "false"

  Jika LLM error/timeout:
    - Log warning dengan error message
    - Pass through dengan confidence original, llm_scored="false"
    - JANGAN drop signal atau raise exception

  XACK stream.signals.raw setelah setiap message.
```

---

## Prompt 7.2 — Prompt design untuk scoring

```
Gunakan @web3-solana-agent references/prompt-design.md.
Gunakan @claude-api untuk implementasi Anthropic SDK dengan prompt caching.

Buat components/agent_prompts.py:

SYSTEM_PROMPT = """
Kamu adalah AI analyst untuk Solana DEX trading bot. Tugasmu mengevaluasi
kualitas sinyal trading berdasarkan data yang diberikan dan memberikan skor
0.0 sampai 1.0.

Skor 0.0 = sangat berisiko / kemungkinan scam atau rug pull
Skor 0.5 = sinyal netral, tidak ada tanda bahaya jelas
Skor 1.0 = sinyal sangat kuat dengan multiple konfirmasi berkualitas

Faktor yang dievaluasi:
1. Narrative strength: adakah cerita nyata di balik token ini?
2. Social signal quality: organik (wallet activity, on-chain) atau dibuat-buat (Telegram call saja)?
3. Red flags: liquidity tipis, holder konsentrasi, KOL tanpa wallet backing?

Respons HANYA dengan JSON: {"score": 0.0} — tidak ada teks lain.
"""

def build_scoring_prompt(signal_data: dict) -> str:
  - Buat user prompt dari signal_data:
    Token: {symbol} ({mint[:8]}...)
    Strategy: {strategy}
    Confidence pre-LLM: {confidence}
    Signal sources: {sources}
    Liquidity: ${liquidity_usdc:,.0f}
    Signal age: {age_seconds}s

Buat components/agent_client.py:

class AgentClient:
  - __init__(self, settings)
  - Gunakan anthropic.AsyncAnthropic
  - System prompt dengan cache_control untuk prompt caching (~90% token savings)

  async def score_signal(self, signal_data: dict, timeout_s: float) -> float:
    - Buat prompt menggunakan build_scoring_prompt
    - Call claude-haiku-4-5 (atau AGENT_MODEL dari config)
    - max_tokens = 30 (response tiny: {"score": 0.7})
    - Parse JSON response → extract "score" field
    - Clamp ke 0.0-1.0
    - Jika parsing gagal: return 0.5 (netral — fail safe)
    - Timeout: asyncio.wait_for dengan timeout_s dari AGENT_TIMEOUTS

  Gunakan prompt caching dengan cache_control pada system prompt:
  messages=[{"role": "user", "content": [{"type": "text", "text": prompt}]}]
  system=[{"type": "text", "text": SYSTEM_PROMPT,
           "cache_control": {"type": "ephemeral"}}]
```

---

## Prompt 7.3 — Integrasi ke engine

```
Gunakan @web3-solana-agent references/integration.md.

Update main.py untuk support agent layer:

1. Baca AGENT_ENABLED dari settings
2. Jika AGENT_ENABLED=true:
   - Instansiasi AgentClient(settings)
   - Instansiasi AgentConfirmer(redis, agent_client, settings)
   - Spawn sebagai named task: "agent.confirmer"
   - Strategy publish ke stream.signals.raw (bukan stream.signals langsung)
   - AgentConfirmer forward ke stream.signals setelah scoring

3. Jika AGENT_ENABLED=false (default):
   - Strategy publish langsung ke stream.signals
   - stream.signals.raw tidak digunakan

Perubahan di components/strategy/confluence.py → publish_buy_signal():
  - Terima parameter agent_enabled: bool
  - Jika True: XADD stream.signals.raw
  - Jika False: XADD stream.signals

Tambahkan ke .env.example:
  AGENT_ENABLED=false
  ANTHROPIC_API_KEY=    # hanya dibutuhkan jika AGENT_ENABLED=true
  AGENT_MODEL=claude-haiku-4-5  # fastest/cheapest untuk scoring

Catatan di komentar kode:
  "AgentConfirmer hanya enrichment — tidak pernah memblokir trading.
   Timeout atau error = signal pass through dengan confidence original."
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/agent_confirmer.py — BUY scoring, SELL passthrough, fail-open
- [ ] components/agent_prompts.py — system prompt, build_scoring_prompt
- [ ] components/agent_client.py — Anthropic SDK dengan prompt caching
- [ ] main.py diupdate — routing stream berdasarkan AGENT_ENABLED
- [ ] Test: AGENT_ENABLED=false → bot berjalan normal tanpa agent
- [ ] Test: AGENT_ENABLED=true dengan API key valid → score muncul di logs
