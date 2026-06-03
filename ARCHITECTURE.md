# Architecture — Why Sentinel is a separate repo

This document is the **load-bearing answer** to the question "why are there three repos and not one?" and the contract that keeps Sentinel honest as a pure UI/UX layer.

## The three-repo contract

```
┌────────────────────┐      ┌────────────────────┐      ┌──────────────────────┐
│     PinSight       │      │     DriftEdge      │      │      Sentinel        │
│   (own repo)       │      │    (own repo)      │      │     (this repo)      │
│                    │      │                    │      │                      │
│  0DTE options      │      │  prediction        │      │  read-only           │
│  research engine   │      │  markets engine    │      │  UI / dashboard      │
│                    │      │                    │      │                      │
│  writes:           │      │  writes:           │      │  reads from disk:    │
│   data/chains/     │      │   data/markets/    │      │   $PINSIGHT_DATA_DIR │
│   data/logs/       │      │   data/books/      │      │   $DRIFTEDGE_DATA_DIR│
│                    │      │   data/news/       │      │   $PINSIGHT_LOG_DIR  │
│                    │      │   data/paper_*     │      │   $DRIFTEDGE_LOG_DIR │
└─────────┬──────────┘      └─────────┬──────────┘      └─────────┬────────────┘
          │                            │                            │
          │  writes Parquet            │  writes Parquet            │  reads via Pandas
          └────────────────────────────┴────────────────────────────┘
                          (filesystem is the API)
```

## Rules

1. **Sentinel never copies code from PinSight or DriftEdge.** The only thing Sentinel imports from those projects is data on disk. No `import pinsight`, no `import driftedge` ever appears anywhere under `~/dev/Sentinel/`.

2. **Sentinel references PinSight and DriftEdge by local filesystem path**, configured via environment variables in `.env`:
   ```
   PINSIGHT_DATA_DIR=/Users/tanishkyadav/dev/PinSight/data
   PINSIGHT_LOG_DIR=/Users/tanishkyadav/dev/PinSight/logs
   DRIFTEDGE_DATA_DIR=/Users/tanishkyadav/dev/DriftEdge/data
   DRIFTEDGE_LOG_DIR=/Users/tanishkyadav/dev/DriftEdge/logs
   ```
   Move either project, update the env var. That's it.

3. **All inter-project communication happens through Parquet files and JSONL logs.** The filesystem is the API contract. Schemas are documented in the project that *writes* them, not in Sentinel.

4. **Sentinel is allowed to evolve independently** of either trading repo. You can re-skin Sentinel completely without changing a line in PinSight or DriftEdge.

5. **PinSight and DriftEdge are allowed to evolve independently** of Sentinel. They have no awareness of who is reading their data.

## DriftEdge data files read by Sentinel

| File | Writer | Contents |
|---|---|---|
| `data/paper_trades.parquet` | DriftEdge | Every paper trade: entry/exit price, size, PnL, trader |
| `data/paper_equity_history.parquet` | DriftEdge | Per-trader equity snapshots: equity, cash, exposure, closed_pnl, drawdown_pct, mtm_unrealized_usd |
| `data/paper_state.parquet` | DriftEdge | Current portfolio state per trader (bankroll, cash, open_exposure, closed_pnl, peak_equity) |
| `data/markets/polymarket/*.parquet` | DriftEdge | Polymarket market snapshots |
| `data/markets/kalshi/*.parquet` | DriftEdge | Kalshi market snapshots |
| `logs/*.jsonl` | DriftEdge | Structured JSONL event logs |

5 active traders as of 2026-06-02: `kelly`, `equal`, `volwt`, `volharvest`, `resolution`. Each starts at $10k bankroll. Sentinel's `readers.py` joins `paper_equity_history` with `paper_trades` to compute `cum_deployed_usd` per equity point (bisect join on epoch-seconds).

## What this means in practice

| Question | Answer |
|---|---|
| Where do paper-trade rules live? | DriftEdge repo (`src/driftedge/paper.py`) |
| Where does the chart for the 3-trader race live? | Sentinel repo (`backend/src/sentinel/static/app.js`) |
| Where does the schema for `paper_trades.parquet` get defined? | DriftEdge (in `paper.py:open_position()`) |
| Where does Sentinel learn that schema? | It infers it via `pandas.read_parquet()` — no schema file shared |
| If I move DriftEdge to `~/code/DriftEdge`, what breaks? | Update `DRIFTEDGE_DATA_DIR` in Sentinel's `.env`. Nothing else. |
| If I open an issue in Sentinel, can it require a fix in DriftEdge? | No. Issues stay within their own repo's scope. |

## What Sentinel does NOT do

- Does NOT execute trades
- Does NOT generate signals
- Does NOT run the polling daemon
- Does NOT classify markets
- Does NOT contain any business logic that belongs in a trading engine

If you find yourself writing trading logic in Sentinel, stop. It belongs in the relevant engine's repo.

## What Sentinel DOES do

- Reads Parquet files from PinSight + DriftEdge data dirs
- Tails JSONL logs from both
- Computes UI-relevant aggregations (per-trader equity curve, per-category P&L, etc.) on the fly
- Serves a Bloomberg-Amber-themed HTML/JS dashboard
- Provides an HTTP API for the dashboard to consume
- Caches nothing — every refresh is a fresh disk read

## The launchd setup mirrors this separation

| Job label | Owned by | What it runs |
|---|---|---|
| `com.tanishk.pinsight.{morning,midday,close}` | PinSight | scheduled chain fetches |
| `com.tanishk.driftedge.poll` | DriftEdge | continuous polling daemon (Polymarket + Kalshi + 5-trader paper tick) |
| `com.tanishk.sentinel` | Sentinel | FastAPI server on `:8765` |

Each project's `scripts/launchd/` directory ships its own plist. Each install script in each repo manages only its own launchd jobs.

## Why this matters

- **Independent deploys.** Patch a polling bug in DriftEdge, push to main, restart only the DriftEdge daemon. Sentinel keeps serving the dashboard from the same fresh data.
- **Independent testing.** Run PinSight's test suite without DriftEdge installed and vice versa.
- **Clear ownership.** If a chart looks wrong, the bug is in Sentinel. If the data is wrong, the bug is in the engine that wrote it.
- **Easy to add a new engine later.** Want to add a third research project (say, "RatesBox" for fixed-income). Build it as its own repo, write its data to a known dir, add `RATESBOX_DATA_DIR` to Sentinel's `.env`, add a `RATESBOX` tab. Zero changes to PinSight or DriftEdge.
