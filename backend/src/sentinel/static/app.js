// Sentinel vanilla JS frontend — two-level tab structure + Chart.js charts
//
// Top-level:  DASHBOARD | PINSIGHT | DRIFTEDGE | SENTINEL
// Sub-level:  per-section navigation under each top tab
// Auto-refresh: every 5s

const TOP_TABS = [
  { id: "dashboard", label: "DASHBOARD" },
  { id: "pinsight",  label: "PINSIGHT" },
  { id: "driftedge", label: "DRIFTEDGE" },
  { id: "sentinel",  label: "SENTINEL" },
];

const SUB_TABS = {
  pinsight: [
    { id: "paper", label: "PAPER", render: renderPSPaper },
    { id: "chain", label: "CHAIN", render: renderPSChain },
    { id: "flags", label: "FLAGS", render: renderPSFlags },
    { id: "logs",  label: "LOGS",  render: () => renderLogs("pinsight") },
  ],
  driftedge: [
    { id: "paper",   label: "PAPER",   render: renderDEPaper },
    { id: "returns", label: "RETURNS", render: renderDEReturns },
    { id: "markets", label: "MARKETS", render: renderDEMarkets },
    { id: "books",   label: "BOOKS",   render: renderDEBooks },
    { id: "news",    label: "NEWS",    render: renderDENews },
    { id: "logs",    label: "LOGS",    render: () => renderLogs("driftedge") },
  ],
  sentinel: [
    { id: "health", label: "HEALTH", render: renderSEHealth },
  ],
};

let activeTop = "dashboard";
let activeSub = { pinsight: "paper", driftedge: "paper", sentinel: "health" };
let refreshTimer = null;
let chartRegistry = {};
let renderInFlight = false;      // prevents overlapping refresh cycles
let fetchCtl = new AbortController();  // aborted on tab switch
let connOk = null;               // null until first status poll resolves
let engineStatus = null;         // last /api/status payload
let lastUpdText = "—";           // last successful content refresh (ET)

// Known-trader presentation metadata. Anything NOT listed still renders
// (deterministic fallback color, id as label): the roster itself comes from
// the API (equity-history active_traders), so engine retirements/additions
// need no Sentinel edit.
const TRADER_META = {
  kelly:      { color: "#ff9000", label: "KELLY",       desc: "Calibrated fractional Kelly · EV-gated" },
  equal:      { color: "#00d4ff", label: "EQUAL-WT",    desc: "Fixed 2% per trade · evidence baseline" },
  volharvest: { color: "#88ff66", label: "VOL-HARVEST", desc: "Underdog YES + early-exit harvest · adaptive horizon" },
  volwt:      { color: "#ff66cc", label: "VOL-WT",      desc: "RETIRED 2026-07-04 · duplicate of EQUAL" },
  resolution: { color: "#ff4466", label: "RESOLUTION",  desc: "RETIRED 2026-07-04 · no edge" },
  edge_buyer: { color: "#88ff66", label: "EDGE_BUYER",  desc: "RND edge buyer · divergence-gated · Kelly-sized" },
};
const FALLBACK_PALETTE = ["#ffd700", "#7fffd4", "#ff8c69", "#b0e0e6", "#dda0dd", "#98fb98"];
let ROSTER = ["kelly", "equal", "volharvest"];  // refreshed from API payloads

function traderColor(t) {
  if (TRADER_META[t]) return TRADER_META[t].color;
  let h = 0;
  for (const ch of String(t)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FALLBACK_PALETTE[h % FALLBACK_PALETTE.length];
}
function traderLabel(t) { return TRADER_META[t] ? TRADER_META[t].label : String(t).toUpperCase(); }
function traderDesc(t)  { return TRADER_META[t] ? TRADER_META[t].desc : ""; }

// Derive the active roster from API payloads. Preference order: the
// backend's active_traders (recency-based, excludes retired), then the
// union of series/by_trader keys as a fallback.
function updateRoster(eq, paper) {
  let r = (eq && eq.active_traders && eq.active_traders.length)
    ? [...eq.active_traders] : null;
  if (!r) {
    const keys = new Set();
    if (eq && eq.series) Object.keys(eq.series).forEach(k => keys.add(k));
    if (paper && paper.summary && paper.summary.by_trader)
      Object.keys(paper.summary.by_trader).forEach(k => keys.add(k));
    r = [...keys];
  }
  if (r.length) ROSTER = r.sort();
  return ROSTER;
}

function init() {
  const topTabsEl = document.getElementById("top-tabs");
  TOP_TABS.forEach(t => {
    const b = document.createElement("button");
    b.className = "tab" + (t.id === activeTop ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => { activeTop = t.id; navigate(); };
    topTabsEl.appendChild(b);
  });

  const clock = document.getElementById("clock");
  setInterval(() => {
    clock.textContent = fmtTsLocal(new Date()) + " ET";
  }, 1000);

  renderChrome();
  refreshContent(true);
  pollStatus();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => refreshContent(false), 5000);
  setInterval(pollStatus, 5000);

  // Catch up immediately when the tab regains focus instead of waiting
  // for the next interval tick.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshContent(true); pollStatus(); }
  });
}

function tabKey() {
  return activeTop + ":" + (activeSub[activeTop] || "");
}

// User navigation: abort any in-flight fetches so a slow response for the
// old tab can't overwrite the new tab's content, then render immediately.
function navigate() {
  fetchCtl.abort();
  fetchCtl = new AbortController();
  renderInFlight = false;
  renderChrome();
  refreshContent(true);
}

// Tab/subtab chrome is rebuilt only on navigation, not on refresh ticks.
function renderChrome() {
  document.querySelectorAll("#top-tabs .tab").forEach((el, i) => {
    el.classList.toggle("active", TOP_TABS[i].id === activeTop);
  });

  const subTabsEl = document.getElementById("sub-tabs");
  subTabsEl.innerHTML = "";
  const subs = SUB_TABS[activeTop];
  if (subs) {
    subs.forEach(s => {
      const b = document.createElement("button");
      b.className = "subtab" + (s.id === activeSub[activeTop] ? " active" : "");
      b.textContent = s.label;
      b.onclick = () => { activeSub[activeTop] = s.id; navigate(); };
      subTabsEl.appendChild(b);
    });
    subTabsEl.style.display = "";
  } else {
    subTabsEl.style.display = "none";
  }
}

async function refreshContent(force) {
  if (renderInFlight) return;              // never overlap refresh cycles
  if (!force && document.hidden) return;   // don't burn cycles in background
  renderInFlight = true;
  try {
    if (activeTop === "dashboard") {
      await renderDashboard();
    } else {
      const subs = SUB_TABS[activeTop];
      const sub = subs && subs.find(s => s.id === activeSub[activeTop]);
      if (sub) await sub.render();
    }
  } finally {
    renderInFlight = false;
  }
}

async function jget(path) {
  const r = await fetch(path, { signal: fetchCtl.signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ───── Timezone helpers — storage is UTC, display is America/New_York ─────
const TZ = "America/New_York";

function fmtTsLocal(d) {
  // YYYY-MM-DD HH:MM:SS in ET
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d.getTime())) return "—";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function fmtTimeLocal(d) {
  // HH:MM:SS in ET (for table cells)
  if (!(d instanceof Date)) d = new Date(d);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).format(d);
}

// Atomic content swap. Charts are destroyed only here — i.e. only once the
// replacement HTML is fully built from fetched data — so the old charts stay
// painted right up to the single-frame swap. This is what stops the
// "graph disappears then reappears" flash on every refresh tick.
function set(html) {
  Object.values(chartRegistry).forEach(c => { try { c.destroy(); } catch (e) {} });
  chartRegistry = {};
  const content = document.getElementById("content");
  content.innerHTML = html;
  content.dataset.tab = tabKey();
  markUpdated();
}

// Soft variant for "no data yet" branches: if this tab already shows real
// content, keep it (a transient empty/error payload mid-write must not wipe
// a working view). Only paints the message when the tab has nothing yet.
function setSoft(html) {
  const content = document.getElementById("content");
  if (content.dataset.tab === tabKey()) return;
  set(html);
}

// Fetch/render failure: keep the last good view, light the banner. Only
// paints the error when the tab has no content at all (first load).
function renderError(e) {
  if (e && e.name === "AbortError") return;  // navigation cancelled us
  console.warn("[sentinel] refresh failed:", e);
  noteConnection(false);
  const content = document.getElementById("content");
  if (content.dataset.tab === tabKey()) return;
  content.innerHTML = `<div class="neg">Error: ${e.message}</div>`;
  content.dataset.tab = tabKey();
}

function noteConnection(ok) {
  connOk = ok;
  const banner = document.getElementById("conn-banner");
  if (banner) banner.hidden = !!ok;
}

function markUpdated() {
  noteConnection(true);
  lastUpdText = fmtTimeLocal(new Date());
  const el = document.getElementById("last-upd");
  if (el) el.textContent = "UPD " + lastUpdText;
}

// ───── Header status lights ─────

const STATE_LABEL = {
  live: "LIVE", idle: "IDLE", error: "ERROR",
  stopped: "STOPPED", unknown: "?",
};

function fmtAge(s) {
  if (s == null) return "never";
  if (s < 90) return Math.round(s) + "s";
  if (s < 5400) return Math.round(s / 60) + "m";
  if (s < 172800) return (s / 3600).toFixed(1) + "h";
  return (s / 86400).toFixed(1) + "d";
}

function statusItem(label, state, tip) {
  return `<span class="status-item" title="${tip}">
    <span class="dot ${state}"></span>${label}</span>`;
}

async function pollStatus() {
  // Deliberately not on fetchCtl: tab switches must not abort the poll.
  try {
    const r = await fetch("/api/status");
    if (!r.ok) throw new Error("HTTP " + r.status);
    engineStatus = await r.json();
    noteConnection(true);
  } catch (e) {
    engineStatus = null;
    noteConnection(false);
  }
  renderStatusLights();
}

function renderStatusLights() {
  const el = document.getElementById("status-lights");
  if (!el) return;
  const items = [];
  items.push(statusItem("SENTINEL", connOk ? "live" : "error",
    connOk ? "Sentinel server reachable" : "Sentinel server unreachable"));
  for (const [label, key] of [["PINSIGHT", "pinsight"], ["DRIFTEDGE", "driftedge"]]) {
    const e = engineStatus && engineStatus.engines && engineStatus.engines[key];
    if (!e) {
      items.push(statusItem(label, "unknown", "no status available"));
      continue;
    }
    const tip = `${STATE_LABEL[e.state] || e.state} · last activity ` +
      (e.age_s != null ? fmtAge(e.age_s) + " ago" : "never") +
      (e.last_activity_ts ? ` (${fmtTsLocal(e.last_activity_ts)} ET)` : "");
    items.push(statusItem(label, e.state, tip));
  }
  el.innerHTML = `<span class="status-cluster">${items.join("")}
    <span class="status-upd" id="last-upd">UPD ${lastUpdText}</span></span>`;
}

function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}
function fmtInt(n) {
  if (n == null) return "—";
  return Math.round(n).toLocaleString();
}
function signClass(v) {
  if (v == null) return "muted";
  return v > 0 ? "pos" : v < 0 ? "neg" : "muted";
}
function signFmt(v, d = 2) {
  if (v == null) return "—";
  const sign = v >= 0 ? "+" : "";
  return sign + fmt(v, d);
}
function kpi(label, value, sub) {
  return `<div class="card"><div class="kpi-label">${label}</div>
    <div class="kpi-value">${value ?? "—"}</div>
    ${sub ? `<div class="kpi-sub">${sub}</div>` : ""}
  </div>`;
}

const CHART_TIME_OPTS = {
  type: "time",
  adapters: { date: { zone: "America/New_York" } },
  time: { unit: "hour", displayFormats: { hour: "MMM-d HH:mm", minute: "HH:mm" }},
  ticks: { color: "#666666", font: { family: "JetBrains Mono, monospace", size: 10 } },
  grid: { color: "#1a1a1a" },
};

const CHART_BASE = {
  responsive: true,
  maintainAspectRatio: false,
  // No entry animation: charts are rebuilt on every refresh tick, and an
  // animated rebuild reads as "the graph vanished and came back."
  animation: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: {
      labels: {
        color: "#ffffff",
        font: { family: "JetBrains Mono, monospace", size: 11 },
      },
    },
    tooltip: {
      backgroundColor: "#111111",
      titleColor: "#ff9000",
      bodyColor: "#ffffff",
      borderColor: "#2a2a2a",
      borderWidth: 1,
    },
  },
  scales: {
    x: {
      ticks: { color: "#666666", font: { family: "JetBrains Mono, monospace", size: 10 } },
      grid: { color: "#1a1a1a" },
    },
    y: {
      ticks: { color: "#666666", font: { family: "JetBrains Mono, monospace", size: 10 } },
      grid: { color: "#1a1a1a" },
    },
  },
};

function mkChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el) return null;
  const ctx = el.getContext("2d");
  const chart = new Chart(ctx, config);
  chartRegistry[canvasId] = chart;
  return chart;
}

async function renderDashboard() {
  try {
    const [paper, eq, chain, markets, status] = await Promise.all([
      jget("/api/driftedge/paper"),
      jget("/api/driftedge/paper/equity-history"),
      jget("/api/pinsight/chain"),
      jget("/api/driftedge/markets?top=5"),
      jget("/api/status"),
    ]);

    updateRoster(eq, paper);
    const s = paper.summary || {};
    const t = s.by_trader || {};
    const ps = chain?.status === "ok";
    const de = (status.engines && status.engines.driftedge) || {};

    set(`
      <div class="grid grid-4" style="margin-bottom:16px">
        ${kpi("PinSight chain", ps ? chain.contracts : "—",
              ps ? `${chain.underlying} · ${chain.expiry}` : "(no chain yet)")}
        ${kpi("Spot", ps ? `$${fmt(chain.underlying_price)}` : "—")}
        ${kpi("DriftEdge engine", STATE_LABEL[de.state] || "—",
              `${de.data_size_mb ?? "—"} MB archived · last activity ${fmtAge(de.age_s)}${de.age_s != null ? " ago" : ""}`)}
        ${kpi("Paper trades", s.total_trades ?? 0,
              `${s.open_count ?? 0} open · ${s.closed_count ?? 0} closed`)}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">PORTFOLIO VALUE · ${ROSTER.length} TRADERS · $10,000 BANKROLL EACH
          <span class="muted" style="font-weight:normal;font-size:10px">(cash + MTM of open positions)</span></div>
        <div class="chart-wrap tall"><canvas id="equityChart"></canvas></div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(${ROSTER.length},1fr);gap:12px;margin-bottom:16px">
        ${ROSTER.map(id => {
          const x = t[id] || {};
          const ret = x.return_pct;
          const retClass = signClass(ret);
          return `<div class="card">
            <div class="card-title" style="color:${traderColor(id)};font-size:10px">${traderLabel(id)}</div>
            <div class="muted mono" style="font-size:9px;margin-bottom:6px">${traderDesc(id)}</div>
            <div class="kpi-value mono ${retClass}" style="font-size:16px">${ret != null ? signFmt(ret, 3) + "%" : "—"}</div>
            <div class="muted mono" style="font-size:10px">$${fmt(x.total_equity ?? 0, 2)}</div>
          </div>`;
        }).join("")}
      </div>

      <div class="card">
        <div class="card-title">DRIFTEDGE TOP 5 MARKETS</div>
        ${(markets.items || []).slice(0, 5).map(m => `
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px">
            <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60%">${m.question}</span>
            <span><span class="pos">${fmt(m.yes_price, 3)}</span> · <span class="amber">$${fmtInt(m.volume_24h)}</span></span>
          </div>`).join("") || '<div class="muted">No data.</div>'}
      </div>
    `);

    drawPortfolioChart("equityChart", eq);
  } catch (e) {
    renderError(e);
  }
}

function drawHistogramChart(canvasId, dist, color) {
  if (!dist || dist.status !== "ok") return;
  const edges = dist.bins;
  const labels = [];
  for (let i = 0; i < edges.length - 1; i++) {
    labels.push(((edges[i] + edges[i + 1]) / 2).toFixed(2));
  }
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  mkChart(canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Trades",
        data: dist.counts,
        backgroundColor: color || "#ff9000",
        borderColor: color || "#ff9000",
        borderWidth: 1,
        categoryPercentage: 1.0,
        barPercentage: 1.0,
      }],
    },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        legend: { display: false },
      },
      scales: {
        x: {
          ...CHART_BASE.scales.x,
          ticks: {
            ...CHART_BASE.scales.x.ticks,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            callback: function (v) {
              const lab = this.getLabelForValue(v);
              return (parseFloat(lab) >= 0 ? "+" : "") + lab;
            },
          },
          grid: { color: "#1a1a1a" },
        },
        y: {
          ...CHART_BASE.scales.y,
          beginAtZero: true,
          ticks: {
            ...CHART_BASE.scales.y.ticks,
            stepSize: 1,
            precision: 0,
          },
        },
      },
    },
  });
}

// Portfolio Value — smooth continuous MTM (cash + current market value of open positions).
// Moves every tick as book mids shift. Shows live performance.
function drawPortfolioChart(canvasId, eq) {
  if (eq.status !== "ok") return;
  const datasets = [];
  for (const trader of ROSTER) {
    const series = eq.series[trader];
    if (!series || !series.length) continue;
    datasets.push({
      label: traderLabel(trader),
      data: series.map(p => ({ x: p.ts, y: p.equity })),
      borderColor: traderColor(trader),
      backgroundColor: traderColor(trader) + "22",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.3,
      fill: false,
    });
  }
  mkChart(canvasId, {
    type: "line",
    data: { datasets },
    options: {
      ...CHART_BASE,
      scales: {
        x: CHART_TIME_OPTS,
        y: { ...CHART_BASE.scales.y,
             ticks: { ...CHART_BASE.scales.y.ticks,
                      callback: v => "$" + v.toLocaleString() }},
      },
    },
  });
}

// Equity curve — available cash in hand. Drops when a position is opened
// (capital deployed), recovers on close (cash returned ± P&L). Stepped
// because cash only changes on transaction events, not market prices.
function drawEquityChart(canvasId, eq) {
  if (eq.status !== "ok") return;
  const datasets = [];
  for (const trader of ROSTER) {
    const series = eq.series[trader];
    if (!series || !series.length) continue;
    datasets.push({
      label: traderLabel(trader),
      data: series.map(p => ({ x: p.ts, y: p.cash ?? (p.equity - (p.mtm || 0)) })),
      borderColor: traderColor(trader),
      backgroundColor: traderColor(trader) + "33",
      borderWidth: 1.5,
      pointRadius: 0,
      pointHoverRadius: 4,
      stepped: "before",
      tension: 0,
    });
  }
  mkChart(canvasId, {
    type: "line",
    data: { datasets },
    options: {
      ...CHART_BASE,
      scales: {
        x: CHART_TIME_OPTS,
        y: { ...CHART_BASE.scales.y,
             ticks: { ...CHART_BASE.scales.y.ticks,
                      callback: v => "$" + v.toLocaleString() }},
      },
    },
  });
}

// ──────────────── INVESTMENT RETURNS ────────────────
// Three modes:
//   abs          — $ absolute P&L (closed + MTM unrealized)
//   pct_bankroll — P&L as % of starting bankroll ($10 k)
//   pct_deployed — P&L as % of capital currently in positions (open_exposure)
//                  shows "efficiency" of deployed capital; meaningful when >0

let returnsMode = "abs";

// Floating tooltip for (ⓘ) icons — shared across the whole page.
let _tipEl = null;
function showTip(anchor, text) {
  hideTip();
  _tipEl = document.createElement("div");
  _tipEl.style.cssText = `
    position:fixed; z-index:9999; max-width:280px;
    background:#1a1a1a; border:1px solid #333; color:#ccc;
    font-family:var(--mono); font-size:11px; line-height:1.5;
    padding:8px 10px; border-radius:3px;
    pointer-events:none; white-space:pre-line;
  `;
  _tipEl.textContent = text;
  document.body.appendChild(_tipEl);
  const r = anchor.getBoundingClientRect();
  _tipEl.style.top = (r.bottom + 6) + "px";
  _tipEl.style.left = Math.min(r.left, window.innerWidth - 300) + "px";
}
function hideTip() { if (_tipEl) { _tipEl.remove(); _tipEl = null; } }

const RETURN_MODE_TIPS = {
  abs:         `$ P&L — total equity minus starting $10k.\nIncludes both realized P&L and unrealized MTM.\n\nFormula: equity(t) − 10,000`,
  pct_bankroll:`% Bankroll — P&L as % of starting $10k.\nFair apples-to-apples comparison since\nevery agent starts with the same bankroll.\n\nFormula: (equity(t) − 10,000) / 10,000 × 100`,
  pct_closed:  `Closed / Closed — return on capital\ncommitted to RESOLVED positions only.\n\nNumerator:   cumulative realized P&L (closed trades)\nDenominator: cumulative capital deployed in those\n             same closed trades\n\nExample: earn $2k on $4k, then earn $1k on $6k\n→ return = (2k + 1k) / (4k + 6k) = 30%\n\nOpen positions don't touch either number.\nOnly appears after the first trade closes.`,
  pct_open:    `Open / Open — return on capital\ncurrently AT RISK in open positions.\n\nNumerator:   unrealized MTM P&L on open positions\nDenominator: current open exposure (entry cost)\n\nMoves every tick as book mids shift.\nShows how your live book is performing\nrelative to what you actually have deployed.\nNull when no positions are open.`,
};

function _infoIcon(mode) {
  return `<span
    style="cursor:help;color:#555;font-size:12px;margin-left:3px;vertical-align:middle;user-select:none"
    onmouseenter="showTip(this,RETURN_MODE_TIPS['${mode}'])"
    onmouseleave="hideTip()"
  >ⓘ</span>`;
}

function drawReturnsChart(canvasId, eq, mode) {
  if (eq.status !== "ok") return;
  const bankrolls = eq.bankrolls || {};
  const datasets = [];
  for (const trader of ROSTER) {
    const series = eq.series[trader];
    if (!series || !series.length) continue;
    const bankroll = bankrolls[trader] || 10000;
    const points = [];
    for (const p of series) {
      let y;
      if (mode === "abs") {
        y = p.equity - bankroll;
      } else if (mode === "pct_bankroll") {
        y = ((p.equity - bankroll) / bankroll) * 100;
      } else if (mode === "pct_closed") {
        // closed P&L / cumulative capital deployed in closed trades
        const dep = p.cum_deployed_usd ?? 0;
        y = dep > 0 ? ((p.closed_pnl ?? 0) / dep) * 100 : null;
      } else {
        // pct_open: unrealized MTM / current open exposure
        const exp = p.exposure ?? 0;
        y = exp > 0 ? ((p.mtm ?? 0) / exp) * 100 : null;
      }
      if (y !== null && y !== undefined) {
        points.push({ x: p.ts, y: round2(y) });
      }
    }
    if (!points.length) continue;
    datasets.push({
      label: traderLabel(trader),
      data: points,
      borderColor: traderColor(trader),
      backgroundColor: traderColor(trader) + "22",
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      spanGaps: true,
      stepped: mode === "pct_closed" ? "before" : false,
      tension: (mode === "abs" || mode === "pct_open") ? 0.2 : 0,
      fill: false,
    });
  }
  const yFmt = mode === "abs"
    ? v => (v >= 0 ? "+" : "") + "$" + Math.abs(v).toLocaleString(undefined, {maximumFractionDigits: 0})
    : v => (v >= 0 ? "+" : "") + v.toFixed(1) + "%";
  mkChart(canvasId, {
    type: "line",
    data: { datasets },
    options: {
      ...CHART_BASE,
      scales: {
        x: CHART_TIME_OPTS,
        y: {
          ...CHART_BASE.scales.y,
          ticks: { ...CHART_BASE.scales.y.ticks, callback: yFmt },
          grid: { color: "#1a1a1a" },
        },
      },
    },
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

async function renderDEReturns() {
  try {
    const [eq, risk] = await Promise.all([
      jget("/api/driftedge/paper/equity-history"),
      jget("/api/driftedge/paper/risk-stats"),
    ]);

    updateRoster(eq, null);
    const bankrolls = eq.bankrolls || {};
    const modeDefs = [
      { id: "abs",          label: "$ P&L" },
      { id: "pct_bankroll", label: "% Bankroll" },
      { id: "pct_closed",   label: "Closed/Closed" },
      { id: "pct_open",     label: "Open/Open" },
    ];

    const summaryRows = ROSTER.map(t => {
      const r = (risk.by_trader || {})[t] || {};
      const series = (eq.series || {})[t] || [];
      const bankroll = bankrolls[t] || 10000;
      const lastPt = series[series.length - 1];
      const totalPnl   = lastPt ? lastPt.equity - bankroll : 0;
      const closedPnl  = lastPt ? (lastPt.closed_pnl ?? 0) : 0;
      const cumDeployed = lastPt ? (lastPt.cum_deployed_usd ?? 0) : 0;
      const mtm        = lastPt ? (lastPt.mtm ?? 0) : 0;
      const exposure   = lastPt ? (lastPt.exposure ?? 0) : 0;
      const pctBank    = bankroll ? (totalPnl / bankroll * 100) : null;
      const pctClosed  = cumDeployed > 0 ? (closedPnl / cumDeployed * 100) : null;
      const pctOpen    = exposure > 0 ? (mtm / exposure * 100) : null;
      const pnlCls     = signClass(totalPnl);
      const closedCls  = signClass(closedPnl);
      const openCls    = signClass(mtm);
      return `<tr>
        <td style="color:${traderColor(t)};font-weight:bold">${traderLabel(t)}</td>
        <td class="r ${pnlCls}">$${signFmt(totalPnl, 2)}</td>
        <td class="r ${pnlCls}">${pctBank != null ? signFmt(pctBank, 3) + "%" : "—"}</td>
        <td class="r ${closedCls}">${pctClosed != null ? signFmt(pctClosed, 2) + "%" : "<span class='muted'>—</span>"}</td>
        <td class="r muted" style="font-size:10px">$${fmt(cumDeployed, 0)}</td>
        <td class="r ${openCls}">${pctOpen != null ? signFmt(pctOpen, 2) + "%" : "<span class='muted'>—</span>"}</td>
        <td class="r muted" style="font-size:10px">$${fmt(exposure, 0)}</td>
        <td class="r">${r.closed_trades ?? 0}</td>
        <td class="r">${r.hit_rate != null ? (r.hit_rate * 100).toFixed(1) + "%" : "—"}</td>
        <td class="r">${r.sharpe != null ? fmt(r.sharpe, 2) : "—"}</td>
      </tr>`;
    }).join("");

    set(`
      <div class="card" style="margin-bottom:12px">
        <div class="card-title" style="display:flex;align-items:center;gap:12px">
          INVESTMENT RETURNS · BASELINE 0
          <span style="font-weight:normal;font-size:10px;color:var(--muted)">baseline = $10,000 per trader</span>
          <div style="margin-left:auto;display:flex;gap:6px;align-items:center">
            ${modeDefs.map(({ id, label }) =>
              `<span style="display:inline-flex;align-items:center;gap:0">
                <button onclick="returnsMode='${id}';renderDEReturns()"
                  style="background:${returnsMode===id?'var(--primary)':'transparent'};
                         border:1px solid ${returnsMode===id?'var(--primary)':'var(--border)'};
                         color:${returnsMode===id?'#000':'var(--text)'};
                         padding:2px 10px;cursor:pointer;
                         font-family:var(--mono);font-size:10px;letter-spacing:0.04em">
                  ${label}
                </button>${_infoIcon(id)}
              </span>`
            ).join("")}
          </div>
        </div>
        ${eq.status === "ok"
          ? '<div class="chart-wrap tall"><canvas id="returnsChart"></canvas></div>'
          : '<div class="muted">No equity history yet.</div>'}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">PERFORMANCE COMPARISON</div>
        <table>
          <thead><tr>
            <th>Trader</th>
            <th class="r">$ P&L${_infoIcon("abs")}</th>
            <th class="r">% Bankroll${_infoIcon("pct_bankroll")}</th>
            <th class="r">Closed/Closed${_infoIcon("pct_closed")}</th>
            <th class="r muted" style="font-size:10px">Cum. Deployed</th>
            <th class="r">Open/Open${_infoIcon("pct_open")}</th>
            <th class="r muted" style="font-size:10px">Open Exp.</th>
            <th class="r">Closed</th>
            <th class="r">Hit Rate</th>
            <th class="r">Sharpe</th>
          </tr></thead>
          <tbody>${summaryRows || '<tr><td colspan="10" class="muted">No data yet.</td></tr>'}</tbody>
        </table>
      </div>
    `);

    if (eq.status === "ok") drawReturnsChart("returnsChart", eq, returnsMode);
  } catch (e) {
    renderError(e);
  }
}

async function renderPSPaper() {
  try {
    const [d, eq] = await Promise.all([
      jget("/api/pinsight/paper"),
      jget("/api/pinsight/paper/equity-history"),
    ]);
    if (d.status !== "ok") {
      setSoft(`<div class="muted">No paper trades yet. The poll daemon runs the
        edge_buyer agent every 90 s during US market hours; come back when
        the market is open.</div>`);
      return;
    }
    const s = d.summary;
    const tr = (s.by_trader && s.by_trader.edge_buyer) || {};
    // total_equity is MTM-based when equity_history is available
    // (Bug 5 fix 2026-06-05); falls back to cost-basis otherwise.
    const retPct = tr.bankroll_init
      ? ((tr.total_equity || 0) / tr.bankroll_init - 1) * 100
      : null;
    const realisedPct = tr.bankroll_init
      ? ((tr.closed_pnl || 0) / tr.bankroll_init * 100)
      : null;
    const retClass = signClass(retPct);

    set(`
      <div class="grid grid-4" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title" style="color:#88ff66">EDGE_BUYER</div>
          <div class="muted mono" style="font-size:10px;margin-bottom:6px">SPY 0DTE RND edge buyer · divergence-gated · Kelly-sized (2026-07-04)</div>
          <div class="kpi-value mono ${retClass}">${realisedPct != null ? signFmt(realisedPct, 3) + "%" : "—"}</div>
          <div class="muted mono" style="font-size:10px;margin-top:4px">Realised return on $${fmtInt(tr.bankroll_init || 0)}</div>
        </div>
        ${kpi("Equity", "$" + fmt(tr.total_equity ?? 0, 2), `cash $${fmt(tr.cash_usd ?? 0, 2)} · open $${fmt(tr.open_exposure ?? 0, 2)}`)}
        ${kpi("Closed P&L", `<span class="${signClass(tr.closed_pnl)}">$${signFmt(tr.closed_pnl ?? 0, 2)}</span>`,
              `${s.wins ?? 0}W / ${s.losses ?? 0}L · hit ${s.hit_rate != null ? (s.hit_rate * 100).toFixed(1) + "%" : "—"}`)}
        ${kpi("Positions", `${s.open_count ?? 0} open`, `${s.closed_count ?? 0} closed lifetime`)}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">EQUITY CURVE · $${fmtInt(tr.bankroll_init || 50000)} BANKROLL · COST-BASIS
          <span class="muted" style="font-weight:normal;font-size:10px">(MTM extension TODO)</span></div>
        ${eq.status === "ok"
          ? '<div class="chart-wrap tall"><canvas id="psPaperEquityChart"></canvas></div>'
          : '<div class="muted">No equity history yet.</div>'}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">OPEN POSITIONS (${d.open.length})</div>
        ${d.open.length ? `<table>
          <thead><tr>
            <th>Ticker</th><th>Kind</th><th class="r">Strike</th>
            <th class="r">Entry</th><th class="r">Fair</th><th class="r">Edge</th>
            <th class="r">P(ITM)</th><th class="r">N</th><th class="r">Size</th>
            <th>Opened</th>
          </tr></thead>
          <tbody>${d.open.map(r => `<tr>
            <td class="muted" style="font-size:10px">${r.ticker ?? '—'}</td>
            <td class="${r.kind === 'put' ? 'neg' : 'pos'}">${(r.kind || '').toUpperCase()}</td>
            <td class="r amber">${fmt(r.strike, 0)}</td>
            <td class="r">${fmt(r.entry_price, 3)}</td>
            <td class="r muted">${fmt(r.fair_at_entry, 3)}</td>
            <td class="r amber">${fmt(r.edge_at_entry, 3)}</td>
            <td class="r">${(r.prob_itm_at_entry * 100).toFixed(0)}%</td>
            <td class="r">${r.n_contracts}</td>
            <td class="r">$${fmt(r.size_usd, 2)}</td>
            <td class="muted" style="font-size:10px">${fmtTsLocal(r.entry_ts)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="muted">No open positions.</div>'}
      </div>

      <div class="card">
        <div class="card-title">CLOSED POSITIONS (${d.closed.length})</div>
        ${d.closed.length ? `<table>
          <thead><tr>
            <th>Ticker</th><th>K</th><th>Kind</th>
            <th class="r">Entry</th><th class="r">Exit</th>
            <th class="r">Spot in/out</th><th class="r">N</th>
            <th>Reason</th><th class="r">P&L</th>
          </tr></thead>
          <tbody>${d.closed.map(r => {
            const cls = signClass(r.pnl_usd);
            return `<tr>
              <td class="muted" style="font-size:10px">${r.ticker ?? '—'}</td>
              <td class="r amber">${fmt(r.strike, 0)}</td>
              <td class="${r.kind === 'put' ? 'neg' : 'pos'}">${(r.kind || '').toUpperCase()}</td>
              <td class="r">${fmt(r.entry_price, 3)}</td>
              <td class="r">${fmt(r.exit_price, 3)}</td>
              <td class="r muted" style="font-size:10px">${fmt(r.spot_at_entry, 2)} → ${fmt(r.spot_at_exit, 2)}</td>
              <td class="r">${r.n_contracts}</td>
              <td class="amber">${r.exit_reason ?? ''}</td>
              <td class="r ${cls}">$${signFmt(r.pnl_usd, 2)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<div class="muted">No closed positions yet.</div>'}
      </div>`);

    if (eq.status === "ok") {
      const ctx = document.getElementById("psPaperEquityChart");
      if (ctx) {
        mkChart("psPaperEquityChart", {
          type: "line",
          data: {
            datasets: Object.entries(eq.series).map(([trader, pts]) => ({
              label: trader.toUpperCase(),
              data: pts.map(p => ({ x: p.ts, y: p.equity })),
              borderColor: "#88ff66",
              backgroundColor: "#88ff6633",
              borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
              stepped: "before", tension: 0,
            })),
          },
          options: {
            ...CHART_BASE,
            scales: {
              x: CHART_TIME_OPTS,
              y: { ...CHART_BASE.scales.y,
                   ticks: { ...CHART_BASE.scales.y.ticks,
                            callback: v => "$" + v.toLocaleString() }},
            },
          },
        });
      }
    }
  } catch (e) {
    renderError(e);
  }
}

async function renderPSChain() {
  try {
    const [d, full] = await Promise.all([
      jget("/api/pinsight/chain"),
      jget("/api/pinsight/chain/full?top_contracts=40"),
    ]);
    if (d.status !== "ok") {
      setSoft(`<div class="muted">No chain data yet. Run <code>pinsight fetch-chain SPY</code> or wait for the morning launchd job.</div>`);
      return;
    }
    const haveFull = full && full.status === "ok";
    const callPutRatio = (d.total_put_vol && d.total_call_vol)
      ? (d.total_put_vol / d.total_call_vol).toFixed(2)
      : "—";
    set(`
      <div class="grid grid-4" style="margin-bottom:16px">
        ${kpi(d.underlying, `$${fmt(d.underlying_price, 2)}`, "Spot")}
        ${kpi("Expiry", d.expiry, "(0DTE today)")}
        ${kpi("Contracts", `${d.contracts}`, `${d.calls}C / ${d.puts}P`)}
        ${kpi("P/C ratio", callPutRatio,
              `${fmtInt(d.total_call_vol)}C vol · ${fmtInt(d.total_put_vol)}P vol`)}
      </div>

      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">IV SMILE · CALLS (amber) · PUTS (cyan)</div>
          ${haveFull
            ? '<div class="chart-wrap"><canvas id="ivSmileChart"></canvas></div>'
            : '<div class="muted">No IV data.</div>'}
        </div>
        <div class="card">
          <div class="card-title">VOL BY STRIKE · stacked CALLS + PUTS</div>
          ${haveFull
            ? '<div class="chart-wrap"><canvas id="volStrikeChart"></canvas></div>'
            : '<div class="muted">No volume data.</div>'}
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">TOP CONTRACTS BY VOLUME · ${haveFull ? full.contracts.length : 0}</div>
        ${haveFull && full.contracts.length ? `<table>
          <thead><tr>
            <th>Ticker</th><th>Type</th><th class="r">Strike</th>
            <th class="r">Bid</th><th class="r">Ask</th><th class="r">Mid</th>
            <th class="r">Vol</th><th class="r">OI</th><th class="r">V/OI</th>
            <th class="r">IV</th><th>ITM</th>
          </tr></thead>
          <tbody>${full.contracts.map(c => {
            const voi = (c.open_interest && c.volume) ? (c.volume / c.open_interest).toFixed(2) : "—";
            const typeCls = c.type === 'put' ? 'neg' : 'pos';
            return `<tr>
              <td class="muted" style="font-size:10px">${c.ticker ?? '—'}</td>
              <td class="${typeCls}">${(c.type || '—').toUpperCase()}</td>
              <td class="r amber">${fmt(c.strike, 0)}</td>
              <td class="r">${c.bid != null ? fmt(c.bid, 2) : '—'}</td>
              <td class="r">${c.ask != null ? fmt(c.ask, 2) : '—'}</td>
              <td class="r">${c.mid != null ? fmt(c.mid, 2) : '—'}</td>
              <td class="r">${fmtInt(c.volume)}</td>
              <td class="r muted">${fmtInt(c.open_interest)}</td>
              <td class="r amber">${voi}</td>
              <td class="r">${c.iv != null ? fmt(c.iv, 3) : '—'}</td>
              <td>${c.itm ? '<span class="amber">●</span>' : '<span class="muted">○</span>'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<div class="muted">No contract data.</div>'}
      </div>

      <div class="card">
        <div class="card-title">SNAPSHOT METADATA</div>
        <table>
          <tbody>
            <tr><td class="muted">Snapshot</td><td>${fmtTsLocal(d.snapshot_ts)} ET</td></tr>
            <tr><td class="muted">Call volume</td><td class="r">${fmtInt(d.total_call_vol)}</td></tr>
            <tr><td class="muted">Put volume</td><td class="r">${fmtInt(d.total_put_vol)}</td></tr>
            <tr><td class="muted">File</td><td class="muted" style="font-size:10px">${d.file_path}</td></tr>
          </tbody>
        </table>
      </div>`);

    if (haveFull) {
      drawIVSmileChart("ivSmileChart", full);
      drawVolByStrikeChart("volStrikeChart", full);
    }
  } catch (e) {
    renderError(e);
  }
}

function drawIVSmileChart(canvasId, full) {
  const spot = full.spot;
  mkChart(canvasId, {
    type: "scatter",
    data: {
      datasets: [
        { label: "Calls", data: full.smile.calls.map(p => ({ x: p.strike, y: p.iv })),
          backgroundColor: "#ff9000", borderColor: "#ff9000",
          pointRadius: 3, showLine: false },
        { label: "Puts", data: full.smile.puts.map(p => ({ x: p.strike, y: p.iv })),
          backgroundColor: "#00d4ff", borderColor: "#00d4ff",
          pointRadius: 3, showLine: false },
      ],
    },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        legend: { display: true, labels: { color: "#ffffff",
                                            font: { family: "JetBrains Mono, monospace", size: 10 }}},
        annotation: undefined,
      },
      scales: {
        x: { ...CHART_BASE.scales.x, type: "linear",
             title: { display: true, text: "STRIKE",
                      color: "#666", font: { family: "JetBrains Mono, monospace", size: 10 }}},
        y: { ...CHART_BASE.scales.y,
             title: { display: true, text: "IMPLIED VOL",
                      color: "#666", font: { family: "JetBrains Mono, monospace", size: 10 }},
             ticks: { ...CHART_BASE.scales.y.ticks,
                      callback: v => Number(v).toFixed(2) }},
      },
    },
  });
  // Spot line overlay (Chart.js doesn't support annotation plugin without import,
  // so draw it manually as a thin dataset).
  const chart = chartRegistry[canvasId];
  if (chart && spot != null) {
    const yMin = chart.scales.y.min;
    const yMax = chart.scales.y.max;
    chart.data.datasets.push({
      label: `Spot $${spot.toFixed(2)}`,
      data: [{ x: spot, y: yMin }, { x: spot, y: yMax }],
      borderColor: "#ffffff", borderWidth: 1, borderDash: [4, 4],
      pointRadius: 0, showLine: true, type: "line",
    });
    chart.update("none");
  }
}

function drawVolByStrikeChart(canvasId, full) {
  // Filter to ±15% of spot for readability — same range as the smile.
  const spot = full.spot || 0;
  const lo = spot * 0.85, hi = spot * 1.15;
  const rows = full.vol_by_strike.filter(r => r.strike >= lo && r.strike <= hi);
  mkChart(canvasId, {
    type: "bar",
    data: {
      labels: rows.map(r => r.strike.toFixed(0)),
      datasets: [
        { label: "Calls", data: rows.map(r => r.call_vol),
          backgroundColor: "#ff900088", borderColor: "#ff9000", borderWidth: 1,
          stack: "vol" },
        { label: "Puts", data: rows.map(r => r.put_vol),
          backgroundColor: "#00d4ff88", borderColor: "#00d4ff", borderWidth: 1,
          stack: "vol" },
      ],
    },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        legend: { display: true, labels: { color: "#ffffff",
                                            font: { family: "JetBrains Mono, monospace", size: 10 }}},
      },
      scales: {
        x: { ...CHART_BASE.scales.x, stacked: true,
             ticks: { ...CHART_BASE.scales.x.ticks,
                      maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }},
        y: { ...CHART_BASE.scales.y, stacked: true,
             ticks: { ...CHART_BASE.scales.y.ticks,
                      callback: v => v >= 1000 ? (v / 1000).toFixed(0) + "k" : v }},
      },
    },
  });
}

let flagFilters = { type: "", minVoi: 1, search: "" };

async function renderPSFlags() {
  try {
    const d = await jget("/api/pinsight/flags?top=200");
    if (d.status !== "ok" || !d.items?.length) {
      setSoft(`<div class="muted">No flagged contracts.</div>`);
      return;
    }
    const filtered = d.items.filter(r => {
      if (flagFilters.type && r.type !== flagFilters.type) return false;
      if (flagFilters.minVoi != null && r.v_over_oi < flagFilters.minVoi) return false;
      if (flagFilters.search && !`${r.underlying}${r.expiry}${r.strike}`.toLowerCase()
          .includes(flagFilters.search.toLowerCase())) return false;
      return true;
    });
    const totalCalls = d.items.filter(r => r.type === 'call').length;
    const totalPuts = d.items.filter(r => r.type === 'put').length;
    const topVoi = d.items.length ? Math.max(...d.items.map(r => r.v_over_oi)) : 0;

    set(`
      <div class="grid grid-4" style="margin-bottom:12px">
        ${kpi("Flagged", d.count, "vol/OI ≥ 1 · vol ≥ 1000")}
        ${kpi("Calls / Puts", `<span class="pos">${totalCalls}</span> / <span class="neg">${totalPuts}</span>`)}
        ${kpi("Top V/OI", fmt(topVoi, 1) + "×")}
        ${kpi("Showing", `${filtered.length} / ${d.items.length}`, "post-filter")}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">VOL/OI DISTRIBUTION (log-bins)</div>
        <div class="chart-wrap"><canvas id="voiDistChart"></canvas></div>
      </div>

      <div class="news-filter-bar" style="margin-bottom:12px">
        <span class="muted mono" style="font-size:10px">Filter:</span>
        <select id="flagTypeFilter">
          <option value="" ${!flagFilters.type ? 'selected' : ''}>All types</option>
          <option value="call" ${flagFilters.type === 'call' ? 'selected' : ''}>Calls</option>
          <option value="put"  ${flagFilters.type === 'put'  ? 'selected' : ''}>Puts</option>
        </select>
        <select id="flagVoiFilter">
          <option value="1"   ${flagFilters.minVoi == 1   ? 'selected' : ''}>Min V/OI 1×</option>
          <option value="5"   ${flagFilters.minVoi == 5   ? 'selected' : ''}>Min V/OI 5×</option>
          <option value="20"  ${flagFilters.minVoi == 20  ? 'selected' : ''}>Min V/OI 20×</option>
          <option value="100" ${flagFilters.minVoi == 100 ? 'selected' : ''}>Min V/OI 100×</option>
        </select>
        <input id="flagSearch" type="text" placeholder="search strike/symbol…"
               value="${flagFilters.search}"
               style="background:var(--bg-2);border:1px solid var(--border);
                      color:var(--text);padding:4px 8px;font-family:var(--mono);
                      font-size:11px;min-width:160px">
        <span class="muted mono" style="font-size:10px;margin-left:auto">
          ${filtered.length} of ${d.items.length}
        </span>
      </div>

      <table>
        <thead><tr>
          <th>Underlying</th><th>Expiry</th><th>Type</th>
          <th class="r">Strike</th><th class="r">Volume</th><th class="r">OI</th>
          <th class="r">Vol/OI</th><th class="r">IV</th>
        </tr></thead>
        <tbody>
          ${filtered.map(r => `<tr>
            <td class="amber">${r.underlying}</td>
            <td>${r.expiry}</td>
            <td class="${r.type === 'put' ? 'neg' : 'pos'}">${r.type}</td>
            <td class="r">${fmt(r.strike, 0)}</td>
            <td class="r">${fmtInt(r.volume)}</td>
            <td class="r">${fmtInt(r.open_interest)}</td>
            <td class="r amber">${fmt(r.v_over_oi, 2)}</td>
            <td class="r">${r.iv != null ? fmt(r.iv, 3) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);

    drawVoiHistChart("voiDistChart", d.items);

    document.getElementById("flagTypeFilter").addEventListener("change", e => {
      flagFilters.type = e.target.value; renderPSFlags();
    });
    document.getElementById("flagVoiFilter").addEventListener("change", e => {
      flagFilters.minVoi = Number(e.target.value); renderPSFlags();
    });
    document.getElementById("flagSearch").addEventListener("input", e => {
      flagFilters.search = e.target.value;
      // Debounce by skipping re-render until 250ms idle.
      clearTimeout(window._flagSearchTimer);
      window._flagSearchTimer = setTimeout(() => renderPSFlags(), 250);
    });
  } catch (e) {
    renderError(e);
  }
}

function drawVoiHistChart(canvasId, items) {
  // Log-bins: 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000
  const edges = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];
  const labels = [];
  for (let i = 0; i < edges.length - 1; i++) {
    labels.push(`${edges[i]}–${edges[i+1]}×`);
  }
  const calls = new Array(edges.length - 1).fill(0);
  const puts = new Array(edges.length - 1).fill(0);
  for (const r of items) {
    for (let i = 0; i < edges.length - 1; i++) {
      if (r.v_over_oi >= edges[i] && r.v_over_oi < edges[i + 1]) {
        if (r.type === 'put') puts[i]++; else calls[i]++;
        break;
      }
    }
  }
  mkChart(canvasId, {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Calls", data: calls,
          backgroundColor: "#ff900088", borderColor: "#ff9000", borderWidth: 1,
          stack: "voi" },
        { label: "Puts", data: puts,
          backgroundColor: "#00d4ff88", borderColor: "#00d4ff", borderWidth: 1,
          stack: "voi" },
      ],
    },
    options: {
      ...CHART_BASE,
      plugins: {
        ...CHART_BASE.plugins,
        legend: { display: true, labels: { color: "#ffffff",
                                            font: { family: "JetBrains Mono, monospace", size: 10 }}},
      },
      scales: {
        x: { ...CHART_BASE.scales.x, stacked: true },
        y: { ...CHART_BASE.scales.y, stacked: true, beginAtZero: true,
             ticks: { ...CHART_BASE.scales.y.ticks, precision: 0, stepSize: 1 }},
      },
    },
  });
}

async function renderDEPaper() {
  try {
    const [d, eq, risk] = await Promise.all([
      jget("/api/driftedge/paper"),
      jget("/api/driftedge/paper/equity-history"),
      jget("/api/driftedge/paper/risk-stats"),
    ]);
    if (d.status !== "ok") {
      setSoft(`<div class="muted">No paper trades yet.</div>`);
      return;
    }
    // Roster first, then the per-trader distribution fetches follow it.
    updateRoster(eq, d);
    const distArr = await Promise.all(ROSTER.map(t =>
      jget(`/api/driftedge/paper/pnl-distribution?trader=${t}`)));
    const dists = Object.fromEntries(ROSTER.map((t, i) => [t, distArr[i]]));
    const s = d.summary;
    const TRADERS = ROSTER;

    const traderCards = TRADERS.map(t => {
      const x = s.by_trader?.[t] || {};
      const ret = x.return_pct;
      const retClass = signClass(ret);
      const pnlClass = signClass(x.closed_pnl);
      const ddClass = (x.drawdown_pct ?? 0) > 5 ? "neg" : "muted";
      return `<div class="card">
        <div class="card-title" style="color:${traderColor(t)}">${traderLabel(t)}</div>
        <div class="muted mono" style="font-size:10px;margin-bottom:6px">${traderDesc(t)}</div>
        <div class="kpi-value mono ${retClass}">${ret != null ? signFmt(ret, 3) + "%" : "—"}</div>
        <div class="muted mono" style="font-size:10px;margin-top:4px">Total return</div>
        <div style="margin-top:10px;display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;font-family:var(--mono);font-size:11px">
          <div><span class="muted">Equity:</span> <span class="amber">$${fmt(x.total_equity ?? 0, 2)}</span></div>
          <div><span class="muted">Cash:</span> <span>$${fmt(x.cash_usd ?? 0, 2)}</span></div>
          <div><span class="muted">Open exp:</span> <span>$${fmt(x.open_exposure ?? 0, 2)}</span></div>
          <div><span class="muted">Closed PnL:</span> <span class="${pnlClass}">$${signFmt(x.closed_pnl ?? 0, 2)}</span></div>
          <div><span class="muted">Open:</span> <span>${x.open_count ?? 0}</span></div>
          <div><span class="muted">Closed:</span> <span>${x.closed_count ?? 0}</span></div>
          <div><span class="muted">W/L:</span> <span>${x.wins ?? 0} / ${x.losses ?? 0}</span></div>
          <div><span class="muted">Hit rate:</span> <span>${x.hit_rate != null ? (x.hit_rate * 100).toFixed(1) + "%" : "—"}</span></div>
          <div><span class="muted">Avg size:</span> <span>$${fmt(x.avg_size ?? 0, 2)}</span></div>
          <div><span class="muted">Drawdown:</span> <span class="${ddClass}">${signFmt(-(x.drawdown_pct ?? 0), 2)}%</span></div>
        </div>
      </div>`;
    }).join("");

    const categoryRows = Object.entries(s.by_category || {})
      .sort((a, b) => (b[1].closed ?? 0) - (a[1].closed ?? 0))
      .map(([cat, cs]) => {
        const cls = signClass(cs.pnl_usd);
        return `<tr>
          <td class="amber">${cat.toUpperCase()}</td>
          <td class="r">${cs.total}</td>
          <td class="r">${cs.open}</td>
          <td class="r">${cs.closed}</td>
          <td class="r">${cs.hit_rate != null ? (cs.hit_rate * 100).toFixed(1) + "%" : "—"}</td>
          <td class="r">${cs.avg_pnl != null ? '$' + signFmt(cs.avg_pnl, 2) : "—"}</td>
          <td class="r ${cls}">$${signFmt(cs.pnl_usd, 2)}</td>
        </tr>`;
      }).join("");

    const venueSummaryRows = Object.entries(s.by_venue || {}).map(([v, vs]) => {
      const cls = signClass(vs.pnl_usd);
      return `<tr>
        <td class="amber">${v.toUpperCase()}</td>
        <td class="r">${vs.total}</td>
        <td class="r">${vs.open}</td>
        <td class="r">${vs.closed}</td>
        <td class="r">${vs.hit_rate != null ? (vs.hit_rate * 100).toFixed(1) + "%" : "—"}</td>
        <td class="r ${cls}">$${signFmt(vs.pnl_usd, 2)}</td>
      </tr>`;
    }).join("");

    set(`
      <div style="display:grid;grid-template-columns:repeat(${ROSTER.length},1fr);gap:12px;margin-bottom:16px">${traderCards}</div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">PORTFOLIO VALUE · ${ROSTER.length}-TRADER HORSE RACE <span class="muted" style="font-weight:normal;font-size:10px">(cash + MTM market value of open positions — updates every tick)</span></div>
        <div class="chart-wrap tall"><canvas id="paperPortfolioChart"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">AVAILABLE CASH <span class="muted" style="font-weight:normal;font-size:10px">(liquid cash in hand — drops when position opens, recovers ± P&L on close)</span></div>
        <div class="chart-wrap"><canvas id="paperEquityChart"></canvas></div>
      </div>

      <div style="margin-bottom:16px">
        <div class="muted mono" style="font-size:10px;margin-bottom:8px;letter-spacing:0.06em">
          RISK STATS · MTM-DERIVED
        </div>
        ${renderRiskPanel(risk)}
      </div>

      <div style="margin-bottom:16px">
        <div class="muted mono" style="font-size:10px;margin-bottom:8px;letter-spacing:0.06em">
          P&amp;L DISTRIBUTION PER TRADER <span style="color:#444">(realized closed trades — normality / fat tails)</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(${ROSTER.length},1fr);gap:12px">
          ${ROSTER.map(t => `
            <div class="card" style="border-top:2px solid ${traderColor(t)};padding:12px">
              <div style="color:${traderColor(t)};font-family:var(--mono);font-size:11px;
                          font-weight:bold;letter-spacing:0.06em;margin-bottom:6px">
                ${traderLabel(t)}
              </div>
              ${renderDistMeta(dists[t])}
              <div class="chart-wrap"><canvas id="distChart_${t}"></canvas></div>
            </div>`).join("")}
        </div>
      </div>

      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">BY VENUE</div>
          ${venueSummaryRows ? `<table>
            <thead><tr><th>Venue</th><th class="r">Total</th><th class="r">Open</th><th class="r">Closed</th><th class="r">Hit</th><th class="r">P&L</th></tr></thead>
            <tbody>${venueSummaryRows}</tbody>
          </table>` : '<div class="muted">No data.</div>'}
        </div>
        <div class="card">
          <div class="card-title">BY CATEGORY (diagnostic)</div>
          ${categoryRows ? `<table>
            <thead><tr><th>Category</th><th class="r">Total</th><th class="r">Open</th><th class="r">Closed</th><th class="r">Hit</th><th class="r">Avg</th><th class="r">P&L</th></tr></thead>
            <tbody>${categoryRows}</tbody>
          </table>` : '<div class="muted">No category data yet.</div>'}
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">OPEN POSITIONS (${d.open.length})</div>
        ${d.open.length ? `<table>
          <thead><tr>
            <th>Trader</th><th>Venue</th><th>Question</th>
            <th class="r">Entry</th><th class="r">Size</th>
            <th class="r">Tgt</th><th class="r">Stop</th><th>Opened</th>
          </tr></thead>
          <tbody>${d.open.map(r => `<tr data-venue="${r.venue}" data-market-id="${r.market_id}" class="clickable-row">
            <td style="color:${traderColor(r.trader)}">${(r.trader || '—').toUpperCase()}</td>
            <td class="muted" style="font-size:10px">${r.venue}</td>
            <td class="ell" style="max-width:240px">${r.question ?? ''}</td>
            <td class="r amber">${fmt(r.entry_price, 3)}</td>
            <td class="r">$${fmt(r.size_usd ?? 0, 2)}</td>
            <td class="r pos">${fmt(r.target, 2)}</td>
            <td class="r neg">${fmt(r.stop, 2)}</td>
            <td class="muted" style="font-size:10px">${fmtTimeLocal(r.entry_ts)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div class="muted">No open positions.</div>'}
      </div>

      <div class="grid grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">EXIT REASONS (all traders)</div>
          ${Object.entries(s.exit_reasons || {}).map(([k, v]) =>
            `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:11px">
              <span class="amber">${k}</span><span>${v}</span>
            </div>`).join('') || '<div class="muted">No closed trades yet.</div>'}
        </div>
        <div class="card">
          <div class="card-title">CONFIG</div>
          <div style="font-family:var(--mono);font-size:11px;line-height:1.7">
            <div><span class="muted">Bankroll / trader:</span> <span class="amber">$10,000 × 5</span></div>
            <div><span class="muted">Per-position cap:</span> <span>2% = $200</span></div>
            <div><span class="muted">Aggregate cap:</span> <span>50% = $5,000</span></div>
            <div><span class="muted">Min trade:</span> <span>$5</span></div>
            <div><span class="muted">Kelly/Equal/VolWt entry:</span> <span>[0.30, 0.40]</span></div>
            <div><span class="muted">VolHarvest entry:</span> <span>[0.10, 0.30] underdog YES</span></div>
            <div><span class="muted">Resolution entry:</span> <span>[0.25, 0.50] · ≤72 h horizon</span></div>
            <div><span class="muted">Target / Stop:</span> <span class="pos">0.60</span> / <span class="neg">0.20</span></div>
            <div><span class="muted">Force-exit (std):</span> <span>6h before resolution</span></div>
            <div><span class="muted">Force-exit (res):</span> <span>1h before resolution</span></div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">CLOSED POSITIONS (${d.closed.length}, all traders, all time)</div>
        ${d.closed.length ? `<table>
          <thead><tr>
            <th>Trader</th><th>Venue</th><th>Cat</th><th>Question</th>
            <th>Entry @</th><th class="r">Entry</th>
            <th>Exit @</th><th class="r">Exit</th>
            <th class="r">Size</th><th>Reason</th><th class="r">P&L</th>
          </tr></thead>
          <tbody>${d.closed.map(r => {
            const cls = signClass(r.pnl_usd);
            return `<tr data-venue="${r.venue}" data-market-id="${r.market_id}" class="clickable-row">
              <td style="color:${traderColor(r.trader)}">${(r.trader || '—').toUpperCase()}</td>
              <td class="muted" style="font-size:10px">${r.venue}</td>
              <td class="muted" style="font-size:10px">${(r.category || '—').toUpperCase()}</td>
              <td class="ell" style="max-width:220px">${r.question ?? ''}</td>
              <td class="muted" style="font-size:10px">${fmtTsLocal(r.entry_ts)}</td>
              <td class="r">${fmt(r.entry_price, 3)}</td>
              <td class="muted" style="font-size:10px">${fmtTsLocal(r.exit_ts)}</td>
              <td class="r">${r.exit_price != null ? fmt(r.exit_price, 3) : '—'}</td>
              <td class="r">$${fmt(r.size_usd ?? 0, 2)}</td>
              <td class="amber">${r.exit_reason ?? ''}</td>
              <td class="r ${cls}">${r.pnl_usd != null ? '$' + signFmt(r.pnl_usd, 2) : '—'}</td>
            </tr>`;
          }).join('')}</tbody>
        </table>` : '<div class="muted">No closed trades yet.</div>'}
      </div>`);

    document.querySelectorAll(".clickable-row").forEach(row => {
      row.style.cursor = "pointer";
      row.addEventListener("click", () => {
        openMarketDetail(row.dataset.venue, row.dataset.marketId);
      });
    });

    drawPortfolioChart("paperPortfolioChart", eq);
    drawEquityChart("paperEquityChart", eq);
    for (const t of ROSTER) {
      drawHistogramChart(`distChart_${t}`, dists[t], traderColor(t));
    }
  } catch (e) {
    renderError(e);
  }
}

function renderRiskPanel(risk) {
  if (!risk || risk.status !== "ok") {
    return '<div class="muted">No risk-history yet — needs a few ticks of paper engine activity.</div>';
  }
  return `<div style="display:grid;grid-template-columns:repeat(${ROSTER.length},1fr);gap:12px">
    ${ROSTER.map(t => {
      const r = risk.by_trader[t] || {};
      const retCls = signClass(r.total_return_pct);
      const ddCls = (r.max_drawdown_pct ?? 0) > 5 ? "neg" : "muted";
      const sharpe = r.sharpe;
      const sharpeCls = sharpe == null ? "muted" : (sharpe > 0 ? "pos" : "neg");
      return `<div class="card" style="border-top:2px solid ${traderColor(t)};padding:12px">
        <div style="color:${traderColor(t)};font-family:var(--mono);font-size:11px;
                    font-weight:bold;letter-spacing:0.06em;margin-bottom:8px">
          ${traderLabel(t)}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 10px;
                    font-family:var(--mono);font-size:11px">
          <div><span class="muted">Return:</span> <span class="${retCls}">${r.total_return_pct != null ? signFmt(r.total_return_pct, 3) + "%" : "—"}</span></div>
          <div><span class="muted">Equity:</span> <span>$${fmt(r.current_equity ?? 0, 2)}</span></div>
          <div><span class="muted">Max DD:</span> <span class="${ddCls}">-${fmt(r.max_drawdown_pct ?? 0, 2)}%</span></div>
          <div><span class="muted">Cur DD:</span> <span>-${fmt(r.current_drawdown_pct ?? 0, 2)}%</span></div>
          <div><span class="muted">Sharpe:</span> <span class="${sharpeCls}">${sharpe != null ? fmt(sharpe, 2) : "—"}</span></div>
          <div><span class="muted">Sortino:</span> <span>${r.sortino != null ? fmt(r.sortino, 2) : "—"}</span></div>
          <div><span class="muted">Hit rate:</span> <span>${r.hit_rate != null ? (r.hit_rate * 100).toFixed(1) + "%" : "—"}</span></div>
          <div><span class="muted">PF:</span> <span>${r.profit_factor != null ? fmt(r.profit_factor, 2) : "—"}</span></div>
          <div><span class="muted">Avg win:</span> <span class="pos">$${fmt(r.avg_win_usd ?? 0, 2)}</span></div>
          <div><span class="muted">Avg loss:</span> <span class="neg">$${fmt(r.avg_loss_usd ?? 0, 2)}</span></div>
          <div><span class="muted">Snaps:</span> <span>${r.snapshots ?? 0}</span></div>
          <div><span class="muted">Closed:</span> <span>${r.closed_trades ?? 0}</span></div>
        </div>
      </div>`;
    }).join("")}
  </div>`;
}

function renderDistMeta(dist) {
  if (!dist || dist.status !== "ok") {
    return '<div class="muted mono" style="font-size:10px">No closed trades yet.</div>';
  }
  const m = dist.moments || {};
  const skewCls = (m.skew ?? 0) > 0 ? "pos" : (m.skew ?? 0) < 0 ? "neg" : "muted";
  const skewLabel = Math.abs(m.skew ?? 0) < 0.3 ? "symmetric" :
                    (m.skew > 0 ? "right-tail" : "left-tail");
  const fatTail = (m.kurtosis ?? 0) > 1 ? "FAT" : "normal-ish";
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-family:var(--mono);font-size:10px;margin-bottom:4px">
    <div><span class="muted">n:</span> ${dist.n}</div>
    <div><span class="muted">+share:</span> ${(dist.positive_share * 100).toFixed(0)}%</div>
    <div><span class="muted">μ:</span> $${signFmt(m.mean ?? 0, 2)}</div>
    <div><span class="muted">σ:</span> $${fmt(m.std ?? 0, 2)}</div>
    <div><span class="muted">skew:</span> <span class="${skewCls}">${m.skew != null ? fmt(m.skew, 2) : "—"}</span> (${skewLabel})</div>
    <div><span class="muted">kurt:</span> ${m.kurtosis != null ? fmt(m.kurtosis, 2) : "—"} (${fatTail})</div>
  </div>`;
}

async function renderDEMarkets() {
  try {
    const [d, dist] = await Promise.all([
      jget("/api/driftedge/markets?top=50"),
      jget("/api/driftedge/price-distribution"),
    ]);
    if (d.status !== "ok") {
      setSoft(`<div class="muted">No DriftEdge data yet.</div>`);
      return;
    }
    set(`
      <div class="card" style="margin-bottom:16px">
        <div class="card-title">YES-PRICE DISTRIBUTION · ${dist.total ?? 0} markets</div>
        <div class="chart-wrap"><canvas id="priceDistChart"></canvas></div>
      </div>

      <div class="muted mono" style="margin-bottom:12px">
        Snapshot: ${fmtTsLocal(d.snapshot_ts)} ET · ${d.count} markets · sorted by 24h volume
      </div>
      <table>
        <thead><tr>
          <th>Question</th><th class="r">Yes</th><th class="r">No</th>
          <th class="r">Spread</th><th class="r">Vol 24h</th><th>End</th>
        </tr></thead>
        <tbody>
          ${d.items.map(r => `<tr data-venue="polymarket" data-market-id="${r.market_id}" class="clickable-row">
            <td class="ell">${r.question ?? ''}</td>
            <td class="r pos">${fmt(r.yes_price, 3)}</td>
            <td class="r neg">${fmt(r.no_price, 3)}</td>
            <td class="r muted">${r.spread != null ? fmt(r.spread, 3) : '—'}</td>
            <td class="r amber">$${fmtInt(r.volume_24h)}</td>
            <td class="muted" style="font-size:10px">${r.end_date?.slice(0, 10) ?? ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);

    document.querySelectorAll(".clickable-row").forEach(row => {
      row.addEventListener("click", () => {
        openMarketDetail(row.dataset.venue, row.dataset.marketId);
      });
    });

    if (dist.status === "ok") {
      mkChart("priceDistChart", {
        type: "bar",
        data: {
          labels: dist.bins.slice(0, -1).map(b => b.toFixed(2)),
          datasets: [{
            label: "Market count",
            data: dist.counts,
            backgroundColor: "#ff900088",
            borderColor: "#ff9000",
            borderWidth: 1,
          }],
        },
        options: CHART_BASE,
      });
    }
  } catch (e) {
    renderError(e);
  }
}

async function renderDEBooks() {
  try {
    const d = await jget("/api/driftedge/books");
    if (d.status !== "ok" || !d.items?.length) {
      setSoft(`<div class="muted">No orderbook snapshots yet.</div>`);
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
            <td class="muted">${fmtTsLocal(r.last_snapshot_ts)}</td>
            <td class="muted">${fmtTsLocal(r.file_mtime)}</td>
          </tr>`).join('')}
        </tbody>
      </table>`);
  } catch (e) {
    renderError(e);
  }
}

async function renderSEHealth() {
  try {
    const h = await jget("/api/sentinel/health");
    if (h.status !== "ok") {
      setSoft(`<div class="neg">Health endpoint returned ${h.status}</div>`);
      return;
    }
    const statusPill = (loaded, pid) => {
      if (loaded && pid) return `<span class="pos">● RUNNING (pid ${pid})</span>`;
      if (loaded) return `<span class="amber">● LOADED (idle)</span>`;
      return `<span class="neg">● NOT LOADED</span>`;
    };

    const ps = h.pinsight, de = h.driftedge, se = h.sentinel;

    set(`
      <div class="grid grid-3" style="margin-bottom:16px">
        <div class="card">
          <div class="card-title">PINSIGHT</div>
          <div style="font-family:var(--mono);font-size:11px;line-height:1.8">
            <div>Poll: ${ps.launchd.poll ? statusPill(ps.launchd.poll.loaded, ps.launchd.poll.pid) : '<span class="muted">—</span>'}</div>
            <div>Morning: ${statusPill(ps.launchd.morning.loaded, ps.launchd.morning.pid)}</div>
            <div>Midday: ${statusPill(ps.launchd.midday.loaded, ps.launchd.midday.pid)}</div>
            <div>Close: ${statusPill(ps.launchd.close.loaded, ps.launchd.close.pid)}</div>
            <div style="margin-top:8px"><span class="muted">Data:</span> ${ps.data_size_mb ?? "—"} MB</div>
            <div><span class="muted">Logs today:</span> ${ps.log_size_today_mb} MB</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">DRIFTEDGE</div>
          <div style="font-family:var(--mono);font-size:11px;line-height:1.8">
            <div>Poll: ${statusPill(de.launchd.poll.loaded, de.launchd.poll.pid)}</div>
            <div style="margin-top:8px"><span class="muted">Data:</span> ${de.data_size_mb ?? "—"} MB</div>
            <div><span class="muted">Logs today:</span> ${de.log_size_today_mb} MB</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">SENTINEL</div>
          <div style="font-family:var(--mono);font-size:11px;line-height:1.8">
            <div>Server: ${statusPill(se.launchd.server.loaded, se.launchd.server.pid)}</div>
            <div style="margin-top:8px"><span class="muted">Logs today:</span> ${se.log_size_today_mb} MB</div>
            <div><span class="muted">Snapshot:</span> ${h.ts}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">RECENT DRIFTEDGE EVENTS</div>
        <div id="recentLogs" class="logs"><span class="muted">Loading…</span></div>
      </div>`);

    const log = await jget("/api/logs/driftedge?max_lines=50");
    const events = (log.events ?? []).reverse();
    const html = events.map(_fmtLogRow).join("");
    document.getElementById("recentLogs").innerHTML = html || '<span class="muted">No events.</span>';
  } catch (e) {
    renderError(e);
  }
}

function _fmtLogRow(e) {
  const lvl = (e.level ?? "info").toLowerCase();
  const lvlColor = lvl === "error" ? "#ff4444" : lvl === "warning" ? "#ff9000" : "#666666";
  const kindColor = lvl === "error" ? "#ff4444" : lvl === "warning" ? "#ff9000" : "#ffffff";
  const fields = Object.entries(e)
    .filter(([k]) => !["ts", "channel", "kind", "level", "run_id"].includes(k))
    .map(([k, v]) => `<span style="color:#666">${k}=</span><span style="color:#aaa">${
      typeof v === 'object' ? JSON.stringify(v) : String(v)
    }</span>`)
    .join("  ");
  return `<div style="display:grid;grid-template-columns:70px 50px 90px 200px 1fr;
                      align-items:center;padding:2px 0;
                      border-bottom:1px solid #111;
                      font-family:var(--mono);font-size:11px;line-height:1.4">
    <span style="color:#444">${fmtTimeLocal(e.ts)}</span>
    <span style="color:${lvlColor};font-size:10px">[${lvl.toUpperCase()}]</span>
    <span style="color:#555">${e.channel ?? ""}</span>
    <span style="color:${kindColor}">${e.kind ?? ""}</span>
    <span style="color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fields}</span>
  </div>`;
}

async function renderLogs(source) {
  try {
    const d = await jget(`/api/logs/${source}?max_lines=300`);
    const events = (d.events ?? []).reverse();
    if (!events.length) {
      setSoft(`<div class="muted">No log events today for ${source}.</div>`);
      return;
    }
    const html = events.map(_fmtLogRow).join("");
    set(`<div class="card"><div style="padding:4px 0">${html}</div></div>`);
  } catch (e) {
    renderError(e);
  }
}

// ──────────────── DRIFTEDGE NEWS (Bloomberg-style) ────────────────

let newsFilter = { category: "", sentiment: "" };

async function renderDENews() {
  try {
    const qs = new URLSearchParams();
    if (newsFilter.category) qs.set("category", newsFilter.category);
    if (newsFilter.sentiment) qs.set("sentiment", newsFilter.sentiment);
    qs.set("limit", "300");
    const d = await jget("/api/driftedge/news?" + qs.toString());
    if (d.status !== "ok") {
      setSoft(`<div class="muted">No news yet. Run <code>driftedge fetch-news</code> or wait for the daemon's 15-minute sweep.</div>`);
      return;
    }
    const sG = d.stats_global || d.stats || {};
    const sF = d.stats_filtered || sG;
    const cats = Object.keys(sG.by_category || {}).sort();
    const filterLabel = newsFilter.category ? `· ${newsFilter.category.toUpperCase()}` : "· ALL";

    set(`
      <div class="grid grid-4" style="margin-bottom:12px">
        ${kpi("Items " + filterLabel, sF.total ?? 0, `of ${sG.total ?? 0} total`)}
        ${kpi("Positive", `<span class="pos">${sF.by_sentiment?.positive ?? 0}</span>`,
              `${pctOf(sF.by_sentiment?.positive, sF.total)}% of shown`)}
        ${kpi("Negative", `<span class="neg">${sF.by_sentiment?.negative ?? 0}</span>`,
              `${pctOf(sF.by_sentiment?.negative, sF.total)}% of shown`)}
        ${kpi("Neutral", `<span class="muted">${sF.by_sentiment?.neutral ?? 0}</span>`,
              `${pctOf(sF.by_sentiment?.neutral, sF.total)}% of shown`)}
      </div>

      <div class="news-filter-bar">
        <span class="muted mono" style="font-size:10px">Filter:</span>
        <select id="catFilter">
          <option value="">All categories</option>
          ${cats.map(c => `<option value="${c}" ${newsFilter.category===c?'selected':''}>${c.toUpperCase()} (${sG.by_category[c]})</option>`).join('')}
        </select>
        <select id="sentFilter">
          <option value="">All sentiment</option>
          <option value="positive" ${newsFilter.sentiment==='positive'?'selected':''}>POSITIVE</option>
          <option value="negative" ${newsFilter.sentiment==='negative'?'selected':''}>NEGATIVE</option>
          <option value="neutral"  ${newsFilter.sentiment==='neutral'?'selected':''}>NEUTRAL</option>
        </select>
        <span class="muted mono" style="font-size:10px;margin-left:auto">
          Showing ${d.items.length} · ${sG.override_count || 0} manual overrides
        </span>
      </div>

      <div class="card" style="padding:0">
        <div class="news-row" style="background:var(--bg-2);border-bottom:1px solid var(--border-2);color:var(--primary);text-transform:uppercase;font-size:10px;letter-spacing:0.06em">
          <span>Time (ET)</span><span>Cat</span><span>Source</span><span class="news-sent">Sentiment</span><span>Headline</span>
        </div>
        ${d.items.map(it => {
          const sc = it.sentiment_score;
          const cls = `sent-${it.sentiment_label}`;
          const sign = sc >= 0 ? "+" : "";
          const arrow = it.sentiment_label === "positive" ? "▲" :
                        it.sentiment_label === "negative" ? "▼" : "■";
          const mark = it.overridden ? '<span class="amber" title="manual override">✎</span>' : "";
          return `<div class="news-row">
            <span class="news-time">${fmtTimeLocal(it.published_ts)}</span>
            <span class="news-cat">${(it.category || '—').toUpperCase()}</span>
            <span class="news-source">${(it.source || '—').replace('reddit:', 'r/').slice(0,18)}</span>
            <span class="news-sent ${cls} sent-clickable" data-id="${it.id}"
                  title="click to override sentiment">
              ${mark}${arrow} ${sign}${sc.toFixed(2)}
            </span>
            <span class="news-headline"><a href="${it.url}" target="_blank" rel="noopener">${it.headline}</a></span>
          </div>`;
        }).join('')}
      </div>
    `);

    document.getElementById("catFilter").addEventListener("change", (e) => {
      newsFilter.category = e.target.value;
      renderDENews();
    });
    document.getElementById("sentFilter").addEventListener("change", (e) => {
      newsFilter.sentiment = e.target.value;
      renderDENews();
    });

    document.querySelectorAll(".sent-clickable").forEach(el => {
      el.style.cursor = "pointer";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        openSentimentOverridePopup(el);
      });
    });
  } catch (e) {
    renderError(e);
  }
}

function pctOf(n, total) {
  if (!total || !n) return "0";
  return ((n / total) * 100).toFixed(0);
}

function openSentimentOverridePopup(anchorEl) {
  // Remove any existing popup
  document.querySelectorAll(".sent-popup").forEach(n => n.remove());
  const id = anchorEl.dataset.id;
  const rect = anchorEl.getBoundingClientRect();
  const pop = document.createElement("div");
  pop.className = "sent-popup";
  pop.style.cssText = `position:fixed; top:${rect.bottom + 4}px; left:${rect.left}px;
    background:var(--bg-2); border:1px solid var(--primary); padding:6px;
    z-index:9999; font-family:var(--mono); font-size:11px; display:flex; gap:4px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.6);`;
  pop.innerHTML = `
    <button data-v="positive" class="pos" style="background:transparent;border:1px solid #00ff88;color:#00ff88;padding:3px 8px;cursor:pointer;font-family:var(--mono);font-size:11px">▲ POS</button>
    <button data-v="neutral"  style="background:transparent;border:1px solid #666;color:#aaa;padding:3px 8px;cursor:pointer;font-family:var(--mono);font-size:11px">■ NEU</button>
    <button data-v="negative" class="neg" style="background:transparent;border:1px solid #ff4444;color:#ff4444;padding:3px 8px;cursor:pointer;font-family:var(--mono);font-size:11px">▼ NEG</button>
    <button data-v="cancel" style="background:transparent;border:1px solid #666;color:#666;padding:3px 8px;cursor:pointer;font-family:var(--mono);font-size:11px">×</button>
  `;
  document.body.appendChild(pop);
  pop.querySelectorAll("button").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const v = btn.dataset.v;
      pop.remove();
      if (v === "cancel") return;
      try {
        const r = await fetch("/api/driftedge/news/override", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, sentiment_label: v }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        renderDENews();
      } catch (err) {
        alert("Override failed: " + err.message);
      }
    });
  });
  // Click-away to close
  setTimeout(() => {
    document.addEventListener("click", function closer(ev) {
      if (!pop.contains(ev.target)) { pop.remove();
        document.removeEventListener("click", closer); }
    });
  }, 50);
}

// ──────────────── MARKET DETAIL MODAL ────────────────

let modalChart = null;

async function openMarketDetail(venue, marketId) {
  // Build overlay
  const back = document.createElement("div");
  back.className = "modal-back";
  back.innerHTML = `
    <div class="modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <span class="modal-title">MARKET DETAIL · ${venue.toUpperCase()} · ${marketId.slice(0,40)}${marketId.length>40?'…':''}</span>
        <button class="modal-close">CLOSE ×</button>
      </div>
      <div class="modal-body" id="modalBody"><div class="muted">Loading…</div></div>
    </div>`;
  back.addEventListener("click", () => closeModal());
  back.querySelector(".modal-close").addEventListener("click", () => closeModal());
  document.body.appendChild(back);

  try {
    const [d, mDist] = await Promise.all([
      jget(`/api/driftedge/market/${venue}/${encodeURIComponent(marketId)}`),
      jget(`/api/driftedge/paper/pnl-distribution?venue=${encodeURIComponent(venue)}&market_id=${encodeURIComponent(marketId)}&bins=15`),
    ]);
    if (d.status === "no_data") {
      document.getElementById("modalBody").innerHTML = '<div class="muted">No data for this market in our archive.</div>';
      return;
    }
    const m = d.meta || {};
    const histCount = d.history.length;
    const html = `
      <div class="grid grid-4" style="margin-bottom:14px">
        ${kpi("Category", (m.category || '—').toUpperCase())}
        ${kpi("Yes mid", m.yes_price != null ? fmt(m.yes_price, 3) : '—')}
        ${kpi("Spread", m.spread != null ? fmt(m.spread, 3) : '—')}
        ${kpi("Vol 24h", m.volume_24h != null ? '$' + fmtInt(m.volume_24h) : '—')}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">QUESTION</div>
        <div style="font-family:var(--mono);font-size:13px">${m.question ?? '(unknown)'}</div>
        ${m.end_date ? `<div class="muted mono" style="font-size:11px;margin-top:6px">Resolves: ${fmtTsLocal(m.end_date)} ET</div>` : ''}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">PRICE HISTORY · ${histCount} ORDERBOOK SNAPSHOTS</div>
        ${histCount > 0
          ? '<div class="chart-wrap tall"><canvas id="detailHistChart"></canvas></div>'
          : '<div class="muted">No orderbook snapshots archived for this market yet.</div>'}
      </div>
      <div class="card" style="margin-bottom:14px">
        <div class="card-title">P&L DISTRIBUTION ON THIS MARKET</div>
        ${mDist && mDist.status === "ok"
          ? renderDistMeta(mDist) + '<div class="chart-wrap"><canvas id="detailDistChart"></canvas></div>'
          : '<div class="muted">No realized P&L on this market yet.</div>'}
      </div>
      ${d.trades.length ? `
        <div class="card">
          <div class="card-title">PAPER TRADES ON THIS MARKET (${d.trades.length})</div>
          <table>
            <thead><tr><th>Trader</th><th>Entry @</th><th class="r">Entry</th>
              <th>Exit @</th><th class="r">Exit</th><th>Reason</th><th class="r">P&L</th></tr></thead>
            <tbody>${d.trades.map(t => {
              const cls = signClass(t.pnl_usd);
              return `<tr>
                <td style="color:${traderColor(t.trader) || 'var(--text)'}">${(t.trader || '—').toUpperCase()}</td>
                <td class="muted" style="font-size:10px">${fmtTsLocal(t.entry_ts)}</td>
                <td class="r">${fmt(t.entry_price, 3)}</td>
                <td class="muted" style="font-size:10px">${fmtTsLocal(t.exit_ts)}</td>
                <td class="r">${t.exit_price != null ? fmt(t.exit_price, 3) : '—'}</td>
                <td class="amber">${t.exit_reason ?? (t.status === 'open' ? '(open)' : '—')}</td>
                <td class="r ${cls}">${t.pnl_usd != null ? '$' + signFmt(t.pnl_usd, 2) : '—'}</td>
              </tr>`;
            }).join('')}</tbody>
          </table>
        </div>` : ''}
    `;
    document.getElementById("modalBody").innerHTML = html;

    if (mDist && mDist.status === "ok") {
      drawHistogramChart("detailDistChart", mDist, "#ff9000");
    }
    if (histCount > 0) {
      const ctx = document.getElementById("detailHistChart").getContext("2d");
      modalChart = new Chart(ctx, {
        type: "line",
        data: {
          datasets: [
            { label: "MID", data: d.history.map(p => ({ x: p.ts, y: p.mid })),
              borderColor: "#ff9000", borderWidth: 2, pointRadius: 0,
              spanGaps: true, tension: 0.05 },
            { label: "BID", data: d.history.map(p => ({ x: p.ts, y: p.bid })),
              borderColor: "#00ff88", borderWidth: 1, borderDash: [3,3],
              pointRadius: 0, spanGaps: true, tension: 0.05 },
            { label: "ASK", data: d.history.map(p => ({ x: p.ts, y: p.ask })),
              borderColor: "#ff4444", borderWidth: 1, borderDash: [3,3],
              pointRadius: 0, spanGaps: true, tension: 0.05 },
          ],
        },
        options: {
          ...CHART_BASE,
          scales: {
            x: CHART_TIME_OPTS,
            y: { ...CHART_BASE.scales.y, min: 0, max: 1,
                 ticks: { ...CHART_BASE.scales.y.ticks,
                          callback: v => Number(v).toFixed(2) }},
          },
        },
      });
    }
  } catch (e) {
    document.getElementById("modalBody").innerHTML = `<div class="neg">Error: ${e.message}</div>`;
  }
}

function closeModal() {
  const back = document.querySelector(".modal-back");
  if (back) back.remove();
  if (modalChart) { try { modalChart.destroy(); } catch (e) {} modalChart = null; }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModal();
});

document.addEventListener("DOMContentLoaded", init);
