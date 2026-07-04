# Sentinel TODO

Tracked work for the platform repo. See `PROJECT-MANAGEMENT.md` for the rules and
`CONTRACT-SPEC.md` for the contract format these tasks implement.

---

## Next up — plug-in contract (thin slice)

The contract is documented in `CONTRACT-SPEC.md` but not yet wired. Without
this, every engine refinement requires a code commit + restart instead of a
config edit + audit log entry.

- [ ] **engine registry**: add `backend/src/sentinel/engines.json` listing each
      engine's manifest path. Sentinel discovers engines from this file at
      startup; no other code knows engine names.
- [ ] **manifest loader**: `backend/src/sentinel/manifests.py` reads each
      manifest, validates required fields (`engine_id`, `engine_version`,
      `departments`, `agents`, `capabilities`), surfaces errors to /api/health.
- [ ] **state reader**: `/api/engines/{engine_id}/state` returns the engine's
      latest `state.json` so the UI can show last-tick-ts, kill-switch state,
      allocations-version-loaded.
- [ ] **audit log reader**: `/api/engines/{engine_id}/audit?limit=N` tails
      `allocation-audit.jsonl` and renders the most recent N actions.
- [ ] **allocations writer**: `POST /api/engines/{engine_id}/allocations`
      validates against `risk_limits` from the manifest and writes
      `allocations.json` atomically (tmpfile + rename). Bumps
      `allocations_version`. Never edit in place.
- [ ] **UI: ALLOCATIONS sub-tab** under each engine top tab. Tree view
      Engine → Department → Agent with per-node budget input and an APPLY
      button. Disabled when the engine's `risk_limits` forbid it.
- [ ] **UI: AUDIT sub-tab** showing recent audit log entries with reason +
      diff (before → after).
- [ ] **dynamic top tabs**: replace hardcoded `["dashboard","pinsight","driftedge","sentinel"]`
      in `app.js` with a list rendered from manifest data. Adding a new engine
      via `engines.json` should add a top tab automatically — zero JS edits.

## PinSight UI build-out (parallel work, not contract-dependent)

Right now PinSight tabs are mostly text-only. Compared to the DriftEdge → PAPER
tab, there is nothing visual to look at — no IV smile, no skew curve, no
vol-by-strike bars, no contract table on CHAIN. Builders see the data, but the
user sees blank cards.

- [ ] **CHAIN tab — IV smile chart**: scatter of (strike, iv) split call/put,
      vertical line at spot. New endpoint `/api/pinsight/chain/smile`.
- [ ] **CHAIN tab — vol-by-strike bar chart**: stacked calls/puts.
- [ ] **CHAIN tab — contract table** below the KPIs (top N by volume) — same
      Bloomberg styling as the markets table.
- [ ] **FLAGS tab — vol/OI distribution histogram** (log-scale x-axis).
- [ ] **FLAGS tab — sort + filter UI** (by symbol, by type, by min vol/OI).
- [ ] **Top-level PINSIGHT landing card**: small KPI block (last fetch ts,
      contracts, total call/put vol, ATM IV, skew_25d) before the sub-tab
      content. Currently PINSIGHT → CHAIN shows 4 KPIs only.
- [ ] **flag-event timeline**: tail of recent `signal.flag` events with
      strike + type + vol/OI so the user can see "what flagged when."

## Smaller fixes

- [ ] **`Optional[str]` audit**: there are still old `str | None` annotations
      on lesser-used readers; they will crash under Python 3.9 if FastAPI
      evaluates them. Sweep `readers.py` and `server.py`.
- [ ] **README endpoints table**: now stale (risk-stats + pnl-distribution +
      status missing). Regenerate.

## Done (recent)

- [x] **Chart flash / "Loading…" tick fixed (2026-07-03)**: charts are now
      destroyed only at the atomic content swap (after data is fetched),
      chart animations off, fetch errors keep the last good view + show a
      connection banner, refresh skips hidden tabs and never overlaps,
      tab switches abort in-flight fetches.
- [x] **Header status lights (2026-07-03)**: SENTINEL / PINSIGHT / DRIFTEDGE
      dots (live/idle/error/stopped) + last-update stamp, driven by the new
      cheap `GET /api/status` (file mtimes + one cached `launchctl list`,
      no tree walks).
- [x] **Backend lag fixes (2026-07-03)**: mtime-keyed parquet cache,
      payload memoization for paper/equity readers, per-market books cache
      (5.4 s → 0.08 s), flags cache, dir-size stale-while-revalidate.
      Equity histories downsampled to ≤800 points per trader.
- [x] Risk-stats panel + per-trader P&L histograms (Paper tab)
- [x] Per-market P&L histogram in market detail modal
- [x] CONTRACT-SPEC.md v1.0
- [x] PROJECT-MANAGEMENT.md (Five Non-Negotiable Rules)
- [x] Cache-busting via `?v=<boot_ts>` on static assets
- [x] All timestamps render in ET via `Intl.DateTimeFormat`
- [x] Continuous MTM equity curve sourced from `equity_history.parquet`
