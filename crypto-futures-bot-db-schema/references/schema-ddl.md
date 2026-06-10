# Schema DDL

Full PostgreSQL DDL — copy-ready. Run in order (foreign key dependencies).

## Table of contents
- Enums
- exchanges
- accounts
- symbols
- workers
- bot_sessions
- signals
- orders
- trades
- funding_payments
- pnl_snapshots
- Indexes

---

## Enums

```sql
CREATE TYPE exchange_name    AS ENUM ('binance', 'bybit', 'okx', 'bitget');
CREATE TYPE worker_status    AS ENUM ('active', 'paused', 'stopped', 'crashed');
CREATE TYPE signal_status    AS ENUM ('executed', 'discarded', 'rejected_risk', 'rejected_filter');
CREATE TYPE trade_direction  AS ENUM ('long', 'short');
CREATE TYPE order_type       AS ENUM ('market', 'limit', 'stop_market', 'stop_limit',
                                      'take_profit_market', 'take_profit_limit');
CREATE TYPE order_role       AS ENUM ('entry', 'sl', 'tp', 'emergency_close', 'manual_close');
CREATE TYPE order_status     AS ENUM ('open', 'filled', 'partially_filled',
                                      'cancelled', 'rejected', 'failed');
CREATE TYPE trade_outcome    AS ENUM ('tp_hit', 'sl_hit', 'manual_close',
                                      'emergency_close', 'liquidated', 'unknown');
CREATE TYPE session_stop_reason AS ENUM ('manual', 'emergency_stop', 'crash',
                                          'circuit_breaker', 'scheduled');
```

---

## exchanges

```sql
CREATE TABLE exchanges (
    id           SERIAL PRIMARY KEY,
    name         exchange_name NOT NULL UNIQUE,
    display_name VARCHAR(50)   NOT NULL,
    base_url     VARCHAR(200)  NOT NULL,
    ws_url       VARCHAR(200)  NOT NULL,
    is_testnet   BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

INSERT INTO exchanges (name, display_name, base_url, ws_url) VALUES
    ('binance', 'Binance Futures', 'https://fapi.binance.com', 'wss://fstream.binance.com'),
    ('bybit',   'Bybit Linear',   'https://api.bybit.com',   'wss://stream.bybit.com'),
    ('okx',     'OKX Swap',       'https://www.okx.com',     'wss://ws.okx.com:8443');
```

---

## accounts

```sql
CREATE TABLE accounts (
    id           SERIAL PRIMARY KEY,
    exchange_id  INTEGER      NOT NULL REFERENCES exchanges(id),
    name         VARCHAR(100) NOT NULL,           -- "Binance Main", "Bybit Sub-1"
    api_key_ref  VARCHAR(100) NOT NULL,           -- env var name, e.g. "BINANCE_MAIN_KEY"
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    is_testnet   BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (exchange_id, api_key_ref)
);
```

---

## symbols

```sql
CREATE TABLE symbols (
    id           SERIAL PRIMARY KEY,
    account_id   INTEGER      NOT NULL REFERENCES accounts(id),
    symbol       VARCHAR(20)  NOT NULL,           -- "BTCUSDT"
    base_asset   VARCHAR(10)  NOT NULL,           -- "BTC"
    quote_asset  VARCHAR(10)  NOT NULL,           -- "USDT"
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, symbol)
);
```

---

## workers

```sql
CREATE TABLE workers (
    id               SERIAL PRIMARY KEY,
    account_id       INTEGER         NOT NULL REFERENCES accounts(id),
    symbol           VARCHAR(20)     NOT NULL,
    strategy         VARCHAR(50)     NOT NULL,     -- "trend", "momentum", etc.
    leverage         SMALLINT        NOT NULL CHECK (leverage BETWEEN 1 AND 20),
    risk_pct         NUMERIC(6, 4)   NOT NULL CHECK (risk_pct > 0 AND risk_pct <= 0.05),
    timeframe        VARCHAR(10)     NOT NULL,     -- "1h", "15m"
    status           worker_status   NOT NULL DEFAULT 'active',
    config           JSONB           NOT NULL DEFAULT '{}',  -- extra strategy params
    started_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    stopped_at       TIMESTAMPTZ,
    stop_reason      VARCHAR(200),
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
```

---

## bot_sessions

```sql
CREATE TABLE bot_sessions (
    id             SERIAL PRIMARY KEY,
    account_id     INTEGER             NOT NULL REFERENCES accounts(id),
    started_at     TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
    stopped_at     TIMESTAMPTZ,
    stop_reason    session_stop_reason,
    total_trades   INTEGER             NOT NULL DEFAULT 0,
    winning_trades INTEGER             NOT NULL DEFAULT 0,
    total_pnl      NUMERIC(24, 8)      NOT NULL DEFAULT 0,  -- net PnL for session
    created_at     TIMESTAMPTZ         NOT NULL DEFAULT NOW()
);
```

---

## signals

```sql
CREATE TABLE signals (
    id                  BIGSERIAL PRIMARY KEY,
    account_id          INTEGER         NOT NULL REFERENCES accounts(id),
    worker_id           INTEGER         REFERENCES workers(id),
    symbol              VARCHAR(20)     NOT NULL,
    strategy            VARCHAR(50)     NOT NULL,
    direction           trade_direction NOT NULL,
    confidence          NUMERIC(5, 4)   NOT NULL,      -- 0.0000 to 1.0000
    entry_price         NUMERIC(24, 8)  NOT NULL,
    atr                 NUMERIC(24, 8)  NOT NULL,
    regime              VARCHAR(30)     NOT NULL,       -- "trending_bull", "ranging", etc.
    confluence_score    SMALLINT        NOT NULL,
    confluence_details  JSONB           NOT NULL DEFAULT '{}',  -- per-signal breakdown
    llm_score           NUMERIC(5, 4),                 -- NULL if LLM unavailable
    llm_direction       VARCHAR(10),                   -- "bullish"|"bearish"|"neutral"
    status              signal_status   NOT NULL,
    discard_reason      VARCHAR(200),                  -- why discarded/rejected
    signal_ts           TIMESTAMPTZ     NOT NULL,      -- when signal was generated
    created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
```

---

## orders

```sql
CREATE TABLE orders (
    id               BIGSERIAL PRIMARY KEY,
    account_id       INTEGER         NOT NULL REFERENCES accounts(id),
    trade_id         BIGINT          REFERENCES trades(id),   -- NULL until trade created
    signal_id        BIGINT          REFERENCES signals(id),
    exchange_order_id VARCHAR(100)   NOT NULL,
    symbol           VARCHAR(20)     NOT NULL,
    direction        trade_direction NOT NULL,
    order_type       order_type      NOT NULL,
    role             order_role      NOT NULL,
    side             VARCHAR(5)      NOT NULL CHECK (side IN ('buy', 'sell')),
    qty_requested    NUMERIC(24, 8)  NOT NULL,
    qty_filled       NUMERIC(24, 8)  NOT NULL DEFAULT 0,
    price_requested  NUMERIC(24, 8),                   -- NULL for market orders
    avg_fill_price   NUMERIC(24, 8),                   -- NULL until filled
    fee              NUMERIC(24, 8)  NOT NULL DEFAULT 0,
    fee_asset        VARCHAR(10)     NOT NULL DEFAULT 'USDT',
    reduce_only      BOOLEAN         NOT NULL DEFAULT FALSE,
    status           order_status    NOT NULL DEFAULT 'open',
    placed_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    filled_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
```

---

## trades

```sql
-- Forward reference: orders.trade_id references trades.id
-- Create trades before adding the FK to orders, or use DEFERRABLE

CREATE TABLE trades (
    id               BIGSERIAL PRIMARY KEY,
    account_id       INTEGER         NOT NULL REFERENCES accounts(id),
    worker_id        INTEGER         REFERENCES workers(id),
    signal_id        BIGINT          REFERENCES signals(id),
    entry_order_id   BIGINT          REFERENCES orders(id),
    exit_order_id    BIGINT          REFERENCES orders(id),   -- NULL until closed
    symbol           VARCHAR(20)     NOT NULL,
    strategy         VARCHAR(50)     NOT NULL,
    direction        trade_direction NOT NULL,
    qty              NUMERIC(24, 8)  NOT NULL,
    entry_price      NUMERIC(24, 8)  NOT NULL,
    exit_price       NUMERIC(24, 8),                         -- NULL until closed
    sl_price         NUMERIC(24, 8)  NOT NULL,
    tp_price         NUMERIC(24, 8),
    gross_pnl        NUMERIC(24, 8),                         -- before fees & funding
    fee_total        NUMERIC(24, 8)  NOT NULL DEFAULT 0,     -- sum of all order fees
    funding_total    NUMERIC(24, 8)  NOT NULL DEFAULT 0,     -- sum of funding payments
    net_pnl          NUMERIC(24, 8),                         -- gross - fee - funding
    pnl_pct          NUMERIC(10, 6),                         -- net_pnl / entry_notional
    r_multiple       NUMERIC(10, 4),                         -- net_pnl / initial_risk
    outcome          trade_outcome,                          -- NULL until closed
    leverage         SMALLINT        NOT NULL,
    risk_pct         NUMERIC(6, 4)   NOT NULL,
    initial_risk     NUMERIC(24, 8)  NOT NULL,               -- USD risk at entry
    duration_seconds INTEGER,                                -- filled on close
    opened_at        TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    closed_at        TIMESTAMPTZ,
    created_at       TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Add deferred FK from orders to trades
ALTER TABLE orders
    ADD CONSTRAINT fk_orders_trade
    FOREIGN KEY (trade_id) REFERENCES trades(id)
    DEFERRABLE INITIALLY DEFERRED;
```

---

## funding_payments

```sql
CREATE TABLE funding_payments (
    id           BIGSERIAL PRIMARY KEY,
    account_id   INTEGER         NOT NULL REFERENCES accounts(id),
    trade_id     BIGINT          NOT NULL REFERENCES trades(id),
    symbol       VARCHAR(20)     NOT NULL,
    amount       NUMERIC(24, 8)  NOT NULL,  -- positive = received, negative = paid
    rate         NUMERIC(12, 8)  NOT NULL,  -- funding rate at collection time
    payment_ts   TIMESTAMPTZ     NOT NULL,  -- when funding was collected
    created_at   TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);
```

---

## pnl_snapshots

```sql
CREATE TABLE pnl_snapshots (
    id                    BIGSERIAL PRIMARY KEY,
    account_id            INTEGER        NOT NULL REFERENCES accounts(id),
    equity                NUMERIC(24, 8) NOT NULL,   -- total account equity
    available_balance     NUMERIC(24, 8) NOT NULL,   -- free margin
    unrealized_pnl        NUMERIC(24, 8) NOT NULL DEFAULT 0,
    open_positions_count  SMALLINT       NOT NULL DEFAULT 0,
    snapshot_ts           TIMESTAMPTZ    NOT NULL,   -- rounded to 15min interval
    created_at            TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

    UNIQUE (account_id, snapshot_ts)    -- one snapshot per account per interval
);
```

---

## Indexes

```sql
-- accounts
CREATE INDEX idx_accounts_exchange   ON accounts (exchange_id);

-- workers
CREATE INDEX idx_workers_account     ON workers (account_id, status);
CREATE INDEX idx_workers_symbol      ON workers (account_id, symbol);

-- signals (high volume — BRIN on timestamp)
CREATE INDEX idx_signals_account_ts  ON signals USING BRIN (account_id, signal_ts);
CREATE INDEX idx_signals_symbol      ON signals (account_id, symbol, signal_ts DESC);
CREATE INDEX idx_signals_status      ON signals (account_id, status);

-- orders (high volume)
CREATE INDEX idx_orders_account_ts   ON orders USING BRIN (account_id, placed_at);
CREATE INDEX idx_orders_trade        ON orders (trade_id);
CREATE INDEX idx_orders_exchange_id  ON orders (account_id, exchange_order_id);
CREATE INDEX idx_orders_symbol       ON orders (account_id, symbol, placed_at DESC);

-- trades (core analytics table)
CREATE INDEX idx_trades_account_ts   ON trades USING BRIN (account_id, opened_at);
CREATE INDEX idx_trades_symbol       ON trades (account_id, symbol, opened_at DESC);
CREATE INDEX idx_trades_strategy     ON trades (account_id, strategy, opened_at DESC);
CREATE INDEX idx_trades_open         ON trades (account_id) WHERE closed_at IS NULL;
CREATE INDEX idx_trades_outcome      ON trades (account_id, outcome);

-- funding_payments
CREATE INDEX idx_funding_trade       ON funding_payments (trade_id);
CREATE INDEX idx_funding_account_ts  ON funding_payments USING BRIN (account_id, payment_ts);

-- pnl_snapshots (time-series, BRIN is optimal)
CREATE INDEX idx_snapshots_account_ts ON pnl_snapshots USING BRIN (account_id, snapshot_ts);
```
