# Wallet Management

Keypair loading, balance checks, ATA verification, and wallet safety patterns.

## Loading the Keypair

**Never hardcode a private key.** Load from environment variable only.

```python
import os
import base58
from solders.keypair import Keypair

def load_keypair() -> Keypair:
    raw = os.environ.get("WALLET_PRIVATE_KEY")
    if not raw:
        raise RuntimeError("WALLET_PRIVATE_KEY env var not set")

    # supports two formats:
    # 1. base58 string (Phantom export)
    # 2. JSON array of 64 bytes (Solana CLI export)
    raw = raw.strip()
    if raw.startswith("["):
        import json
        bytes_list = json.loads(raw)
        return Keypair.from_bytes(bytes(bytes_list))
    else:
        return Keypair.from_bytes(base58.b58decode(raw))
```

Load once at startup. Store the `Keypair` object in memory. Pass only `keypair.pubkey()` (string) to components that need the address — never pass the full keypair object outside the Execution component.

## Checking SOL Balance

Always verify SOL balance before swap to ensure enough for fees + ATA rent.

```python
from solana.rpc.async_api import AsyncClient
from solders.pubkey import Pubkey

MIN_SOL_RESERVE = 10_000_000  # 0.01 SOL in lamports — covers fees + 1 ATA creation

async def get_sol_balance(wallet_pubkey: str, rpc: AsyncClient) -> int:
    resp = await rpc.get_balance(Pubkey.from_string(wallet_pubkey))
    return resp.value  # lamports

async def has_sufficient_sol(wallet_pubkey: str, rpc: AsyncClient) -> bool:
    balance = await get_sol_balance(wallet_pubkey, rpc)
    return balance >= MIN_SOL_RESERVE
```

Cache balance in Redis: `state.wallet.sol_balance` (TTL: 30s). Refresh after every swap.

## Checking USDC Balance

For USDC-denominated bots, check spendable USDC before placing a buy.

```python
from solders.pubkey import Pubkey
from spl.token.async_client import AsyncToken
from spl.token.constants import TOKEN_PROGRAM_ID

USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

async def get_usdc_balance(wallet_pubkey: str, rpc: AsyncClient) -> int:
    """Returns USDC balance in micro-units (6 decimals). 1 USDC = 1_000_000."""
    resp = await rpc.get_token_accounts_by_owner(
        Pubkey.from_string(wallet_pubkey),
        TokenAccountOpts(mint=Pubkey.from_string(USDC_MINT)),
    )
    if not resp.value:
        return 0
    account = resp.value[0]
    return int(account.account.data.parsed["info"]["tokenAmount"]["amount"])
```

## Associated Token Account (ATA)

Jupiter creates ATAs automatically during swap. However, ATA creation costs ~0.002 SOL rent. Before any buy on a new token, verify the wallet has enough SOL buffer.

```python
from spl.token.instructions import get_associated_token_address

def get_ata_address(wallet_pubkey: str, mint: str) -> str:
    return str(get_associated_token_address(
        Pubkey.from_string(wallet_pubkey),
        Pubkey.from_string(mint),
    ))

async def ata_exists(wallet_pubkey: str, mint: str, rpc: AsyncClient) -> bool:
    ata = get_ata_address(wallet_pubkey, mint)
    info = await rpc.get_account_info(Pubkey.from_string(ata))
    return info.value is not None
```

If ATA does not exist, budget an extra 0.002 SOL per new token in the SOL reserve check.

## Wallet State in Redis

```
state.wallet.sol_balance        # int (lamports), TTL 30s
state.wallet.usdc_balance       # int (micro-USDC), TTL 30s
state.wallet.pubkey             # string, no TTL (set at startup)
```

Never store private key or seed phrase in Redis under any key.

## Security Checklist

- [ ] `WALLET_PRIVATE_KEY` is in `.env` — not committed to git (`.gitignore` must include `.env`)
- [ ] Private key is only accessed in `load_keypair()` — no other function reads env var
- [ ] Keypair object is only used in Execution component
- [ ] Pubkey string (not keypair) is passed to Scanner, Monitor, etc.
- [ ] Log lines never include keypair, seed phrase, or private key bytes
- [ ] `.env.example` provides the key name but NOT a real value
