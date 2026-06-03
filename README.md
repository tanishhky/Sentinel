# Sentinel

**Unified read-only dashboard for PinSight + DriftEdge research platforms.**

Sentinel is a thin viewing layer over the data accumulated by [PinSight](https://github.com/tanishhky/PinSight) (0DTE options) and [DriftEdge](https://github.com/tanishhky/DriftEdge) (prediction markets). It reads from their Parquet stores and JSONL log streams, and presents everything in a Bloomberg-terminal-styled web UI.

**Sentinel does not trade. Sentinel does not produce signals. Sentinel only shows.**

**Sentinel does NOT contain any code from PinSight or DriftEdge.** Both projects live in their own repos at `~/dev/PinSight` and `~/dev/DriftEdge`. Sentinel references them by filesystem path via environment variables and reads their Parquet/JSONL artifacts. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the contract that keeps the three repos cleanly separated.

## Status

**v0.7 shipped (2026-06-02):** 5-trader race (Kelly / Equal / Vol-Wt / VolHarvest / Resolution), RETURNS tab with 4-mode chart (abs / % bankroll / Closed-Closed / Open-Open), floating ⓘ tooltips explaining each return formula, per-agent risk/distribution cards with colored borders, single-line compact log rows, near-certain market filter (drops ask ≤ 0.05 or ≥ 0.95), PWA manifest + service worker for one-click install.

**v0.6 shipped (2026-06-01):** Two-level tabbed navigation, Bloomberg Amber theme, ET timezones everywhere, cache-busted static assets, clickable market detail modal, all closed positions with ET timestamps, BY CATEGORY panel, system health page, mark-to-market equity curve, NEWS tab with VADER sentiment scoring.

**Operationally:** the project lives at `~/dev/Sentinel/`. A launchd job auto-starts the FastAPI server on login. Open <http://127.0.0.1:8765> — or install as a desktop app (see [PWA install](#pwa-install) below).

## UI structure

```
[DASHBOARD]   home — cross-system KPIs + 5-trader equity curve
[PINSIGHT]
  └─ CHAIN     latest SPY chain snapshot, IV, volumes
  └─ FLAGS     informed-flow candidates (vol/OI ≥ 1)
  └─ LOGS      live PinSight JSONL stream
[DRIFTEDGE]
  └─ PAPER     5-trader race — equity curve, open/closed positions, per-agent risk cards
  └─ RETURNS   4-mode return chart (abs / % bankroll / Closed-Closed / Open-Open)
  └─ MARKETS   top Polymarket + Kalshi markets, yes-price histogram
  └─ BOOKS     orderbook polling liveness per market
  └─ LOGS      live DriftEdge JSONL stream
[SENTINEL]
  └─ HEALTH    process status, log/data sizes, recent events
```

Auto-refresh every 5 s on every tab.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              FastAPI backend (Python)                        │
│  Reads Parquet from PinSight + DriftEdge data dirs;          │
│  tails JSONL log dirs; serves /static and /api/* routes.     │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   │ JSON
                   │
┌──────────────────▼───────────────────────────────────────────┐
│        Vanilla HTML + JavaScript + Chart.js (CDN)            │
│        Bloomberg Amber theme, monospace data, 5s refresh.    │
└──────────────────────────────────────────────────────────────┘
```

## Endpoints

| Route | Returns |
|---|---|
| `GET /api/health` | static config + paths |
| `GET /api/pinsight/chain` | latest PinSight chain snapshot |
| `GET /api/pinsight/flags?top=N` | flagged contracts table |
| `GET /api/driftedge/markets?top=N` | top DriftEdge markets by volume |
| `GET /api/driftedge/books` | orderbook polling liveness |
| `GET /api/driftedge/paper` | multi-trader summary (open + closed + by-trader + by-venue) |
| `GET /api/driftedge/paper/equity-history` | per-trader equity time series for the equity-curve chart |
| `GET /api/driftedge/price-distribution` | yes-price histogram across active markets |
| `GET /api/sentinel/health` | system-wide health snapshot (launchd status + log/data sizes) |
| `GET /api/logs/pinsight` | tail of PinSight JSONL events |
| `GET /api/logs/driftedge` | tail of DriftEdge JSONL events |

## Charts

Powered by Chart.js via CDN (no npm). Bloomberg Amber palette:

- **5-trader equity curve** — DASHBOARD and DRIFTEDGE → PAPER. Stepped line per trader, time on x-axis, equity on y-axis.
- **Returns chart** — DRIFTEDGE → RETURNS. 4 modes: abs ($P&L), pct_bankroll (% of $10k), pct_closed (stepped — closed_pnl / cum_deployed_usd), pct_open (smooth — MTM / open_exposure).
- **Yes-price distribution** — DRIFTEDGE → MARKETS. Bar histogram in 0.05 bins from 0.00 to 1.00.

## Color palette

```
Background:  #0a0a0a   (near-black)
Cards:       #111111
Primary:     #ff9000   (Bloomberg amber)
Text:        #ffffff
Positive:    #00ff88   (terminal green)
Negative:    #ff4444   (terminal red)
Muted:       #666666

Trader chart colors:
  Kelly:       #ff9000   (amber)
  Equal-Wt:    #00d4ff   (cyan)
  Vol-Wt:      #ff66cc   (pink-magenta)
  VolHarvest:  #44ff88   (green)
  Resolution:  #ff4466   (red-pink)
```

Symbology consistency: currency always `$X.XX`, percentages always `+/-X.XXX%`, prediction prices `0.XXX`, positive green, negative red, muted on absent.

## Configuration

`.env` (see `.env.example`):
```
PINSIGHT_DATA_DIR=/Users/tanishkyadav/dev/PinSight/data
PINSIGHT_LOG_DIR=/Users/tanishkyadav/dev/PinSight/logs
DRIFTEDGE_DATA_DIR=/Users/tanishkyadav/dev/DriftEdge/data
DRIFTEDGE_LOG_DIR=/Users/tanishkyadav/dev/DriftEdge/logs
SENTINEL_PORT=8765
```

## Running

Manually:
```
cd ~/dev/Sentinel/backend
python3 -m venv .venv
.venv/bin/pip install -e .
.venv/bin/python -m sentinel.server
```

Then open <http://127.0.0.1:8765>.

Auto-start on login:
```
./scripts/launchd/install.sh
```

## PWA install

Sentinel ships a web app manifest and service worker so it can be installed as a standalone desktop app — no browser chrome, shows in Launchpad and Spotlight.

**One-time setup:**
1. Open Chrome and navigate to `http://localhost:8765`
2. Click the install icon (⊕) in the address bar
3. Click "Install"

After install, launch via Launchpad or Spotlight ("Sentinel"). The launchd job auto-starts the backend on login, so the app is ready immediately when you open it.

## Repo layout

```
Sentinel/
├── README.md
├── .gitignore
├── .env.example
├── backend/
│   ├── pyproject.toml
│   └── src/sentinel/
│       ├── __init__.py
│       ├── config.py
│       ├── server.py        FastAPI app + routes
│       ├── readers.py       Parquet + log readers (all per-route logic)
│       └── static/          index.html, theme.css, app.js, manifest.json, sw.js, icons/
├── frontend/                React + Vite version (built later; vanilla is shipped)
└── scripts/launchd/         install.sh, uninstall.sh, plist
```

## Roadmap

- **v0.5 (shipped)** two-level tabs, multi-trader race view, equity curve, health page, price distribution chart
- **v0.6 (shipped)** NEWS tab, VADER sentiment, market detail modal, BY CATEGORY panel
- **v0.7 (shipped)** 5-trader roster, RETURNS tab (4-mode), agent cards, single-line logs, PWA install
- **v0.8** SSE log streaming (replace polling); searchable log filter
- **v1.0** React version (when there's a clear reason to migrate)

## License

TBD (likely MIT).
