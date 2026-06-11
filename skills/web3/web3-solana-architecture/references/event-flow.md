# Event Flow

Full lifecycle from signal detection to swap confirmation.

## Happy Path: BUY Signal

```
1. Scanner
   ├── polls DEXScreener every 10s
   ├── detects BONK trending (volume +18% in 1h)
   ├── polls GMGN → confirms trending
   ├── checks KOL wallet tracker → sol_whale_1 bought 10.5 SOL of BONK
   └── publishes to:
       - scanner.token.trending  (volume signal)
       - scanner.wallet.buy      (KOL signal)

2. Strategy
   ├── subscribes to all scanner.* channels
   ├── receives both signals within 30s window
   ├── confluence check: 2/3 sources aligned (threshold met)
   ├── builds signal with confidence=0.82
   └── XADD stream.signals  →  {signal_id, mint, action=BUY, confidence, sources}

3. RiskManager
   ├── XREAD stream.signals (consumer group)
   ├── checks state.position.{mint} → no open position (clear)
   ├── checks config.risk → max_position_usdc=100, current exposure OK
   ├── checks liquidity_usdc=450000 → above min threshold (50000)
   ├── calculates position size: 50 USDC (50% of max, scaled by confidence)
   └── XADD stream.swaps  →  {swap_id, mint, side=BUY, amount_usdc=50}
       XACK stream.signals

4. Execution
   ├── XREAD stream.swaps (consumer group)
   ├── acquires asyncio.Lock for mint
   ├── calls Jupiter V6 /quote → gets best route
   ├── calls Jupiter V6 /swap → gets serialized transaction
   ├── deserializes with solders, signs with wallet keypair
   ├── sends via solana-py AsyncClient.send_transaction()
   ├── polls for confirmation (max 60s, check every 2s)
   └── XADD stream.fills  →  {fill_id, tx_signature, status=confirmed, amount_out_tokens}
       XACK stream.swaps
       releases asyncio.Lock

5. PositionTracker
   ├── XREAD stream.fills (consumer group: tracker-group)
   ├── creates position record: {mint, entry_price, amount_tokens, entry_ts}
   ├── SET state.position.{mint} = JSON
   └── PUBLISH position.updates  →  {mint, side=LONG, entry_price, pnl_pct=0}
       XACK stream.fills

6. DBWriter
   ├── XREAD stream.fills (consumer group: db-group)
   ├── INSERT INTO trades (mint, side, amount, price, tx_sig, ts)
   └── XACK stream.fills

7. Monitor
   ├── subscribes to position.updates
   └── sends Telegram alert: "✅ BUY BONK | 50 USDC | entry 0.00001233"
```

## Failure Paths

### Jupiter quote fails
```
Execution receives swap from stream.swaps
→ Jupiter /quote returns error or empty routes
→ Execution publishes fill with status=failed, reason="no_route"
→ XACK stream.swaps (do not retry — signal is stale by now)
→ Monitor logs warning
```

### Transaction timeout (not confirmed in 60s)
```
Execution sends tx, polls confirmation loop
→ 60s elapsed, still not confirmed
→ Execution publishes fill with status=timeout, tx_signature=<sig>
→ PositionTracker does NOT create position
→ Monitor sends alert: "⚠️ SWAP TIMEOUT — verify manually: <sig>"
→ Bot pauses new entries for this mint for 5 minutes
```

### RPC node down
```
Execution catches ConnectionError from solana-py
→ Waits 5s, retries with backup RPC endpoint (config.rpc.fallback_url)
→ If backup also fails: publishes fill with status=failed, reason="rpc_down"
→ CommandListener sets state.bot.status = "paused"
→ Monitor sends critical alert
```

## SELL Flow (Exit Position)

```
Strategy
├── monitors state.position.{mint} via periodic price check
├── current price crosses take-profit or stop-loss threshold
└── XADD stream.signals  →  {action=SELL, mint, reason="take_profit"|"stop_loss"}

RiskManager
├── validates position exists in state.position.{mint}
├── calculates exact token amount to sell (full position)
└── XADD stream.swaps  →  {side=SELL, amount_tokens=<exact>}

Execution
├── Jupiter /quote with inputMint=token, outputMint=USDC
└── (same signing + send flow as BUY)

PositionTracker
├── receives fill with side=SELL
├── calculates realized PnL
├── DEL state.position.{mint}
└── PUBLISH position.updates  →  {pnl_usdc, pnl_pct, reason}
```

## Emergency Stop Flow

```
CommandListener receives cmd=EMERGENCY_STOP
→ sets state.bot.status = "stopped"
→ reads all keys matching state.position.*
→ for each open position:
    XADD stream.swaps  →  {side=SELL, reason="emergency_stop"}
→ waits for all fills to complete (max 120s)
→ logs final PnL summary
→ Monitor sends alert: "🚨 EMERGENCY STOP — all positions closed"
```
