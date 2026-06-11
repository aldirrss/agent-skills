# Scanner Runner

How to wire all scanner pollers as concurrent asyncio tasks.

## build_scanner_tasks()

Called from `main.py` after START command received. Returns a list of named asyncio tasks.

```python
# components/scanner/__init__.py
import asyncio
import aiohttp
from loguru import logger

from .dexscreener import poll_new_pairs, poll_trending as dex_trending
from .gmgn import poll_gmgn_trending
from .pumpfun import poll_pumpfun_new, poll_pumpfun_graduated, stream_pumpfun_events
from .birdeye import poll_birdeye_trending
from .kol_wallet import poll_kol_wallets_loop
from .helius import start_webhook_server, register_helius_webhook
from .cielo import discover_kol_wallets
from .twitter import poll_twitter_mentions
from .telegram import start_telegram_listener
from ..utils.supervisor import supervise


def build_scanner_tasks(
    redis, session: aiohttp.ClientSession,
    settings, stop_event: asyncio.Event
) -> list[asyncio.Task]:
    tasks = []

    def add(name: str, coro):
        tasks.append(asyncio.create_task(
            supervise(name, lambda: coro, restart=True),
            name=f"scanner.{name}",
        ))

    # ── Always-on scanners ───────────────────────────────────────────
    tasks.append(asyncio.create_task(
        _poll_loop("dexscreener.new",  10, poll_new_pairs,     redis, session),
        name="scanner.dexscreener.new",
    ))
    tasks.append(asyncio.create_task(
        _poll_loop("dexscreener.trending", 30, dex_trending,   redis, session),
        name="scanner.dexscreener.trending",
    ))
    tasks.append(asyncio.create_task(
        _poll_loop("gmgn.trending",    60, poll_gmgn_trending,  redis, session),
        name="scanner.gmgn",
    ))
    tasks.append(asyncio.create_task(
        _poll_loop("pumpfun.new",       5, poll_pumpfun_new,    redis, session),
        name="scanner.pumpfun.new",
    ))
    tasks.append(asyncio.create_task(
        _poll_loop("pumpfun.graduated", 10, poll_pumpfun_graduated, redis, session),
        name="scanner.pumpfun.graduated",
    ))
    tasks.append(asyncio.create_task(
        _run_forever("pumpfun.ws", stream_pumpfun_events, redis),
        name="scanner.pumpfun.ws",
    ))

    # ── Conditional scanners (require API keys) ───────────────────────
    if settings.birdeye_api_key:
        tasks.append(asyncio.create_task(
            _poll_loop("birdeye.trending", 30, poll_birdeye_trending, redis, session),
            name="scanner.birdeye",
        ))

    if settings.helius_api_key and settings.helius_webhook_url:
        tasks.append(asyncio.create_task(
            _run_forever("helius.webhook", start_webhook_server, redis),
            name="scanner.helius",
        ))
    else:
        # fallback: poll KOL wallets via RPC
        from solana.rpc.async_api import AsyncClient
        rpc = AsyncClient(settings.solana_rpc_url)
        tasks.append(asyncio.create_task(
            _run_forever("kol_wallet.poll", poll_kol_wallets_loop, redis, rpc),
            name="scanner.kol_wallet",
        ))

    if settings.cielo_api_key:
        tasks.append(asyncio.create_task(
            _poll_loop("cielo.discovery", 86400, discover_kol_wallets, session, redis),
            name="scanner.cielo",
        ))

    if settings.twitter_bearer_token:
        tasks.append(asyncio.create_task(
            _run_twitter_loop(redis, session, settings),
            name="scanner.twitter",
        ))

    if all([settings.telegram_api_id, settings.telegram_api_hash, settings.telegram_session_string]):
        tasks.append(asyncio.create_task(
            _run_forever("telegram", start_telegram_listener, redis),
            name="scanner.telegram",
        ))

    logger.bind(component="scanner").info(f"Started {len(tasks)} scanner tasks")
    return tasks


async def _poll_loop(name: str, interval_s: int, fn, *args):
    log = logger.bind(component=f"scanner.{name}")
    while True:
        try:
            await fn(*args)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.warning(f"Poll error: {e}")
        await asyncio.sleep(interval_s)


async def _run_forever(name: str, fn, *args):
    log = logger.bind(component=f"scanner.{name}")
    while True:
        try:
            await fn(*args)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.warning(f"Crashed: {e} — restarting in 5s")
            await asyncio.sleep(5)


async def _run_twitter_loop(redis, session, settings):
    from .twitter import poll_twitter_mentions
    log = logger.bind(component="scanner.twitter")
    while True:
        try:
            tracked_raw = await redis.smembers("state.bot.tokens")
            tracked = []
            for mint in tracked_raw:
                symbol = await redis.get(f"token.symbol.{mint}")
                if symbol:
                    tracked.append({"mint": mint, "symbol": symbol})
            if tracked:
                await poll_twitter_mentions(session, redis, tracked)
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.warning(f"Twitter poll error: {e}")
        await asyncio.sleep(60)
```

## Price Cache Updater

Separate scanner task that keeps `state.price.{mint}` fresh for all tracked tokens:

```python
async def price_cache_updater(redis, session: aiohttp.ClientSession):
    log = logger.bind(component="scanner.price_cache")
    while True:
        try:
            mints = await redis.smembers("state.bot.tokens")
            for mint in mints:
                pair = await get_pair_by_mint(session, mint)
                if pair:
                    price = pair.get("priceUsd", "0")
                    await redis.set(f"state.price.{mint}", price, ex=60)
                await asyncio.sleep(0.2)   # rate limit: 5 tokens/s
        except asyncio.CancelledError:
            break
        except Exception as e:
            log.debug(f"Price cache update error: {e}")
        await asyncio.sleep(15)
```

Add as scanner task in `build_scanner_tasks()`:
```python
tasks.append(asyncio.create_task(
    price_cache_updater(redis, session),
    name="scanner.price_cache",
))
```
