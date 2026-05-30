# Sentinel

**Unified read-only dashboard for PinSight + DriftEdge research platforms.**

Sentinel is a thin viewing layer over the data accumulated by [PinSight](https://github.com/tanishhky/PinSight) (0DTE options) and [DriftEdge](https://github.com/tanishhky/DriftEdge) (prediction markets). It reads from their Parquet stores and JSONL log streams, and presents everything in a Bloomberg-terminal-styled web UI.

Sentinel does not trade. Sentinel does not produce signals. Sentinel only shows.

## Status

Pre-alpha. Skeleton + theme + a few working tabs reading live data.

## Why a separate repo

Coupling the dashboard to either trading system would muddle responsibilities and make a third future system harder to add. Sentinel is the *viewing concern*, independent of any *trading concern*.

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│              FastAPI backend (Python)                        │
│  /api/pinsight/*        /api/driftedge/*    /api/logs/tail   │
│  reads Parquet          reads Parquet       SSE log stream   │
└──────────────────┬───────────────────────────────────────────┘
                   │
                   │ JSON / SSE
                   │
┌──────────────────▼───────────────────────────────────────────┐
│                React + Vite frontend                         │
│  Tabs: Overview · PinSight · DriftEdge · Logs · Settings    │
│  Theme: Bloomberg Amber (black + #ff9000)                    │
└──────────────────────────────────────────────────────────────┘
```

## Tabs (planned)

| Tab | Source | Shows |
|---|---|---|
| Overview | both | header KPIs from both systems; last-fetched times |
| PinSight → Chain | PinSight `data/chains/` | latest chain snapshot, ATM IV, 25Δ skew, top-volume strikes |
| PinSight → Flags | PinSight `data/chains/` | informed-flow candidates (vol/OI ≥ 1) |
| PinSight → Eval | PinSight `data/` + computed | hit rate of flagged contracts vs actual closes (when populated) |
| DriftEdge → Markets | DriftEdge `data/markets/` | top tracked markets by volume, prices, spreads |
| DriftEdge → Paths | DriftEdge `data/books/` + computed | probability-path drift for tracked markets |
| DriftEdge → Flow | DriftEdge `data/books/` + computed | order-book imbalance, volume z-scores (when M3 ships) |
| DriftEdge → Signals | DriftEdge `data/signals.parquet` | logged entry/exit signals (when M5 ships) |
| Logs | both `logs/` | live-tailing SSE stream of structured events |
| Settings | local | data dir paths, refresh intervals |

## Color palette

Bloomberg Amber (locked):

```
Background:  #0a0a0a
Primary:     #ff9000  (Bloomberg orange)
Text:        #ffffff
Positive:    #00ff88  (terminal green)
Negative:    #ff4444  (terminal red)
Muted:       #666666
Border:      #1a1a1a
```

Font stack: JetBrains Mono for data, system-ui for headers. Monospace everywhere it's a number.

## Configuration

`.env` (see `.env.example`):
```
PINSIGHT_DATA_DIR=/Users/tanishkyadav/Documents/SecondBrain/GitHub/PinSight/data
PINSIGHT_LOG_DIR=/Users/tanishkyadav/Documents/SecondBrain/GitHub/PinSight/logs
DRIFTEDGE_DATA_DIR=/Users/tanishkyadav/Documents/SecondBrain/GitHub/DriftEdge/data
DRIFTEDGE_LOG_DIR=/Users/tanishkyadav/Documents/SecondBrain/GitHub/DriftEdge/logs
SENTINEL_PORT=8765
```

## Running

```
cd backend && pip install -e .
python -m sentinel.server
# Backend on :8765

cd frontend && npm install && npm run dev
# Frontend on :5173 (dev) — proxies /api to :8765
```

To auto-start on login: `./scripts/launchd/install.sh` (requires Full Disk Access granted to bash per the PinSight/DriftEdge prerequisite).

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
│       ├── server.py            FastAPI app + routes
│       └── readers/             Parquet + log readers
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── theme.css           Bloomberg Amber palette + base styles
│   │   ├── components/
│   │   └── tabs/
└── scripts/launchd/
```

## Roadmap

- **v0.1 — skeleton + Overview tab + PinSight Chain tab + Logs tab**
- **v0.2 — DriftEdge Markets tab live, refresh-on-poll**
- **v0.3 — Path drift charts (DriftEdge Paths tab)**
- **v0.4 — Eval hit-rate chart (PinSight Eval tab)**
- **v0.5 — Signals tab when DriftEdge M5 ships**

## License

TBD (likely MIT).
