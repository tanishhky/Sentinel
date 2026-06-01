# Sentinel Plug-in Contract Specification

**Version:** 1.0
**Status:** Approved 2026-06-01
**Owner:** Sentinel repo (canonical). Engines implement against this.

This is the load-bearing document. Every engine that wants to plug into Sentinel implements the contract defined here. Sentinel reads only what this contract describes. Once we ship a 1.0 contract, breaking changes require a new major version.

---

## The four-file pattern

Every engine maintains exactly four files. Each file has one writer. No write contention, no merge conflicts, no ambiguity about who owns what state.

```
<engine_root>/
├── manifest/
│   ├── manifest.json            STATIC.  Engine declares identity + capabilities.
│   │                            WRITER:  Engine repo maintainer (committed to git).
│   │                            READER:  Sentinel.
│   │
│   └── allocations.json         DYNAMIC. What Sentinel wants the engine to do.
│                                WRITER:  Sentinel (single writer, atomic replace).
│                                READER:  Engine (polls every config_poll_interval_s).
│
├── data/
│   └── state.json               DYNAMIC. What the engine actually observes.
│                                WRITER:  Engine (after every tick).
│                                READER:  Sentinel (every refresh).
│
└── logs/
    └── allocation-audit.jsonl   APPEND-ONLY. Immutable change history.
                                 WRITER:   Sentinel + engine (engine logs self-halts).
                                 READER:   Sentinel, human auditors.
```

**Design rules:**
- One writer per file, no exceptions.
- Writes must be atomic (write to `<file>.tmp`, then `os.replace` to final name).
- Readers must tolerate the file being momentarily absent (mid-replace).
- Readers MUST NOT cache file content beyond one read cycle.

---

## 1. `manifest/manifest.json` — static identity

Committed to the engine repo. Sentinel discovers an engine by reading its manifest.

### Top-level fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `manifest_version` | string | yes | Contract version. Must be `"1.0"` for v1 engines. |
| `engine` | object | yes | Engine identity. |
| `paths` | object | yes | Where the other three files live. |
| `capabilities` | object | yes | What this engine can do. |
| `departments` | array | yes | Logical trading groups. Can be empty for read-only engines. |
| `data_schemas` | array | yes | Parquet schemas the engine writes. |
| `ui` | object | yes | UI hints for Sentinel. |
| `lifecycle` | object | yes | Operational behavior. |
| `resources` | object | optional | Rate-limit + capacity declarations. |
| `observability` | object | optional | Log channels + metrics. |

### `engine`

```json
{
  "id": "driftedge",
  "name": "DriftEdge",
  "version": "0.5.0",
  "description": "Prediction markets multi-trader paper engine",
  "owner": "tanishk",
  "repo_url": "https://github.com/tanishhky/DriftEdge",
  "repo_path": "/Users/tanishkyadav/dev/DriftEdge"
}
```

`engine.id` MUST be unique across all engines in the Sentinel registry. Lowercase, snake_case, no spaces.

### `paths`

All paths absolute. Sentinel never traverses up from these.

```json
{
  "data_dir": "/Users/tanishkyadav/dev/DriftEdge/data",
  "log_dir":  "/Users/tanishkyadav/dev/DriftEdge/logs",
  "allocations_file": "/Users/tanishkyadav/dev/DriftEdge/manifest/allocations.json",
  "state_file":       "/Users/tanishkyadav/dev/DriftEdge/data/state.json",
  "audit_log":        "/Users/tanishkyadav/dev/DriftEdge/logs/allocation-audit.jsonl"
}
```

### `capabilities`

```json
{
  "venues":         ["polymarket", "kalshi"],
  "asset_classes":  ["prediction_markets"],
  "categories":     ["sports", "politics", "geopolitics", "crypto", "macro", "weather", "entertainment", "other"],
  "trade_types":    ["paper"],
  "execution_modes": ["passive_paper"]
}
```

Sentinel uses these for UI filtering and the engine-registry overview. Don't lie here — Sentinel may surface a feature that the engine then has to reject.

### `departments[]`

A department is a logical bucket of trading activity. Engine = many departments. Each department has its own filter (e.g., category list) and a list of agents.

```json
{
  "id": "polymarket_sports",
  "name": "Polymarket — Sports",
  "description": "Sports markets on Polymarket (NBA, NFL, soccer, tennis, etc.)",
  "venue": "polymarket",
  "category_filter": ["sports"],
  "agents": [ /* see below */ ]
}
```

Department `id` must be unique within the engine.

### `agents[]`

```json
{
  "id": "kelly",
  "name": "Quarter-Kelly",
  "description": "f* = (p − c) / (1 − c), p = 0.45 default, κ = 0.25 fractional",
  "default_budget_usd": 3000,
  "min_budget_usd": 100,
  "max_budget_usd": 50000,
  "risk_limits": {
    "max_single_position_pct": 0.02,
    "max_aggregate_exposure_pct": 0.50,
    "halt_on_drawdown_pct": 0.20
  },
  "operating_window": {
    "timezone": "America/New_York",
    "hours_of_day": ["00:00-23:59"],
    "weekdays_only": false
  }
}
```

**Risk limits are hard caps.** Sentinel cannot push past them. Even if a user tries to set `agent.budget_usd = $1M` for a Kelly with `max_budget_usd = $50k`, the engine refuses and Sentinel UI shows a validation error.

### `data_schemas[]`

Each Parquet the engine writes that Sentinel may read.

```json
{
  "name": "paper_trades",
  "path_pattern": "data/paper_trades.parquet",
  "write_mode": "append_dedup_on_primary_key",
  "columns": [
    { "name": "trade_id",   "type": "string", "primary_key": true },
    { "name": "trader",     "type": "string" },
    { "name": "venue",      "type": "string" },
    { "name": "category",   "type": "string" },
    { "name": "entry_ts",   "type": "iso8601_utc" },
    { "name": "exit_ts",    "type": "iso8601_utc", "nullable": true },
    { "name": "pnl_usd",    "type": "float", "nullable": true }
  ]
}
```

Types: `string`, `int`, `float`, `bool`, `iso8601_utc`, `json`. Nullable defaults to `false`.

Sentinel SHOULD validate at read time. If a column declared in the manifest is missing, Sentinel logs a warning and continues (forward-compatible). Extra columns are tolerated.

### `ui`

```json
{
  "tabs": [
    { "id": "paper",   "label": "PAPER",   "data_route": "/api/driftedge/paper",   "default_visible": true }
  ],
  "dashboard_kpis": [
    { "key": "summary.total_pnl_usd", "label": "Total P&L", "format": "currency" }
  ]
}
```

`format` ∈ {`currency`, `percent`, `int`, `float`, `string`, `timestamp`}.

### `lifecycle`

```json
{
  "supports_runtime_reallocation": true,
  "supports_pause": true,
  "supports_kill_switch": true,
  "config_poll_interval_s": 30,
  "config_stale_warning_s": 3600,
  "graceful_shutdown_timeout_s": 60
}
```

If `supports_runtime_reallocation` is `false`, Sentinel's UI will show "Restart required after change" for this engine.

---

## 2. `manifest/allocations.json` — desired state

Sentinel is the **only** writer. The engine polls this file every `config_poll_interval_s` seconds.

### Schema

```json
{
  "schema_version": "1.0",
  "updated_at": "2026-06-01T08:30:00-04:00",
  "updated_by": "user:tanishk via sentinel-ui",
  "engine_id": "driftedge",
  "global_kill_switch": false,
  "allocations": [
    {
      "department_id": "polymarket_sports",
      "enabled": true,
      "paused": false,
      "agents": [
        { "agent_id": "kelly", "enabled": true, "budget_usd": 4000 },
        { "agent_id": "equal", "enabled": true, "budget_usd": 2500 },
        { "agent_id": "volwt", "enabled": false, "budget_usd": 0 }
      ]
    }
  ]
}
```

### Semantics

| Field | Meaning |
|---|---|
| `global_kill_switch` | If `true`, engine halts ALL trading immediately. Open positions remain (no force-close). |
| `department.enabled` | If `false`, no new entries in this department. Existing positions drain naturally. |
| `department.paused` | If `true`, no new entries AND open positions skip their normal exit checks (frozen). Use sparingly. |
| `agent.enabled` | Per-agent disable. Same drain semantics as department. |
| `agent.budget_usd` | New ceiling. If lower than current open exposure, agent can't open new positions until exposure drains. No force-close. |

### Validation rules

The engine MUST validate `allocations.json` against its `manifest.json`. If invalid:
1. Engine logs an error to `audit_log` with `actor: "engine:<id>"`, `action: "config_rejected"`.
2. Engine keeps using the last-known-good allocations (cached in memory).
3. State file `config_state` field is set to `"rejected"`.

Common rejection reasons:
- Department ID referenced in allocations doesn't exist in manifest.
- Agent budget exceeds `max_budget_usd` or below `min_budget_usd`.
- Risk override exceeds manifest-declared hard limit.

### Atomic writes

Sentinel MUST write `allocations.json.tmp` and then `os.replace` to the final name. Engine reads with retry-on-missing.

---

## 3. `data/state.json` — observed state

Engine is the only writer. Written after every paper-tick or at most every 30 seconds (whichever is sooner).

### Schema

```json
{
  "schema_version": "1.0",
  "engine_id": "driftedge",
  "last_updated_at": "2026-06-01T08:30:42-04:00",
  "manifest_version_loaded": "1.0",
  "allocations_version_loaded": "2026-06-01T08:30:00-04:00",
  "config_state": "fresh",
  "config_last_checked_at": "2026-06-01T08:30:30-04:00",
  "departments": [
    {
      "department_id": "polymarket_sports",
      "halted": false,
      "halt_reason": null,
      "agents": [
        {
          "agent_id": "kelly",
          "configured_budget_usd": 4000,
          "current_equity_usd": 3924.50,
          "cash_usd": 3510.00,
          "open_exposure_usd": 414.50,
          "unrealized_pnl_usd": 12.30,
          "open_positions_count": 3,
          "closed_pnl_total_usd": -75.50,
          "drawdown_pct": 0.019,
          "halted": false,
          "halt_reason": null,
          "last_tick_at": "2026-06-01T08:30:30-04:00"
        }
      ]
    }
  ]
}
```

### `config_state` semantics

- `"fresh"` — engine has read the latest allocations.json successfully.
- `"stale"` — engine's last successful read was more than `config_stale_warning_s` seconds ago. Engine still uses last-known config.
- `"rejected"` — engine read allocations.json but rejected it (validation failure). See audit log for reason.
- `"missing"` — allocations.json doesn't exist. Engine uses manifest defaults.

---

## 4. `logs/allocation-audit.jsonl` — immutable log

Append-only. Both Sentinel and the engine write to this file. Never truncated. Never edited.

### Schema (one JSON object per line)

```jsonl
{"ts":"2026-06-01T08:30:00-04:00","actor":"user:tanishk","action":"reallocate","engine":"driftedge","department":"polymarket_sports","agent":"kelly","field":"budget_usd","before":3000,"after":4000,"reason":"kelly outperforming"}
{"ts":"2026-06-01T08:30:00-04:00","actor":"user:tanishk","action":"disable","engine":"driftedge","department":"polymarket_sports","agent":"volwt","reason":"underperforming"}
{"ts":"2026-06-01T09:15:22-04:00","actor":"engine:driftedge","action":"halt","engine":"driftedge","department":"polymarket_politics","agent":"equal","reason":"drawdown_pct 0.21 exceeded halt_on_drawdown_pct 0.20"}
{"ts":"2026-06-01T10:00:00-04:00","actor":"user:tanishk","action":"resume","engine":"driftedge","department":"polymarket_politics","agent":"equal","reason":"manual override"}
```

### Required fields

| Field | Required | Notes |
|---|---|---|
| `ts` | yes | ISO 8601 with timezone. |
| `actor` | yes | `user:<name>`, `engine:<id>`, `sentinel:system`. |
| `action` | yes | See action vocabulary below. |
| `engine` | yes | engine id this event concerns. |
| `reason` | optional but recommended | free-text. Human-readable. |
| (action-specific fields) | varies | See per-action schemas. |

### Action vocabulary

| Action | Required extra fields | Notes |
|---|---|---|
| `reallocate` | `department`, `agent`, `field`, `before`, `after` | Single field change. |
| `enable` / `disable` | `department`, `agent` | Toggle. |
| `pause` / `resume` | `department` | Department-level. |
| `halt` | `department`, `agent` | Agent self-halted. Engine writes this. |
| `kill_switch_on` / `kill_switch_off` | (none beyond engine) | Global kill. |
| `config_rejected` | `validation_error` | Engine rejected an allocations write. |

---

## Sentinel-side: engine registry

Sentinel maintains a single registry file:

`~/dev/Sentinel/backend/src/sentinel/engines.json`

```json
{
  "engines": [
    { "id": "pinsight",  "manifest_path": "/Users/tanishkyadav/dev/PinSight/manifest/manifest.json" },
    { "id": "driftedge", "manifest_path": "/Users/tanishkyadav/dev/DriftEdge/manifest/manifest.json" }
  ]
}
```

Adding a new engine = adding one entry. No Sentinel code change.

Sentinel reads the registry at startup, then loads each manifest, then renders the UI dynamically based on what each manifest declares.

---

## Lifecycle: how a reallocation flows

```
1. User opens Sentinel → ALLOCATION tab.
2. UI reads manifest.json + allocations.json + state.json for each engine.
3. UI renders tree: TOTAL → Engine → Department → Agent.
4. User changes Kelly budget in polymarket_sports from $3000 → $4000.
5. UI calls POST /api/sentinel/allocation with the new full allocations
   payload (or a JSON Patch — implementation choice).
6. Sentinel:
     a. Validates new allocation against manifest's hard limits.
     b. Atomically writes new allocations.json.
     c. Appends a `reallocate` line to audit_log.
     d. Returns 200 to the UI.
7. Engine's poll loop (≤30s later) reads allocations.json.
8. Engine validates against its manifest.
9. Engine updates in-memory config.
10. On next paper-tick, Kelly in polymarket_sports respects the new $4000 cap.
11. Engine writes updated state.json with `allocations_version_loaded` bumped
    and `config_state: "fresh"`.
12. UI's next refresh sees the updated state and the change is reflected.
```

---

## Validation rules summary

### Manifest validation (Sentinel at startup)

- `manifest_version` is supported.
- `engine.id` is unique in the registry.
- All paths exist (or are creatable).
- All agent budgets are between min/max.
- All risk limits are in (0, 1].

### Allocation validation (Sentinel + engine, both sides)

- All referenced department/agent ids exist in the manifest.
- All budgets are within manifest min/max.
- No risk override exceeds the manifest hard limit.
- Required fields present.

### Schema validation (Sentinel at data read time)

- Every column declared in `data_schemas` exists. Missing columns are warnings, not errors.
- Types match declarations. Type mismatches are warnings.

---

## Versioning policy

- `manifest_version` is the contract version (this document).
- `engine.version` is the engine's own semver.
- `allocations.schema_version` and `state.schema_version` track those file formats.
- Each version is independent.

**When this contract changes:**
- Backward-compatible additions (new optional fields): bump patch (1.0 → 1.0.1).
- Backward-compatible required additions (new required field with sensible default): bump minor (1.0 → 1.1).
- Breaking changes: bump major (1.0 → 2.0). Old engines must update or be marked deprecated in the registry.

---

## Implementation checklist

### Engine side (PinSight, DriftEdge, future engines)

- [ ] Write `manifest/manifest.json` declaring identity, departments, agents, schemas.
- [ ] Implement allocations.json poller with configurable interval.
- [ ] Implement allocations validation against own manifest.
- [ ] Cache last-known-good allocations in memory.
- [ ] Write state.json after every tick (atomic replace).
- [ ] Append to allocation-audit.jsonl on every self-halt or config rejection.
- [ ] Respect `enabled`, `paused`, `budget_usd`, `global_kill_switch` semantics.
- [ ] Never force-close positions on budget reduction.

### Sentinel side

- [ ] Read `engines.json` registry at startup.
- [ ] Load each engine's manifest.
- [ ] Render top tabs dynamically from manifest.ui.tabs (one per engine).
- [ ] Render allocation tree from manifest departments + agents.
- [ ] Validate user allocation changes against manifest hard limits.
- [ ] Atomic write of allocations.json with audit-log append.
- [ ] Refresh state.json display every 5 seconds.
- [ ] Show `config_state` indicator per engine (green/yellow/red).
- [ ] Tail allocation-audit.jsonl for an audit view.

---

## What this contract does NOT cover (out of scope for v1.0)

- Multi-user authentication / authorization.
- Live (real-money) execution. Only paper for now.
- Cross-engine arbitrage signals.
- Remote engines (engines run on a different machine).
- Engine-to-engine messaging.

These are valid v2.0 extensions but not part of this contract.

---

## How to evolve this contract

1. Open a draft PR against this file with the proposed change.
2. List affected engines and how each will migrate.
3. Get explicit approval from the platform owner before merging.
4. Bump `manifest_version` per the versioning policy.
5. Update both engine implementations together.
6. Run end-to-end test with the new contract.
7. Merge and tag.

**Never change this document silently.** Every change to the contract is an architectural decision that must be reviewed.
