# Redis Topology

## Stream Schema

### `stream.signals`
Published by **Strategy**, consumed by **RiskManager**.
```json
{
  "signal_id": "sig_abc123",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol": "BONK",
  "action": "BUY",
  "confidence": 0.82,
  "sources": ["kol_wallet", "trending_gmgn"],
  "price_usdc": "0.00001234",
  "liquidity_usdc": "450000",
  "ts": 1718000000000
}
```

### `stream.swaps`
Published by **RiskManager**, consumed by **Execution**.
```json
{
  "swap_id": "swp_xyz789",
  "signal_id": "sig_abc123",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol": "BONK",
  "side": "BUY",
  "amount_usdc": "50.00",
  "slippage_bps": 100,
  "ts": 1718000000100
}
```

### `stream.fills`
Published by **Execution**, consumed by **PositionTracker** + **DBWriter**.
```json
{
  "fill_id": "fill_111",
  "swap_id": "swp_xyz789",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "symbol": "BONK",
  "side": "BUY",
  "status": "confirmed",
  "tx_signature": "5KZ...abc",
  "amount_in_usdc": "50.00",
  "amount_out_tokens": "4056000",
  "price_usdc": "0.00001233",
  "fee_sol": "0.000005",
  "ts": 1718000001200
}
```
`status` values: `confirmed` | `failed` | `timeout`

### `stream.commands`
Published externally (CLI / API), consumed by **CommandListener**.
```json
{
  "cmd": "START" | "STOP" | "PAUSE" | "RESUME" | "EMERGENCY_STOP" | "ADD_TOKEN" | "REMOVE_TOKEN",
  "payload": {},
  "ts": 1718000000000
}
```

## Pub/Sub Channels

### `scanner.token.new`
New token detected (just launched on Raydium / Pump.fun).
```json
{
  "mint": "...",
  "symbol": "NEWTOKEN",
  "source": "dexscreener" | "gmgn" | "pumpfun",
  "age_seconds": 45,
  "liquidity_usdc": "28000",
  "ts": 1718000000000
}
```

### `scanner.token.trending`
Existing token showing momentum (volume spike, holder growth).
```json
{
  "mint": "...",
  "symbol": "BONK",
  "source": "gmgn",
  "volume_1h_usdc": "1200000",
  "price_change_1h_pct": 18.5,
  "ts": 1718000000000
}
```

### `scanner.wallet.buy`
KOL wallet executed a buy.
```json
{
  "wallet": "ABcD...1234",
  "wallet_label": "sol_whale_1",
  "mint": "...",
  "symbol": "BONK",
  "amount_sol": "10.5",
  "tx_signature": "...",
  "ts": 1718000000000
}
```

### `position.updates`
Published by **PositionTracker** after every fill or PnL update.
```json
{
  "mint": "...",
  "symbol": "BONK",
  "side": "LONG",
  "entry_price": "0.00001233",
  "current_price": "0.00001450",
  "amount_tokens": "4056000",
  "pnl_usdc": "8.80",
  "pnl_pct": 17.6,
  "ts": 1718000000000
}
```

## Redis Keys

| Key | Type | TTL | Description |
|---|---|---|---|
| `state.bot.status` | String | none | `running` / `paused` / `stopped` |
| `state.bot.tokens` | Set | none | Active mint addresses being tracked |
| `state.position.{mint}` | String (JSON) | none | Current open position |
| `state.price.{mint}` | String | 60s | Latest price in USDC |
| `state.kol.wallets` | Set | none | KOL wallet addresses to track |
| `config.strategy` | String (JSON) | none | Strategy parameters |
| `config.risk` | String (JSON) | none | Risk parameters |

## Consumer Groups

Every stream uses a Redis consumer group for at-least-once delivery:

| Stream | Group | Consumer |
|---|---|---|
| `stream.signals` | `risk-group` | `risk-manager-1` |
| `stream.swaps` | `exec-group` | `execution-1` |
| `stream.fills` | `tracker-group` | `position-tracker-1` |
| `stream.fills` | `db-group` | `db-writer-1` |
| `stream.commands` | `cmd-group` | `command-listener-1` |

Always use `XACK` after successful processing. Unacknowledged messages are retried on restart.
