# RiskManager & Execution

These two components are fully documented in their dedicated skills:

- **RiskManager** → see `web3-solana-risk` skill
  - Position sizing, safety gate, circuit breaker
  - `references/risk-manager.md`, `references/circuit-breaker.md`, `references/position-sizing.md`

- **Execution** → see `web3-solana-execution` skill
  - Jupiter V6 swap flow, transaction signing, confirmation polling, dry-run mode
  - `references/execution-component.md`, `references/jupiter-flow.md`, `references/dry-run.md`

## Wiring in main.py

```python
from components.risk_manager import RiskManager
from components.execution import Execution

risk_manager = RiskManager(redis, settings)
execution    = Execution(
    keypair=keypair,          # only component that receives keypair
    rpc=rpc_primary,
    rpc_fallback=rpc_fallback,
    session=session,
    redis=redis,
    dry_run=settings.dry_run,
)

pipeline_tasks = [
    asyncio.create_task(risk_manager.run(stop_event), name="risk_manager"),
    asyncio.create_task(execution.run(stop_event),    name="execution"),
    ...
]
```

## Stream Pipeline

```
stream.signals
    └──► RiskManager (group: risk-group)
             └──► stream.swaps
                      └──► Execution (group: exec-group)
                               └──► stream.fills
```

## Shutdown Order

Stop RiskManager before Execution — ensures no new swap requests are queued while Execution is finishing its current swap (which may hold a per-mint asyncio.Lock for up to 60s).
