# Backtesting Patterns

A strategy must be validated honestly before it touches real money. The cardinal sins of backtesting — look-ahead bias, ignored costs, overfitting — make a losing strategy look profitable. This file is about avoiding self-deception.

## Table of contents
- The honesty checklist
- Look-ahead bias (the silent killer)
- Realistic fees, slippage & funding
- vectorbt pattern (vectorized sweeps)
- backtesting.py pattern (event-driven)
- Walk-forward validation
- Metrics that matter

## The honesty checklist

A backtest is only useful if it could not have known the future and it paid realistic costs. Before trusting any result:

- [ ] No signal uses data from its own bar's close to trade *that same bar's* open
- [ ] Fees applied on every entry and exit (taker unless you truly rest limits)
- [ ] Slippage modeled, especially for market orders / larger size
- [ ] Funding applied to positions held across funding timestamps
- [ ] Tested on data the parameters were NOT tuned on (walk-forward / out-of-sample)
- [ ] Results survive small parameter changes (not a fragile peak)

If a strategy only works with zero fees or perfect fills, it doesn't work.

## Look-ahead bias (the silent killer)

The most common way a backtest lies: it acts on information it wouldn't have had in real time. The classic fix is to compute the signal on bar *t* and execute on bar *t+1*.

```python
# WRONG — buys at the same bar's price using that bar's completed indicator
df["signal"] = df["ema_fast"] > df["ema_slow"]
df["ret"] = df["signal"] * df["close"].pct_change()        # look-ahead!

# RIGHT — decide on bar t, act on bar t+1
df["signal"] = (df["ema_fast"] > df["ema_slow"]).astype(int)
df["position"] = df["signal"].shift(1).fillna(0)            # delayed by one bar
df["ret"] = df["position"] * df["close"].pct_change()
```

Any indicator that uses the full series (a centered moving average, a peak/trough detector that looks forward, normalization using the whole dataset's mean) leaks the future. Compute everything causally.

## Realistic fees, slippage & funding

```python
from decimal import Decimal

TAKER_FEE = Decimal("0.0004")    # 0.04% — check your exchange/tier
SLIPPAGE  = Decimal("0.0002")    # model per side; widen for thin markets/size

def net_trade_return(entry: Decimal, exit_: Decimal, side: str,
                     funding_paid: Decimal = Decimal("0")) -> Decimal:
    gross = (exit_ - entry) / entry
    if side == "short":
        gross = -gross
    costs = 2 * (TAKER_FEE + SLIPPAGE)        # entry + exit, fee + slippage each
    return gross - costs - funding_paid
```

Round-trip costs of ~0.1%+ destroy high-frequency strategies that look great gross. Always net them out. For held positions, subtract realized funding (see `data-pipeline.md`).

## vectorbt pattern (vectorized sweeps)

`vectorbt` shines for testing many parameter combinations fast.

```python
import vectorbt as vbt
import numpy as np

price = df.set_index("dt")["close"]
fast = vbt.MA.run(price, window=np.arange(5, 30, 5))
slow = vbt.MA.run(price, window=np.arange(30, 80, 10))

entries = fast.ma_crossed_above(slow)
exits   = fast.ma_crossed_below(slow)

pf = vbt.Portfolio.from_signals(
    price, entries, exits,
    fees=0.0004, slippage=0.0002, freq="1h",
)
print(pf.sharpe_ratio())          # a Series across all param combos
```

A grid that has one stellar combo surrounded by terrible ones is overfit — you want a *plateau* of decent results, not a fragile spike.

## backtesting.py pattern (event-driven)

When you want readable, stateful logic (stops, position management), `backtesting.py` reads more naturally.

```python
from backtesting import Backtest, Strategy
from backtesting.lib import crossover

class EmaCross(Strategy):
    n_fast, n_slow = 12, 26
    def init(self):
        c = self.data.Close
        self.ema_f = self.I(lambda x: pd.Series(x).ewm(span=self.n_fast).mean(), c)
        self.ema_s = self.I(lambda x: pd.Series(x).ewm(span=self.n_slow).mean(), c)
    def next(self):
        if crossover(self.ema_f, self.ema_s):
            self.position.close(); self.buy()
        elif crossover(self.ema_s, self.ema_f):
            self.position.close(); self.sell()

bt = Backtest(ohlcv_df, EmaCross, cash=10_000, commission=0.0004)
print(bt.run())
```

## Walk-forward validation

In-sample optimization always flatters itself. Tune on one window, test on the *next, unseen* window, roll forward. Out-of-sample performance is the only number that predicts live behavior.

```python
def walk_forward(df, train_bars, test_bars, optimize_fn, evaluate_fn):
    results, i = [], 0
    while i + train_bars + test_bars <= len(df):
        train = df.iloc[i : i + train_bars]
        test  = df.iloc[i + train_bars : i + train_bars + test_bars]
        params = optimize_fn(train)            # tune ONLY on train
        results.append(evaluate_fn(test, params))   # judge ONLY on test
        i += test_bars                          # roll the window
    return results
```

A strategy whose in-sample Sharpe is 3.0 but out-of-sample is 0.2 is overfit, not good.

## Metrics that matter

Don't judge on total return alone. Report at minimum:

| Metric | Why |
|---|---|
| **Sharpe ratio** | Return per unit of volatility |
| **Max drawdown** | Worst peak-to-trough — the pain you must survive |
| **Win rate** | % of trades profitable (alone it's misleading) |
| **Profit factor** | Gross profit / gross loss; >1 needed, >1.5 healthy |
| **# trades** | Too few = not statistically meaningful |
| **Avg win / avg loss (R)** | A 40% win rate can be great if R is high |

A strategy with a high return and a 60% max drawdown is unusable — you'd be liquidated or quit before the recovery. Prefer steady Sharpe and shallow drawdown over a flashy total return.
