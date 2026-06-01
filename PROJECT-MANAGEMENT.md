# Project Management — Sentinel + Engines

This document is the operating manual for the three-repo platform: **Sentinel** (UI/UX platform) plus **PinSight** and **DriftEdge** (engines, no UI of their own). It governs how we build, test, document, deploy, and evolve the platform.

If you only read one section, read **The Five Rules** first.

---

## The Five Rules (non-negotiable)

These are load-bearing. Violating any of them costs hours of cleanup later.

1. **Sentinel contains zero engine code.** No `import pinsight`, no `import driftedge` ever appears anywhere under `~/dev/Sentinel/`. Inter-project communication happens via Parquet files and the contract spec. See `ARCHITECTURE.md` for the contract.

2. **Engines have no UI.** PinSight and DriftEdge expose CLIs and write data + logs. They do not ship dashboards. If you want a UI feature, it goes in Sentinel.

3. **The contract is law.** `CONTRACT-SPEC.md` (in this repo) defines the manifest, allocations, state, and audit-log formats. Changes to those formats require an explicit contract version bump and migration plan. Never change file shapes silently.

4. **No lookahead bias, ever.** Every function that reads historical market data takes an explicit `as_of_ts` argument and filters `snapshot_ts <= as_of_ts`. Assertions guard at boundaries. Tests prove invariance under future-data injection. See `~/dev/DriftEdge/docs/decisions/0004-no-lookahead-bias.md`.

5. **Storage is UTC, display is ET.** Every timestamp in any Parquet or JSONL file is ISO 8601 UTC. The conversion to `America/New_York` happens only at the display layer in Sentinel. Engines must never write local-time strings.

---

## Repository ownership

| Repo | Path | Owns |
|---|---|---|
| Sentinel | `~/dev/Sentinel` | UI/UX, dashboard, allocation control, audit display, news rendering, contract spec, this document |
| PinSight | `~/dev/PinSight` | 0DTE options data ingestion, flow detection, paper-trade eval, scheduled jobs |
| DriftEdge | `~/dev/DriftEdge` | Prediction-market data ingestion (Polymarket, Kalshi), multi-trader paper engine, classifier cache, news subsystem |

GitHub remotes (always push to these):
- https://github.com/tanishhky/Sentinel
- https://github.com/tanishhky/PinSight
- https://github.com/tanishhky/DriftEdge

Each repo has its own `.git/`, its own `main` branch, its own commits, its own README. They never share a `.git` folder.

---

## When you make a change, which repo does it go in?

| Change type | Goes in |
|---|---|
| Add a new tab to the dashboard | Sentinel |
| Add a new chart type | Sentinel |
| Change how the equity curve is computed for display | Sentinel |
| Change how an agent sizes positions | DriftEdge |
| Add a new venue (e.g., Manifold Markets) | DriftEdge |
| Add a new prediction-market sentiment source | DriftEdge |
| Add a new equity-options data adapter | PinSight |
| Change the PinSight scheduled-job times | PinSight |
| Tighten the no-lookahead test for any engine | The engine's own repo |
| Update the engine manifest (departments, agents, risk limits) | The engine's own repo |
| Update the contract spec | Sentinel |
| Update this project-management document | Sentinel |

If you're unsure, ask: **does this affect data flow / business logic / strategy?** → engine. **Does this affect what the user sees on the dashboard?** → Sentinel.

---

## Branching and commits

- `main` is always deployable.
- Direct commits to `main` are OK while it's still one developer. When a second developer joins, switch to feature branches + PRs.
- Commit messages: imperative, present tense, brief subject + paragraph body explaining the WHY.
- Co-Authored-By footer for AI-assisted commits.
- One concern per commit (refactor and feature in separate commits).
- Never amend a pushed commit. Always create a new one to fix.

---

## Documentation requirements

Every commit that adds or changes user-facing behavior MUST also update:

| Change | Update |
|---|---|
| New CLI subcommand | The engine's `README.md` |
| New API endpoint in Sentinel | The Sentinel `README.md` endpoints table |
| New manifest field | `CONTRACT-SPEC.md` + bump `manifest_version` per versioning policy |
| New ADR-worthy decision | A new `docs/decisions/NNNN-<slug>.md` ADR in the engine's repo |
| New library dependency | The relevant `pyproject.toml` |
| New launchd job or scheduled task | The repo's `scripts/launchd/README.md` |

If a PR changes behavior without changing docs, the docs are incomplete by definition.

---

## Testing requirements

| Code type | Required tests |
|---|---|
| Any function that reads historical market data | A no-lookahead test (T+k injection invariance) |
| Any sizing function | Math validation against known inputs + boundary conditions |
| Any data normalizer | Round-trip test (input → normalized → unnormalized → input') |
| Any classifier | Confidence-bucket counts plus regression test on known examples |
| Any API endpoint in Sentinel | Smoke test (200 status, schema match) |

Tests live in each repo's `tests/` directory. Run via `pytest`. Each repo's CI (when added) runs only its own tests.

---

## Engineering principles (the spirit, not the law)

1. **Observability is mandatory.** Every API call, every persist, every fit, every signal logs a structured JSONL event through the shared `obs.py` pattern. If you can't see it happen, it didn't happen.

2. **Honest defaults.** Hardcoded thresholds are explicitly labeled as `(hardcoded)` in UI tooltips. We don't pretend a heuristic is optimal.

3. **Schema validation at boundaries.** Parquet read → check declared columns exist. JSON input → validate structure. Failures are warnings, not silent acceptances.

4. **Failure modes are explicit.** When something doesn't work (missing file, rate limit, validation error), we surface it. We never silently fall through to a default that hides the problem.

5. **Caches always have invalidation paths.** Static asset cache busting via `?v=<boot_ts>`. Markdown-categories cache rebuilt on classifier-version bump. Engine config polling with stale-warning timeouts. No cache without a documented eviction strategy.

6. **No premature ML.** The classifier is rule-based because rules give 100% accuracy on confident matches and a clean fall-through to manual review. ML is justified only when we have ≥500 labeled examples and the simpler approach has been measured to fail.

---

## Adding a new engine (the workflow)

When you want to add a third engine (say, a fixed-income flow detector called "RatesBox"):

1. **Create the engine repo.** `~/dev/RatesBox`, its own git, its own README, its own data + logs dirs.
2. **Write its manifest.** `manifest/manifest.json` declaring departments, agents, schemas, UI tabs, capabilities. Use DriftEdge's manifest as the template.
3. **Implement the contract.** Allocations poller, state writer, audit-log writer. Use DriftEdge's `manifest_runtime.py` (when it exists) as the reference implementation.
4. **Add to Sentinel's engine registry.** One line in `~/dev/Sentinel/backend/src/sentinel/engines.json`.
5. **Test:** restart Sentinel. New top tab appears automatically with the sub-tabs declared in the manifest. New branch in the allocation tree.
6. **Document:** add a one-line entry in this file's repo-ownership table.

That's it. No changes to Sentinel code. No changes to PinSight or DriftEdge code.

---

## Operating cadence

| Cadence | What | Who |
|---|---|---|
| Every login | launchd auto-starts: Sentinel server, DriftEdge poll daemon, PinSight scheduled jobs | macOS launchd |
| Every 30s | Engine polls its allocations.json | Engine |
| Every 5s | Sentinel UI refreshes from state files | Sentinel UI |
| Every 15min | DriftEdge news sweep | DriftEdge poll daemon |
| Daily (around 09:35 ET) | PinSight morning chain fetch | launchd |
| Daily (around 16:10 ET) | PinSight close + eval-flags | launchd |
| Weekly | Review allocation-audit.jsonl + decide rebalances | Human (you) |
| Monthly | Review classifier-review queue, run `set_manual` for any markets needing decisions | Human (you) |

---

## When things go wrong

| Symptom | First diagnostic | Likely cause |
|---|---|---|
| Dashboard shows stale data | Check `state.json.config_state` per engine | Engine daemon stopped; restart with launchctl |
| Allocation change has no effect | Check `state.json.allocations_version_loaded` | Engine poll interval; wait 30s |
| New manifest field not showing up in UI | Manifest reload | Restart Sentinel (`launchctl unload && load`) |
| Engine refuses to start | `logs/launchd-poll.err` | Usually a Python import error after dep change |
| Charts not refreshing | Hard refresh (Cmd+Shift+R) | Cache; cache-busting should prevent this but verify |

---

## What we never do

- Hide failures behind silent fallbacks.
- Reuse a market id across venues (always key by `(venue, market_id)`).
- Push to remote without testing locally first.
- Use `--no-verify` to skip hooks.
- Force-push to `main` on any of the three repos.
- Embed UTC times in user-facing strings (always convert to ET).
- Add a dependency without updating `pyproject.toml`.
- Change manifest format without bumping `manifest_version`.
- Build UI in a repo other than Sentinel.

---

## Bookkeeping references

| Document | Owner repo | Purpose |
|---|---|---|
| `ARCHITECTURE.md` | Sentinel | Three-repo separation contract |
| `CONTRACT-SPEC.md` | Sentinel | Plug-in contract schema |
| `PROJECT-MANAGEMENT.md` | Sentinel | This document |
| `docs/decisions/0001-*.md` | per engine | ADR convention |
| `docs/decisions/0003-price-is-not-probability.md` | DriftEdge | Sizing discipline |
| `docs/decisions/0004-no-lookahead-bias.md` | DriftEdge | Lookahead discipline |
| `docs/research/papers.md` | per engine | Annotated bibliography |
| `docs/research/architecture.md` | per engine | Engine-internal design |
| `docs/research/data_sources.md` | per engine | Free-data evaluation |

Read this document and the four engineering principles in `CLAUDE.md` before making any change to the platform.
