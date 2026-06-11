# Telegram Alpha Channel Scraping

Many Solana token calls are posted in Telegram groups before Twitter. Scraping alpha channels can give 5–30 minute lead time on trending tokens. Uses **Telethon** (Telegram userbot library) — requires a real Telegram account.

Library: `telethon` (not the bot API — userbot)
Credentials: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING` env vars

## Setup (one-time)

```python
# Run this once locally to generate session string — store in env var
from telethon.sync import TelegramClient
from telethon.sessions import StringSession

with TelegramClient(StringSession(), api_id, api_hash) as client:
    print(client.session.save())  # save this as TELEGRAM_SESSION_STRING
```

Store the session string in env var — never commit to git.

## Alpha Channel Listener

```python
from telethon import TelegramClient, events
from telethon.sessions import StringSession
import re

ALPHA_CHANNELS = [
    # add Telegram channel usernames or IDs of alpha groups
    # e.g. "@solana_alpha_calls", "@defi_gem_alerts"
    # load from config: config.telegram.channels
]

SOLANA_MINT_PATTERN = re.compile(r'[1-9A-HJ-NP-Za-km-z]{32,44}')
CASHTAG_PATTERN = re.compile(r'\$([A-Z]{2,10})')

async def start_telegram_listener(redis):
    api_id = int(os.environ["TELEGRAM_API_ID"])
    api_hash = os.environ["TELEGRAM_API_HASH"]
    session_str = os.environ["TELEGRAM_SESSION_STRING"]

    channels = await _load_channels(redis)
    if not channels:
        logger.info("No Telegram channels configured — Telegram scanner disabled")
        return

    client = TelegramClient(StringSession(session_str), api_id, api_hash)
    await client.start()

    @client.on(events.NewMessage(chats=channels))
    async def handle_message(event):
        await _process_alpha_message(event.message.text, redis)

    logger.info(f"Telegram listener active on {len(channels)} channels")
    await client.run_until_disconnected()

async def _load_channels(redis) -> list[str]:
    raw = await redis.get("config.telegram.channels")
    if not raw:
        return []
    return json.loads(raw)
```

## Message Processing

```python
async def _process_alpha_message(text: str, redis):
    if not text:
        return

    # try to extract Solana mint address from message
    mints = SOLANA_MINT_PATTERN.findall(text)
    symbols = CASHTAG_PATTERN.findall(text.upper())

    for mint in mints:
        if len(mint) < 32:   # Solana addresses are 32–44 chars
            continue
        if await is_duplicate(redis, "telegram_mint", mint, window_s=3600):
            continue

        signal = NewTokenSignal(
            mint=mint,
            symbol=symbols[0] if symbols else "UNKNOWN",
            source=SignalSource.TELEGRAM,
            liquidity_usdc=0,    # unknown at this point — Scanner will enrich
            age_seconds=0,
            ts=int(time.time() * 1000),
        )
        await redis.publish("scanner.token.new", signal.model_dump_json())
        logger.info(f"Telegram alpha: mint={mint[:8]} symbols={symbols}")
        break   # one mint per message

    # if no mint found but cashtag present, publish as social signal
    if not mints and symbols:
        for symbol in symbols[:2]:
            await redis.publish("scanner.social.telegram_mention", json.dumps({
                "symbol": symbol,
                "ts": int(time.time() * 1000),
            }))
```

## Signal Enrichment

Telegram signals often lack liquidity/price data. Strategy must enrich before acting:

```python
# In Strategy, when receiving scanner.token.new from TELEGRAM source:
async def enrich_telegram_signal(signal: NewTokenSignal, session, redis) -> NewTokenSignal:
    pair = await get_pair_by_mint(session, signal.mint)  # DEXScreener
    if not pair:
        return signal   # token not on DEX yet — discard in Strategy

    signal.liquidity_usdc = float(pair.get("liquidity", {}).get("usd", 0))
    signal.age_seconds = _calc_age(pair.get("pairCreatedAt"))
    return signal
```

## Channel Management

Add/remove channels at runtime via Redis:

```python
# add a channel
channels = json.loads(await redis.get("config.telegram.channels") or "[]")
channels.append("@new_alpha_channel")
await redis.set("config.telegram.channels", json.dumps(channels))
# listener picks up changes on next restart (no hot-reload for Telethon event handlers)
```

## Legal & Risk Notes

- Userbot scraping may violate Telegram's ToS — use a dedicated account, not your personal account
- Many "alpha channels" are paid pump groups — high noise, many bad calls
- Treat Telegram signals as **low-confidence** input to confluence, never as standalone buy triggers
- Implement a channel quality score: track how often Telegram calls lead to profitable trades (via DBWriter stats)

## Fallback

If any of `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_STRING` are missing:

```python
telegram_enabled = all([
    os.environ.get("TELEGRAM_API_ID"),
    os.environ.get("TELEGRAM_API_HASH"),
    os.environ.get("TELEGRAM_SESSION_STRING"),
])
if not telegram_enabled:
    logger.info("Telegram scanner disabled (missing credentials)")
```
