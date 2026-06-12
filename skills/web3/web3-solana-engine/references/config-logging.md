# Config & Logging

Pydantic Settings, Loguru setup, and Solana RPC client initialization.

## config.py

```python
from pydantic_settings import BaseSettings
from pydantic import field_validator, model_validator
from decimal import Decimal

class Settings(BaseSettings):
    # Redis
    redis_url: str = "redis://localhost:6379/0"

    # PostgreSQL
    database_url: str = "postgresql+asyncpg://user:pass@localhost/solana_bot"

    # Solana RPC
    solana_rpc_url: str          # required — Helius/QuickNode primary
    solana_rpc_fallback_url: str  # required — backup RPC

    # Wallet
    wallet_private_key: str      # required — base58 or JSON array, never logged

    # Bot behavior
    dry_run: bool = True         # MUST be explicitly set to false for live trading
    log_level: str = "INFO"

    # Optional integrations (bot works without these)
    birdeye_api_key: str = ""
    helius_api_key: str = ""
    helius_webhook_url: str = ""
    cielo_api_key: str = ""
    twitter_bearer_token: str = ""
    telegram_api_id: str = ""
    telegram_api_hash: str = ""
    telegram_session_string: str = ""

    # Strategy (can also be set via Redis config.strategy)
    enabled_strategies: list[str] = [
        "kol_copy_trade",
        "graduation_trade",
        "momentum_spike",
    ]

    @field_validator("solana_rpc_url", "solana_rpc_fallback_url")
    @classmethod
    def must_be_https(cls, v: str) -> str:
        if not v.startswith("https://"):
            raise ValueError("RPC URL must use HTTPS")
        return v

    @model_validator(mode="after")
    def warn_if_live(self) -> "Settings":
        if not self.dry_run:
            import warnings
            warnings.warn("DRY_RUN=false — bot will execute REAL transactions!", stacklevel=2)
        return self

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        # Never log or repr wallet_private_key
        secrets_dir = None

    def __repr__(self) -> str:
        return (
            f"Settings(dry_run={self.dry_run}, "
            f"strategies={self.enabled_strategies}, "
            f"wallet={str(self.wallet_private_key)[:4]}...)"  # never show full key
        )
```

## .env.example

```env
# Solana RPC (required)
SOLANA_RPC_URL=https://rpc.helius.xyz/?api-key=YOUR_KEY
SOLANA_RPC_FALLBACK_URL=https://api.mainnet-beta.solana.com

# Wallet (required) — base58 private key from Phantom
WALLET_PRIVATE_KEY=your_base58_private_key_here

# Safety (required to go live)
DRY_RUN=true

# Database
DATABASE_URL=postgresql+asyncpg://user:pass@localhost/solana_bot
REDIS_URL=redis://localhost:6379/0

# Optional integrations
BIRDEYE_API_KEY=
HELIUS_API_KEY=
HELIUS_WEBHOOK_URL=https://yourbot.example.com/helius
CIELO_API_KEY=
TWITTER_BEARER_TOKEN=
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_STRING=

# Strategies to enable (comma-separated)
ENABLED_STRATEGIES=kol_copy_trade,graduation_trade,momentum_spike
```

## logger_setup.py

```python
import sys
from loguru import logger

def setup_logger(level: str = "INFO") -> None:
    logger.remove()

    # Stderr: human-readable, colored
    logger.add(
        sys.stderr,
        level=level,
        format=(
            "<green>{time:YYYY-MM-DD HH:mm:ss}</green> | "
            "<level>{level: <8}</level> | "
            "<cyan>{extra[component]}</cyan> | "
            "{message}"
        ),
        filter=lambda r: "component" in r["extra"],
        colorize=True,
    )

    # File: JSON structured, for post-analysis
    logger.add(
        "logs/bot_{time:YYYY-MM-DD}.log",
        level="DEBUG",
        format="{time} | {level} | {extra} | {message}",
        rotation="00:00",    # new file at midnight
        retention="14 days",
        compression="gz",
        serialize=True,      # JSON output
    )

# Usage in every component:
# log = logger.bind(component="scanner.gmgn")
# log.info("Fetching trending tokens")
# log.warning("Rate limited", status=429)
# log.error("Request failed", error=str(e))
```

## Solana RPC Client Init

```python
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed

async def init_rpc_clients(primary_url: str, fallback_url: str):
    primary = AsyncClient(primary_url, commitment=Confirmed)
    fallback = AsyncClient(fallback_url, commitment=Confirmed)

    # verify both
    for client, name in [(primary, "primary"), (fallback, "fallback")]:
        health = await client.get_health()
        if health.value != "ok":
            raise RuntimeError(f"Solana RPC {name} unhealthy")
        logger.bind(component="main").info(f"RPC {name} connected")

    return primary, fallback
```

## Risk Config in Redis

On startup, write default risk config to Redis if not already set:

```python
import json

DEFAULT_RISK_CONFIG = {
    "base_position_usdc":       50,
    "max_wallet_pct":           0.10,
    "max_concurrent_positions": 5,
    "max_daily_loss_usdc":      200,
    "max_daily_profit_usdc":    100,
    "max_hold_time_seconds":    3600,
    "min_liquidity_usdc":       30000,
    "min_viable_position_usdc": 5,
    "min_token_age_seconds":    300,
    "max_top10_holder_rate":    0.50,
    # stop_loss_pct and take_profit_pct are code constants (SL_TIERS, TAKE_PROFIT_PCT=1.0)
}

DEFAULT_STRATEGY_CONFIG = {
    "enabled_strategies": ["kol_copy_trade", "graduation_trade", "momentum_spike"],
    "min_confidence_score": 50,
}

async def seed_redis_config(redis, settings: Settings) -> None:
    if not await redis.get("config.risk"):
        await redis.set("config.risk", json.dumps(DEFAULT_RISK_CONFIG))
    if not await redis.get("config.strategy"):
        config = DEFAULT_STRATEGY_CONFIG.copy()
        config["enabled_strategies"] = settings.enabled_strategies
        await redis.set("config.strategy", json.dumps(config))
```
