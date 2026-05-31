// Sentinel vanilla JS frontend
// Single-page tabbed dashboard. Polls /api/* every 5s.

const TABS = [
  { id: "overview",   label: "OVERVIEW",            render: renderOverview },
  { id: "ps-chain",   label: "PINSIGHT · CHAIN",    render: renderPSChain },
  { id: "ps-flags",   label: "PINSIGHT · FLAGS",    render: renderPSFlags },
  { id: "de-markets", label: "DRIFTEDGE · MARKETS", render: renderDEMarkets },
  { id: "de-books",   label: "DRIFTEDGE · BOOKS",   render: renderDEBooks },
  { id: "de-paper",   label: "DRIFTEDGE · PAPER",   render: renderDEPaper },
  { id: "logs-pin",   label: "LOGS · PINSIGHT",     render: () => renderLogs("pinsight") },
  { id: "logs-de",    label: "LOGS · DRIFTEDGE",    render: () => renderLogs("driftedge") },
];

let activeTab = "overview";
let refreshTimer = null;

function init() {
  const tabsEl = document.getElementById("tabs");
  TABS.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tab" + (t.id === activeTab ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => { activeTab = t.id; rerender(); };
    tabsEl.appendChild(b);
  });

  // Clock
  const clock = document.getElementById("clock");
  setInterval(() => {
    clock.textContent = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
  }, 1000);

  rerender();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(rerender, 5000);
}

function rerender() {
  document.querySelectorAll(".tab").forEach((el, i) => {
    el.classList.toggle("active", TABS[i].id === activeTab);
  });
  const tab = TABS.find((t) => t.id === activeTab);
  if (tab) tab.render();
}

// ──────────────── helpers ────────────────

async function jget(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function set(html) {
  document.getElementById("content").innerHTML = html;
}

function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits
  });
}

function fmtInt(n) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}

function kpi(label, value, sub) {
  return `<div class="card"><div class="kpi-label">${label}</div>
    <div class="kpi-value">${value ?? "—"}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
  </div>`;
}

// ──────────────── tabs ────────────────

async function renderOverview() {
  try {
    const [chain, flags, markets, books] = await Promise.all([
      jget("/api/pinsight/chain"),
      jget("/api/pinsight/flags?top=5"),
      jget("/api/driftedge/markets?top=5"),
      jget("/api/driftedge/books"),
    ]);
    const ps = chain?.status === "ok";
    set(`
      <div class="grid grid-6">
        ${kpi("PinSight · Chain", ps ? chain.contracts : "—", ps ? `${chain.underlying} · ${chain.expiry}` : "")}
        ${kpi("PinSight · Underlying", ps ? `$${fmt(chain.underlying_price)}` : "—")}
        ${kpi("PinSight · Flags", flags?.count ?? "—")}
        ${kpi("DriftEdge · Markets", markets?.count ?? "—", markets?.snapshot_ts?.slice(11, 19) ?? "")}
        ${kpi("DriftEdge · Books", books?.count ?? "—")}
        ${kpi("System", "<span class='pos'>● LIVE</span>", "auto-refresh 5s")}
      </div>
      <div class="grid grid-2" style="margin-top:16px">
        <div class="card">
          <div class="card-title">PINSIGHT TOP FLAGS</div>
          ${(flags?.items ?? []).slice(0, 5).map(f => `
            <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px">
              <span class="${f.type === 'put' ? 'neg' : 'pos'}">${f.type} ${fmt(f.strike, 0)}</span>
              <span class="amber">${f.v_over_oi}x</span>
            </div>`).join('') || '<div class="muted">No flags</div>'}
        </div>
        <div class="card">
          <div class="card-title">DRIFTEDGE TOP MARKETS</div>
          ${(markets?.items ?? []).slice(0, 5).map(m => `
            <div style="padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px">
              <div style="display:flex;justify-content:space-between">
                <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px">${m.question}</span>
                <span class="amber">${fmt(m.yes_price, 3)}</span>
              </div>
            </div>`).join('') || '<div class="muted">No markets</div>'}
        </div>
      </div>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderPSChain() {
  try {
    const d = await jget("/api/pinsight/chain");
    if (d.status !== "ok") {
      set(`<div class="muted">No chain data yet. Run <code>pinsight fetch-chain SPY</code>.</div>`);
      return;
    }
    set(`
      <div class="grid grid-4" style="margin-bottom:16px">
        ${kpi("Underlying", d.underlying)}
        ${kpi("Spot", `$${fmt(d.underlying_price)}`)}
        ${kpi("Expiry", d.expiry)}
        ${kpi("Contracts", `${d.contracts} (${d.calls}C/${d.puts}P)`)}
      </div>
      <div class="card">
        <div class="card-title">SNAPSHOT METADATA</div>
        <table>
          <tbody>
            <tr><td class="muted">Snapshot UTC</td><td>${d.snapshot_ts ?? "—"}</td></tr>
            <tr><td class="muted">Call volume</td><td class="r">${fmtInt(d.total_call_vol)}</td></tr>
            <tr><td class="muted">Put volume</td><td class="r">${fmtInt(d.total_put_vol)}</td></tr>
            <tr><td class="muted">File</td><td class="muted" style="font-size:10px">${d.file_path}</td></tr>
          </tbody>
        </table>
      </div>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderPSFlags() {
  try {
    const d = await jget("/api/pinsight/flags?top=30");
    if (d.status !== "ok" || !d.items?.length) {
      set(`<div class="muted">No flagged contracts.</div>`);
      return;
    }
    set(`
      <div class="muted mono" style="margin-bottom:12px">
        ${d.count} flagged contracts (vol/OI ≥ 1, volume ≥ 1000) — sorted by vol/OI desc
      </div>
      <table>
        <thead><tr>
          <th>Underlying</th><th>Expiry</th><th>Type</th>
          <th class="r">Strike</th><th class="r">Volume</th><th class="r">OI</th>
          <th class="r">Vol/OI</th><th class="r">IV</th>
        </tr></thead>
        <tbody>
          ${d.items.map(r => `<tr>
            <td class="amber">${r.underlying}</td>
            <td>${r.expiry}</td>
            <td class="${r.type === 'put' ? 'neg' : 'pos'}">${r.type}</td>
            <td class="r">${fmt(r.strike, 0)}</td>
            <td class="r">${fmtInt(r.volume)}</td>
            <td class="r">${fmtInt(r.open_interest)}</td>
            <td class="r amber">${r.v_over_oi}</td>
            <td class="r">${r.iv != null ? fmt(r.iv, 3) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderDEMarkets() {
  try {
    const d = await jget("/api/driftedge/markets?top=50");
    if (d.status !== "ok") {
      set(`<div class="muted">No DriftEdge data yet.</div>`);
      return;
    }
    set(`
      <div class="muted mono" style="margin-bottom:12px">
        Snapshot: ${d.snapshot_ts ?? "—"} · ${d.count} markets · sorted by 24h volume
      </div>
      <table>
        <thead><tr>
          <th>Question</th><th class="r">Yes</th><th class="r">No</th>
          <th class="r">Spread</th><th class="r">Vol 24h</th><th>End</th>
        </tr></thead>
        <tbody>
          ${d.items.map(r => `<tr>
            <td class="ell">${r.question ?? ''}</td>
            <td class="r pos">${fmt(r.yes_price, 3)}</td>
            <td class="r neg">${fmt(r.no_price, 3)}</td>
            <td class="r muted">${r.spread != null ? fmt(r.spread, 3) : '—'}</td>
            <td class="r amber">$${fmtInt(r.volume_24h)}</td>
            <td class="muted" style="font-size:10px">${r.end_date?.slice(0, 10) ?? ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderDEBooks() {
  try {
    const d = await jget("/api/driftedge/books");
    if (d.status !== "ok" || !d.items?.length) {
      set(`<div class="muted">No orderbook snapshots yet. Start the DriftEdge poll daemon.</div>`);
      return;
    }
    set(`
      <div class="muted mono" style="margin-bottom:12px">
        ${d.count} markets tracked · sorted by most recent activity
      </div>
      <table>
        <thead><tr>
          <th>Market ID</th>
          <th class="r">Snapshots today</th>
          <th>Last snapshot</th>
          <th>File mtime</th>
        </tr></thead>
        <tbody>
          ${d.items.map(r => `<tr>
            <td class="amber">${r.market_id}</td>
            <td class="r">${r.snapshot_count_today}</td>
            <td class="muted">${r.last_snapshot_ts ?? '—'}</td>
            <td class="muted">${r.file_mtime}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderDEPaper() {
  try {
    const d = await jget("/api/driftedge/paper");
    if (d.status !== "ok") {
      set(`<div class="muted">No paper trades yet. The poll daemon opens them automatically when markets enter the [0.30, 0.40] zone.</div>`);
      return;
    }
    const s = d.summary;
    const pnlClass = s.total_pnl_usd > 0 ? "pos" : s.total_pnl_usd < 0 ? "neg" : "muted";
    const avgClass = s.avg_pnl_per_trade > 0 ? "pos" : s.avg_pnl_per_trade < 0 ? "neg" : "muted";
    set(`
      <div class="grid grid-6" style="margin-bottom:16px">
        ${kpi("Total trades", s.total_trades)}
        ${kpi("Open", s.open_count)}
        ${kpi("Closed", s.closed_count)}
        ${kpi("Hit rate", s.hit_rate != null ? (s.hit_rate * 100).toFixed(1) + '%' : '—')}
        ${kpi("Total P&L", `<span class="${pnlClass}">$${fmt(s.total_pnl_usd, 2)}</span>`)}
        ${kpi("Avg/trade", s.avg_pnl_per_trade != null ? `<span class="${avgClass}">$${fmt(s.avg_pnl_per_trade, 2)}</span>` : '—')}
      </div>
      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">OPEN POSITIONS (${d.open.length})</div>
          ${d.open.length ? `<table>
            <thead><tr><th>Question</th><th class="r">Entry</th><th class="r">Tgt</th><th class="r">Stop</th><th>Opened</th></tr></thead>
            <tbody>${d.open.map(r => `<tr>
              <td class="ell" style="max-width:300px">${r.question ?? ''}</td>
              <td class="r amber">${fmt(r.entry_price, 3)}</td>
              <td class="r pos">${fmt(r.target, 2)}</td>
              <td class="r neg">${fmt(r.stop, 2)}</td>
              <td class="muted" style="font-size:10px">${r.entry_ts?.slice(11, 19) ?? ''}</td>
            </tr>`).join('')}</tbody>
          </table>` : '<div class="muted">No open positions.</div>'}
        </div>
        <div class="card">
          <div class="card-title">EXIT REASONS</div>
          ${Object.entries(s.exit_reasons || {}).map(([k, v]) =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px">
              <span class="amber">${k}</span><span>${v}</span>
            </div>`).join('') || '<div class="muted">No closed trades yet.</div>'}
        </div>
      </div>
      <div class="card">
        <div class="card-title">CLOSED POSITIONS (most recent 30)</div>
        ${d.closed.length ? `<table>
          <thead><tr><th>Question</th><th class="r">Entry</th><th class="r">Exit</th><th>Reason</th><th class="r">P&L</th></tr></thead>
          <tbody>${d.closed.map(r => {
            const cls = r.pnl_usd > 0 ? "pos" : r.pnl_usd < 0 ? "neg" : "muted";
            return `<tr>
              <td class="ell" style="max-width:340px">${r.question ?? ''}</td>
              <td class="r">${fmt(r.entry_price, 3)}</td>
              <td class="r">${r.exit_price != null ? fmt(r.exit_price, 3) : '—'}</td>
              <td class="amber">${r.exit_reason ?? ''}</td>
              <td class="r ${cls}">${r.pnl_usd != null ? '$' + fmt(r.pnl_usd, 2) : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<div class="muted">No closed trades yet.</div>'}
      </div>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderLogs(source) {
  try {
    const d = await jget(`/api/logs/${source}?max_lines=200`);
    const events = d.events ?? [];
    if (!events.length) {
      set(`<div class="muted">No log events today for ${source}.</div>`);
      return;
    }
    const html = events.map(e => {
      const fields = Object.entries(e)
        .filter(([k]) => !["ts", "channel", "kind", "level", "run_id"].includes(k))
        .map(([k, v]) => `<span class="log-field">${k}=<b>${
          typeof v === 'object' ? JSON.stringify(v) : String(v)
        }</b></span>`).join(' ');
      return `<div class="log-line log-${(e.level ?? "info").toLowerCase()}"><span class="log-ts">${e.ts?.slice(11, 23)}</span><span class="log-channel">${e.channel}</span><span class="log-kind">${e.kind}</span>${fields}</div>`;
    }).reverse().join('');
    set(`<div class="card"><div class="logs">${html}</div></div>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

document.addEventListener("DOMContentLoaded", init);
