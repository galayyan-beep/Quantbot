# Quantbot

Self-optimizing multi-asset trading bot

Quantbot is a modular Node.js quantitative trading bot with:
- Capital.com live/demo market data
- 24-hour mandatory paper trading gate (virtual capital first)
- 5-layer Anthropic self-optimization engine
- Backtesting (2 years daily bars)
- News sentiment scoring with decay
- Correlation matrix and concentration controls
- Local dashboard (open HTML directly)

## Modules

- index.js: startup order, main loop (2s), orchestration
- prices.js: real Capital.com candles and execution pricing
- capitalApi.js: Capital.com auth/session, retries, orders
- indicators.js: EMA, RSI, VWAP, BB, MACD, ATR, momentum
- signals.js: scoring engine + sentiment overlay
- risk.js: sizing, stops, drawdown gates
- executor.js: entry/exit lifecycle, optional live order hooks
- optimizer.js: 5 self-improvement layers
- memory.js: 500-trade condition memory
- sentiment.js: NewsAPI + Anthropic classification every 15 minutes
- correlation.js: rolling 30-day Pearson matrix hourly
- backtest.js: 2-year historical daily backtest
- dashboard.html: JSON-driven dark dashboard, refresh every 10s

## Required Environment Variables

- ANTHROPIC_API_KEY: Anthropic API key
- CAPITAL_API_KEY: Capital.com API key
- CAPITAL_API_SECRET: Capital.com API secret/password
- CAPITAL_IDENTIFIER: Capital.com account identifier
- NEWS_API_KEY: NewsAPI key

Optional:
- ANTHROPIC_MODEL (default: claude-3-5-sonnet-20241022)
- LIVE_TRADING=false (must be manually set true to allow real live execution)

## Install

```bash
npm install
```

## Run Trading Bot

```bash
# Safe default mode
export LIVE_TRADING=false
node index.js
```

Startup order is:
1. Load state
2. Run backtest
3. Start correlation engine
4. Start sentiment engine
5. Start paper-trading mode checks
6. Start main trading loop (2 seconds)

## Mandatory Paper Trading Phase

On first startup:
- PAPER_TRADING is set true in data/state.json
- paperTradingStartTime is persisted
- virtual capital starts at 10000
- trades are simulated internally (no real-money execution)
- all 5 optimizer layers run normally to learn

Every hour:
- summary is printed (portfolio value, win rate, PF, trades, remaining hours)
- appended to data/paper_trading_results.json

After exactly 24h:
- full cycle report is sent to Anthropic
- verdict stored in data/paper_trading_verdict.json
- if verdict is READY and PF > 1.3 and drawdown < 15%, bot exits paper mode into demo-account trading path
- if NOT_READY, paper trading extends another 24h cycle

Important:
- bot never enables live money automatically
- you must set LIVE_TRADING=true manually
- log line printed on completion: PAPER TRADING COMPLETE — to enable real money set LIVE_TRADING=true manually

## Backtest

Run manually:

```bash
node backtest.js
```

Outputs data/backtest_results.json with:
- total return
- annualized return
- max drawdown and timestamp
- Sharpe ratio (4% risk-free)
- win rate, profit factor, average win/loss
- best/worst trade
- best/worst month
- trade count and average hold
- performance by instrument/signal/asset class
- Anthropic weakness analysis

Backtest also runs at startup and warns if:
- Sharpe < 0.5
- drawdown > 25%

## Sentiment Engine

Every 15 minutes:
- fetches headlines from NewsAPI
- asks Anthropic to classify each as VERY_BULLISH/BULLISH/NEUTRAL/BEARISH/VERY_BEARISH with confidence
- converts to score (+2/+1/0/-1/-2), decays 10% each cycle
- writes data/sentiment.json

Signal integration:
- sentiment > 2 adds +1 buy score
- sentiment < -2 adds +1 sell score
- if absolute sentiment > 3, entries against that direction are blocked

## Correlation Engine

Every hour:
- computes rolling 30-day Pearson matrix
- writes data/correlation.json

Rules:
- reject new trade if correlation with an open position > 0.7
- if two open positions exceed 0.8, close newer one
- inverse-volatility size multiplier applied
- correlation-adjusted portfolio risk capped at 15%
- matrix sent to Anthropic every 2h for concentration-risk check

## Dashboard

Open dashboard.html directly in a browser.

Displays:
- portfolio value, win rate, PF, open positions
- last 20 trades
- latest AI report
- sentiment table
- correlation heatmap
- paper-trading status/countdown/verdict

Auto-refresh: every 10 seconds.

## GitHub Actions Secrets

Add repository secrets:
- ANTHROPIC_API_KEY
- CAPITAL_API_KEY
- CAPITAL_API_SECRET
- CAPITAL_IDENTIFIER
- NEWS_API_KEY

Workflow file:
- .github/workflows/run-bot.yml

Behavior:
- runs every 6 hours
- commits updated data/*.json
- posts daily summary issue

## Safety Notes

- LIVE_TRADING is manual opt-in only
- keep LIVE_TRADING=false until paper verdict is consistently READY and risk metrics are stable
- monitor drawdown and correlation risk continuously in data/performance.json and data/correlation.json
