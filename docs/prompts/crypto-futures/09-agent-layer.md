# Phase 09 — Agent Confirmation Layer

> **Optional** — This phase requires the `crypto-futures-agent` skill.
> Complete Phase 01–08 first. The bot must be running end-to-end before adding the agent layer.

Tujuan: Tambahkan `AgentConfirmer` sebagai confirmation gate antara `StrategyWorker` dan
`RiskManager`. Rule-based strategies tetap berjalan — agent hanya memfilter sinyal
di zona confidence menengah (pre_signal_threshold ≤ score < signal_threshold).

Prasyarat: Phase 01–08 selesai, bot berjalan di testnet dengan minimal satu symbol aktif.

---

## Prompt 9.1 — AgentConfig + provider setup

```
Gunakan @crypto-futures-agent untuk konteks lengkap.

State project saat ini:
- bot_engine/config.py sudah ada dengan Settings class (Pydantic Settings)
- bot_engine/components/ sudah berisi semua komponen engine

Tambahkan ke bot_engine/config.py:

1. Class AgentConfig(BaseSettings):
   Fields:
   - agent_enabled: bool = True
   - agent_provider: str = "groq"               # primary provider
   - agent_fallback_chain: list[str] = ["openrouter", "deepseek"]
   - agent_pre_signal_threshold: float = 0.4    # publish pre-signal jika score >= ini
   - agent_passthrough_on_fail: bool = True      # jika LLM gagal, forward signal
   - agent_timeout_seconds: int = 20
   - anthropic_model: str = "claude-haiku-4-5-20251001"
   - [semua *_api_keys fields: list[str] = []]

   Implement model_post_init yang load key pools dari env var:
   - GROQ_API_KEY_1, GROQ_API_KEY_2, GROQ_API_KEY_3, ...
   - OPENROUTER_API_KEY_1, ...
   - DEEPSEEK_API_KEY_1, ...
   - GEMINI_API_KEY_1, ...
   - QWEN_API_KEY_1, ...
   - OPENAI_API_KEY_1, ...
   - ANTHROPIC_API_KEY_1, ...
   Pattern: loop i=1,2,3... sampai env var tidak ditemukan.

   Method get_keys(provider) -> list[str]
   Method build_api_keys(provider) -> list[APIKey]

2. Buat folder bot_engine/components/agent/ dengan files:
   - __init__.py (kosong)
   - providers.py   (APIKey, ProviderConfig, PROVIDER_REGISTRY, LLMResponse, ToolCall,
                     OpenAICompatibleClient, AnthropicClient, build_client)
   - key_pool.py    (KeyPoolManager, ProviderRouter)
   - tools.py       (CONFIRMER_TOOLS, ToolExecutor)
   - prompts.py     (build_system_prompt, build_pre_signal_message)

   Gunakan @crypto-futures-agent references/ untuk implementasi lengkap masing-masing file.

3. Tambahkan ke .env.example:
   # Agent Layer (optional — skip jika tidak pakai AI confirmation)
   AGENT_ENABLED=true
   AGENT_PROVIDER=groq
   AGENT_FALLBACK_CHAIN=openrouter,deepseek
   AGENT_PRE_SIGNAL_THRESHOLD=0.4
   AGENT_PASSTHROUGH_ON_FAIL=true
   AGENT_TIMEOUT_SECONDS=20
   GROQ_API_KEY_1=
   GROQ_API_KEY_2=
   OPENROUTER_API_KEY_1=
   DEEPSEEK_API_KEY_1=
   GEMINI_API_KEY_1=
```

---

## Prompt 9.2 — AgentConfirmer component

```
Gunakan @crypto-futures-agent references/agent-confirmer.md.

Buat bot_engine/components/agent_confirmer.py:

Class AgentConfirmer:
  STREAM_IN  = "stream.pre_signals"
  STREAM_OUT = "stream.signals"
  GROUP      = "agent_confirmer"

  __init__(redis, agent_config):
    - Instantiate ProviderRouter(redis, agent_config)
    - Instantiate ToolExecutor(redis)
    - self._locks: dict[str, asyncio.Lock] = {}  # per-symbol lock

  run(stop_event):
    - Jika agent_enabled=False: log dan return
    - xgroup_create stream.pre_signals (mkstream=True, ignore if exists)
    - Loop: xreadgroup count=5 block=2000
    - Per message: create_task(_handle(msg_id, fields))
    - gather dengan return_exceptions=True

  _handle(msg_id, fields):
    - Cek state.position.{symbol} — jika ada, xack dan return
    - Acquire symbol lock
    - Panggil _confirm_and_forward(symbol, fields)
    - xack

  _confirm_and_forward(symbol, fields):
    - Build messages: system_prompt + pre_signal_message
    - Panggil _run_tool_loop(messages, pre_signal)
    - Jika None dan passthrough_on_fail: publish ke stream.signals
    - Jika approve: merge refined SL/TP jika ada, pop "context", publish
    - Jika reject: log reason

  _run_tool_loop(messages, pre_signal):
    - Max 3 rounds
    - Tiap round: router.call(messages, CONFIRMER_TOOLS)
    - Jika tool call = approve/reject: return decision dict
    - Jika tool call = get_market_context: fetch via tool_executor.fetch_context,
      append tool result ke messages, lanjut round berikutnya
    - Return None jika max rounds tercapai

Semua nilai SL/TP dari agent harus divalidasi via _safe_decimal() sebelum dipakai.
```

---

## Prompt 9.3 — StrategyWorker dual-threshold

```
Gunakan @crypto-futures-agent references/agent-confirmer.md (bagian StrategyWorker Modification).
Gunakan @crypto-futures-bot-engine references/strategy-worker.md untuk konteks kode yang ada.

Modifikasi StrategyWorker._evaluate_and_publish() untuk dual-threshold publishing:

Config keys baru di config.worker.{symbol} (baca dari Redis seperti config lainnya):
  signal_threshold:     float = 0.6   # existing — publish langsung ke stream.signals
  pre_signal_threshold: float = 0.4   # new — publish ke stream.pre_signals untuk agent

Logic:
  score = result["score"]
  signal_threshold = float(config.get("signal_threshold", 0.6))
  pre_signal_threshold = float(config.get("pre_signal_threshold", 0.4))
  agent_enabled = config.get("agent_enabled", "false").lower() == "true"

  if score >= signal_threshold:
      # High confidence — bypass agent
      await self.redis.xadd("stream.signals", result)

  elif agent_enabled and score >= pre_signal_threshold:
      # Medium confidence — send to agent
      context = self._build_context(symbol, df, result)
      pre_signal = {**result, "context": json.dumps(context)}
      await self.redis.xadd("stream.pre_signals", pre_signal)

  # score < pre_signal_threshold → discard

Helper _build_context(symbol, df, result) -> dict:
  Ambil dari df dan result:
  - ema9, ema21, ema50 (iloc[-1])
  - rsi (iloc[-1])
  - cvd_delta: dari result jika ada, atau 0
  - volume_ratio: volume[-1] / volume[-20:].mean()
  - funding_rate: dari result["context"] jika ada
  - funding_percentile: dari result["context"] jika ada
  - liq_long_5m: dari result["context"] jika ada
  - liq_short_5m: dari result["context"] jika ada
  Return sebagai dict (bukan string — caller yang json.dumps)

PENTING: Jika agent_enabled=False di config.worker.{symbol},
pre_signal tidak pernah di-publish. Backward compatible dengan bot yang tidak pakai agent.
```

---

## Prompt 9.4 — main.py wiring

```
Gunakan @crypto-futures-agent references/agent-confirmer.md (bagian main.py Integration).
Gunakan @crypto-futures-bot-engine references/main-process.md untuk konteks yang ada.

Update bot_engine/main.py:

1. Import:
   from config import AgentConfig
   from components.agent_confirmer import AgentConfirmer

2. Di shared components block (setelah redis init):
   agent_config = AgentConfig()
   agent_confirmer = AgentConfirmer(redis=redis, agent_config=agent_config)

3. Di tasks list:
   asyncio.create_task(agent_confirmer.run(stop_event), name="agent_confirmer")

4. Tidak ada perubahan shutdown order — AgentConfirmer tidak memegang order lock,
   bisa di-cancel kapan saja.

Pastikan AgentConfig di-load dengan fail-fast jika provider dipilih tapi tidak ada key:
  if agent_config.agent_enabled and not agent_config.get_keys(agent_config.agent_provider):
      if not agent_config.agent_passthrough_on_fail:
          raise ValueError(f"Agent enabled but no keys for provider '{agent_config.agent_provider}'")
      else:
          logger.warning("Agent enabled but no keys configured — will passthrough all signals")
```

---

## Prompt 9.5 — Testing agent layer

```
Gunakan @crypto-futures-agent untuk konteks.

Verifikasi agent layer berfungsi di testnet:

1. Set di config.worker.{symbol} via Redis:
   redis-cli set config.worker.BTCUSDT '{"strategy":"trend","signal_threshold":0.9,"pre_signal_threshold":0.3,"agent_enabled":"true"}'
   (signal_threshold sangat tinggi agar semua sinyal masuk ke pre_signal path)

2. Monitor streams:
   redis-cli xread count 10 streams stream.pre_signals 0
   redis-cli xread count 10 streams stream.signals 0

3. Monitor key pool stats (tambahkan endpoint atau log):
   Log di AgentConfirmer._confirm_and_forward() harus menunjukkan:
   [agent_confirmer] BTCUSDT long (trend) — calling LLM
   [provider_router] groq[0] ok, tokens=742
   [agent_confirmer] BTCUSDT APPROVED confidence=0.72 | EMA stack aligned...

4. Test passthrough: set AGENT_ENABLED=false di .env, restart.
   Semua sinyal harus langsung ke stream.signals tanpa melalui agent.

5. Test fallback: set GROQ_API_KEY_1 ke value invalid.
   Provider harus fallback ke OPENROUTER_API_KEY_1.
   Jika semua habis: passthrough (jika AGENT_PASSTHROUGH_ON_FAIL=true).

6. Check key pool stats via AgentConfirmer.stats() atau langsung Redis:
   redis-cli keys "llm.pool.*"
```

---

## Roadmap

Selesai? Tandai di `docs/ROADMAP.md` → Phase 1 › Core Bot Engine (optional):

- [ ] AgentConfirmer: LLM-based signal confirmation gate
- [ ] Multi-provider key pool (Groq, OpenRouter, DeepSeek)
