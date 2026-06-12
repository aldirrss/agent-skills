# Redis Topology

## Stream Schema

### `stream.signals`
Published by **Strategy**, consumed by **SignalAggregator**.
```json
{
  "signal_id":     "sig_abc123",
  "mint":          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol":        "BONK",
  "action":        "BUY",
  "strategy":      "kol_copy_trade",
  "confidence":    "0.82",
  "liquidity_usdc": "450000",
  "price_usdc":    "0.00001234",
  "ts":            "1718000000000"
}
```

SELL signals also use this stream and are passed through SignalAggregator directly to
`stream.agent.approved` (no scoring needed for exit signals).

---

### `stream.agent.eligible`
Published by **SignalAggregator** (GATE 1), consumed by **OrchestratorAgent**.
One message per batch of top-N candidate mints.
```json
{
  "batch_id": "batch_20240601_abc",
  "mints":    "[\"mint1\", \"mint2\", \"mint3\"]"
}
```
`mints` is a JSON-encoded list of mint address strings (up to 15).

---

### `stream.agent.approved`
Published by **OrchestratorAgent** (GATE 2, score ≥ 80), consumed by **RiskManager**.
One message per approved mint.
```json
{
  "mint":          "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "final_score":   "84.5",
  "market_score":  "88.0",
  "safety_score":  "91.0",
  "risk_score":    "79.0",
  "social_score":  "75.0",
  "reasoning":     "{\"market\": \"...\", \"safety\": \"...\", \"risk\": \"...\", \"social\": \"...\"}",
  "batch_id":      "batch_20240601_abc"
}
```
SELL passthroughs from SignalAggregator also appear here with `action=SELL` and no score fields.

---

### `stream.swaps`
Published by **RiskManager**, consumed by **Execution**.
```json
{
  "swap_id":           "swp_xyz789",
  "signal_id":         "sig_abc123",
  "mint":              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol":            "BONK",
  "side":              "BUY",
  "amount_usdc":       "50.00",
  "slippage_bps":      "100",
  "stop_loss_price":   "0.00001048",
  "take_profit_price": "0.00001850",
  "entry_price":       "0.00001233",
  "strategy":          "kol_copy_trade",
  "ts":                "1718000000100"
}
```

---

### `stream.fills`
Published by **Execution**, consumed by **PositionTracker** + **DBWriter**.
```json
{
  "fill_id":           "fill_111",
  "swap_id":           "swp_xyz789",
  "mint":              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol":            "BONK",
  "side":              "BUY",
  "status":            "confirmed",
  "tx_signature":      "5KZ...abc",
  "amount_in_usdc":    "50.00",
  "amount_out_tokens": "4056000",
  "price_usdc":        "0.00001233",
  "fee_sol":           "0.000005",
  "ts":                "1718000001200"
}
```
`status` values: `confirmed` | `failed` | `timeout`

---

### `stream.commands`
Published externally (CLI / API), consumed by **CommandListener**.
```json
{
  "cmd":     "START | STOP | PAUSE | RESUME | EMERGENCY_STOP | ADD_TOKEN | REMOVE_TOKEN",
  "payload": {},
  "ts":      "1718000000000"
}
```

---

## Pub/Sub Channels

### `scanner.token.new`
New token detected (just launched on Raydium / Pump.fun).
```json
{
  "mint":           "...",
  "symbol":         "NEWTOKEN",
  "source":         "dexscreener | gmgn | pumpfun",
  "age_seconds":    45,
  "liquidity_usdc": "28000",
  "ts":             "1718000000000"
}
```

### `scanner.token.trending`
Existing token showing momentum (volume spike, holder growth).
```json
{
  "mint":               "...",
  "symbol":             "BONK",
  "source":             "gmgn",
  "volume_1h_usdc":     "1200000",
  "price_change_1h_pct": 18.5,
  "ts":                 "1718000000000"
}
```

### `scanner.wallet.buy`
KOL wallet executed a buy.
```json
{
  "wallet":       "ABcD...1234",
  "wallet_label": "sol_whale_1",
  "mint":         "...",
  "symbol":       "BONK",
  "amount_sol":   "10.5",
  "tx_signature": "...",
  "ts":           "1718000000000"
}
```

### `position.updates`
Published by **PositionTracker** after every fill or PnL update.
```json
{
  "mint":          "...",
  "symbol":        "BONK",
  "side":          "LONG",
  "entry_price":   "0.00001233",
  "current_price": "0.00001450",
  "amount_tokens": "4056000",
  "pnl_usdc":      "8.80",
  "pnl_pct":       17.6,
  "ts":            "1718000000000"
}
```

---

## Redis Keys

### Bot & Config State

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `state.bot.status` | String | none | CommandListener | `running` / `paused` / `stopped` |
| `state.bot.tokens` | Set | none | CommandListener | Active mint addresses being tracked |
| `state.kol.wallets` | Set | none | CommandListener | KOL wallet addresses to track |
| `config.strategy` | String (JSON) | none | CommandListener | Strategy parameters |
| `config.risk` | String (JSON) | none | CommandListener | Risk parameters |

### Position & Price State (per mint)

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `state.position.{mint}` | String (JSON) | none | PositionTracker | Current open position (set after fill confirmed) |
| `state.position.inflight.{mint}` | String | 120 s | RiskManager | Set before XADD stream.swaps; cleared by PositionTracker on fill; TTL guards against crash |
| `state.price.{mint}` | String (JSON) | 60 s | Scanner | Latest price, market cap, volume, liquidity, 1h change |
| `state.token.{mint}` | String (JSON) | 300 s | Scanner | Token metadata: holder_count, age_minutes |
| `state.safety.{mint}` | String (JSON) | 300 s | Scanner | Safety data: rugcheck_score, is_honeypot, liquidity_locked, top_holder_pct |
| `state.social.{mint}` | String (JSON) | 300 s | Scanner | Social data: kol_buy_count, telegram_mentions, twitter_sentiment, narrative |

### SignalAggregator Keys

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `signal.match.{mint}` | Hash | 900 s | SignalAggregator | strategy_name → timestamp of last match |
| `agent.queue` | ZSet | none | SignalAggregator | mint → composite_score; cleared after each dispatch |

### Agent Layer Keys

| Key | Type | TTL | Written by | Description |
|---|---|---|---|---|
| `llm.score.{mint}` | String (JSON) | 300 s | OrchestratorAgent | Cached scoring result to avoid duplicate LLM calls |

---

## Consumer Groups

Every stream uses a Redis consumer group for at-least-once delivery:

| Stream | Group | Consumer | Reader |
|---|---|---|---|
| `stream.signals` | `aggregator-group` | `aggregator-1` | SignalAggregator |
| `stream.agent.eligible` | `orchestrator-group` | `orchestrator-1` | OrchestratorAgent |
| `stream.agent.approved` | `risk-group` | `risk-manager-1` | RiskManager |
| `stream.swaps` | `exec-group` | `execution-1` | Execution |
| `stream.fills` | `tracker-group` | `position-tracker-1` | PositionTracker |
| `stream.fills` | `db-group` | `db-writer-1` | DBWriter |
| `stream.commands` | `cmd-group` | `command-listener-1` | CommandListener |

Always use `XACK` after successful processing. Unacknowledged messages are redelivered on restart.
