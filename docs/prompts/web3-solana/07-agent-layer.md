# Fase 07 — SignalAggregator (GATE 1) + OrchestratorAgent (GATE 2)

Tujuan: Dua gate wajib antara Strategy dan RiskManager.
- **GATE 1** (SignalAggregator): composite scoring, top-15 batch dispatch, circuit breaker
- **GATE 2** (OrchestratorAgent): 4 LLM sub-agents parallel via litellm, score ≥ 80

Prasyarat: Fase 05-06 selesai — stream.signals sudah aktif.

---

## Prompt 7.1 — SignalAggregator

```
Gunakan @web3-solana-signal-aggregator secara lengkap, termasuk references/signal-aggregator.md.

Buat components/signal_aggregator.py.

Poin kunci:
- Consumer group: aggregator-group / aggregator-1 pada stream.signals
- Track match per mint via signal.match.{mint} (Hash, TTL 900s)
- Gate: minimal 2 strategy match dengan window per strategy sesuai skill
- Ranking top-15: score = match_count×30 + strategy_weight_bonus + recency_bonus
- Cek circuit breaker sebelum dispatch (keduanya skip seluruh batch jika true):
  · state.bot.status != "running" → skip (covers pause + daily loss/profit cap)
  · len(state.position.*) >= config.risk.max_concurrent_positions → skip (posisi penuh, hemat LLM budget)
- Output: XADD stream.agent.eligible { batch_id, mints: JSON list }
```

---

## Prompt 7.2 — KeyPoolManager

```
Gunakan @web3-solana-agent references/key-pool.md.

Buat components/key_pool.py.

Constraint wajib:
- Setiap agent punya primary provider + ordered fallback chain (DEFAULT_AGENT_PROVIDER_CHAIN)
- Minimum 3 keys hanya wajib untuk PRIMARY provider — raise ValueError di __init__ jika kurang
- Fallback providers bersifat opsional — dilewati jika tidak ada keys
- Rotasi round-robin per provider: token_index % len(keys)
- Baca dari settings/env: GROQ_API_KEYS, GEMINI_API_KEYS, OPENROUTER_API_KEYS (comma-separated)
- provider_chain_for_agent(agent_name) → list[list[ProviderKey]]
- primary_key_for_agent(agent_name, token_index) → ProviderKey
- semaphore_for_key(api_key) → asyncio.Semaphore (max_concurrent_per_key=2, configurable)
- agents_for_strategy(strategy) → list[str] dari STRATEGY_REQUIRED_AGENTS
- normalize_weights(required_agents) → dict[str, float] yang sum ke 1.0
```

---

## Prompt 7.3 — OrchestratorAgent + 4 sub-agents

```
Gunakan @web3-solana-agent secara lengkap, termasuk:
  references/types.md, references/orchestrator.md,
  references/sub-agents.md, references/prompt-design.md.

Buat:
  components/agents/types.py         ← AgentScore, TokenContext
  components/agents/base.py          ← BaseAgent abstract class
  components/agents/market.py
  components/agents/safety.py
  components/agents/risk.py
  components/agents/social.py
  components/orchestrator_agent.py

Poin kunci:
- Consumer group: orchestrator-group / orchestrator-1 pada stream.agent.eligible
- 4 sub-agents dijalankan parallel via asyncio.gather
- AGENT_WEIGHTS = {market: 0.25, safety: 0.30, risk: 0.25, social: 0.20}
- Gate threshold: final_score ≥ 80 → XADD stream.agent.approved
- Provider: Groq untuk market/safety/risk, Gemini Flash untuk social (via litellm)
- Response format: SCORE:/REASON: (plain text, bukan JSON)
- Fail-open: agent timeout/error → score sub-agent = 50 (netral), tetap lanjut
- Per-strategy agent selection: tanya key_pool.agents_for_strategy(strategy) sebelum dispatch
  → skip agents yang tidak dibutuhkan (contoh: new_launch_snipe skip Social untuk hemat 8s)
- Weight renormalization: gunakan normalize_weights(required_agents) bukan AGENT_WEIGHTS raw
  → final_score = sum(scores[a] * weights[a] for a in required_agents)
- Semaphore pada setiap LLM call: async with key_pool.semaphore_for_key(key.api_key)
- LLM cache: cek llm.score.{mint} (TTL 300s) sebelum panggil LLM — skip scoring jika hit
```

---

## Prompt 7.4 — Integrasi ke engine

```
Gunakan @web3-solana-agent references/integration.md.

Update main.py dan components/redis_helpers.py:

1. ensure_consumer_groups — ganti/tambah:
   stream.signals        → aggregator-group   (ganti risk-group yang lama)
   stream.agent.eligible → orchestrator-group
   stream.agent.approved → risk-group

2. Startup sequence:
   - Instansiasi KeyPoolManager(settings) sebelum komponen lain
     → bot berhenti di sini jika < 3 keys per provider
   - Instansiasi SignalAggregator(redis, settings)
   - Instansiasi OrchestratorAgent(redis, key_pool, settings)
   - Spawn sebagai named tasks: "signal.aggregator", "agent.orchestrator"

3. Shutdown sequence — tambahkan setelah Scanner+Strategy stop:
   - Wait SignalAggregator drain (max 5s)
   - Wait OrchestratorAgent selesai batch LLM aktif (max 60s)

Update .env.example — ganti section AGENT LAYER:
  # === AGENT LAYER (litellm multi-provider, wajib min 3 keys per provider) ===
  GROQ_API_KEYS=key1,key2,key3        # market / safety / risk agents
  GEMINI_API_KEYS=key1,key2,key3      # social agent
```

---

## Roadmap

Selesai? Tandai progress:

- [ ] components/signal_aggregator.py — aggregator-group, ranking top-15, dispatch batch
- [ ] components/key_pool.py — round-robin, fail-fast min 3 keys
- [ ] components/agents/types.py — AgentScore, TokenContext
- [ ] components/agents/base.py, market.py, safety.py, risk.py, social.py
- [ ] components/orchestrator_agent.py — 4 parallel agents, gate ≥ 80
- [ ] main.py + redis_helpers.py diupdate — consumer groups benar, wiring kedua GATE
- [ ] .env.example diupdate — GROQ_API_KEYS, GEMINI_API_KEYS
- [ ] Test: inject ke stream.signals → muncul di stream.agent.approved jika score ≥ 80
- [ ] Test: GROQ_API_KEYS hanya 2 key → bot tidak start, ValueError jelas
