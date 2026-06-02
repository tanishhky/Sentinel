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
    { id: "chain", label: "CHAIN", render: renderPSChain },
    { id: "flags", label: "FLAGS", render: renderPSFlags },
    { id: "logs",  label: "LOGS",  render: () => renderLogs("pinsight") },
  ],
  driftedge: [
    { id: "paper",   label: "PAPER",   render: renderDEPaper },
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
let activeSub = { pinsight: "chain", driftedge: "paper", sentinel: "health" };
let refreshTimer = null;
let chartRegistry = {};

const TRADER_COLORS = {
  kelly: "#ff9000",
  equal: "#00d4ff",
  volwt: "#ff66cc",
  volharvest: "#88ff66",   // lime — distinct from the three legacy traders
};
const TRADER_LABELS = { kelly: "KELLY", equal: "EQUAL-WT", volwt: "VOL-WT",
                        volharvest: "VOL-HARVEST" };
const TRADER_DESC = {
  kelly: "Quarter-Kelly · p=0.45",
  equal: "Fixed 2% per trade",
  volwt: "Inverse-σ weighted",
  volharvest: "Underdog YES + synthetic-NO hedge",
};
const ALL_TRADERS = ["kelly", "equal", "volwt", "volharvest"];

function init() {
  const topTabsEl = document.getElementById("top-tabs");
  TOP_TABS.forEach(t => {
    const b = document.createElement("button");
    b.className = "tab" + (t.id === activeTop ? " active" : "");
    b.textContent = t.label;
    b.onclick = () => { activeTop = t.id; rerender(); };
    topTabsEl.appendChild(b);
  });

  const clock = document.getElementById("clock");
  setInterval(() => {
    clock.textContent = fmtTsLocal(new Date()) + " ET";
  }, 1000);

  rerender();
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(rerender, 5000);
}

function rerender() {
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
      b.onclick = () => { activeSub[activeTop] = s.id; rerender(); };
      subTabsEl.appendChild(b);
    });
    subTabsEl.style.display = "";
  } else {
    subTabsEl.style.display = "none";
  }

  Object.values(chartRegistry).forEach(c => { try { c.destroy(); } catch (e) {} });
  chartRegistry = {};

  if (activeTop === "dashboard") {
    renderDashboard();
  } else {
    const sub = subs.find(s => s.id === activeSub[activeTop]);
    if (sub) sub.render();
  }
}

async function jget(path) {
  const r = await fetch(path);
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

function set(html) {
  document.getElementById("content").innerHTML = html;
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
    const [paper, eq, chain, markets, health] = await Promise.all([
      jget("/api/driftedge/paper"),
      jget("/api/driftedge/paper/equity-history"),
      jget("/api/pinsight/chain"),
      jget("/api/driftedge/markets?top=5"),
      jget("/api/sentinel/health"),
    ]);

    const s = paper.summary || {};
    const t = s.by_trader || {};
    const ps = chain?.status === "ok";

    set(`
      <div class="grid grid-4" style="margin-bottom:16px">
        ${kpi("PinSight chain", ps ? chain.contracts : "—",
              ps ? `${chain.underlying} · ${chain.expiry}` : "(no chain yet)")}
        ${kpi("Spot", ps ? `$${fmt(chain.underlying_price)}` : "—")}
        ${kpi("DriftEdge polling",
              health.driftedge.launchd.poll.loaded ? "ACTIVE" : "STOPPED",
              `${health.driftedge.data_size_mb} MB archived`)}
        ${kpi("Paper trades", s.total_trades ?? 0,
              `${s.open_count ?? 0} open · ${s.closed_count ?? 0} closed`)}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">4-TRADER EQUITY CURVE · $10,000 BANKROLL EACH</div>
        <div class="chart-wrap tall"><canvas id="equityChart"></canvas></div>
      </div>

      <div class="grid grid-4" style="margin-bottom:16px">
        ${ALL_TRADERS.map(id => {
          const x = t[id] || {};
          const ret = x.return_pct;
          const retClass = signClass(ret);
          return `<div class="card">
            <div class="card-title" style="color:${TRADER_COLORS[id]}">${TRADER_LABELS[id]}</div>
            <div class="muted mono" style="font-size:10px;margin-bottom:6px">${TRADER_DESC[id]}</div>
            <div class="kpi-value mono ${retClass}">${ret != null ? signFmt(ret, 3) + "%" : "—"}</div>
            <div class="muted mono" style="font-size:10px">Return · Equity $${fmt(x.total_equity ?? 0, 2)}</div>
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

    drawEquityChart("equityChart", eq);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
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

function drawEquityChart(canvasId, eq) {
  if (eq.status !== "ok") return;
  const datasets = [];
  for (const trader of ALL_TRADERS) {
    const series = eq.series[trader];
    if (!series || !series.length) continue;
    datasets.push({
      label: TRADER_LABELS[trader],
      data: series.map(p => ({ x: p.ts, y: p.equity })),
      borderColor: TRADER_COLORS[trader],
      backgroundColor: TRADER_COLORS[trader] + "33",
      borderWidth: 2,
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

async function renderPSChain() {
  try {
    const [d, full] = await Promise.all([
      jget("/api/pinsight/chain"),
      jget("/api/pinsight/chain/full?top_contracts=40"),
    ]);
    if (d.status !== "ok") {
      set(`<div class="muted">No chain data yet. Run <code>pinsight fetch-chain SPY</code> or wait for the morning launchd job.</div>`);
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
    set(`<div class="neg">Error: ${e.message}</div>`);
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
      set(`<div class="muted">No flagged contracts.</div>`);
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
    set(`<div class="neg">Error: ${e.message}</div>`);
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
    const baseFetches = [
      jget("/api/driftedge/paper"),
      jget("/api/driftedge/paper/equity-history"),
      jget("/api/driftedge/paper/risk-stats"),
    ];
    const distFetches = ALL_TRADERS.map(t =>
      jget(`/api/driftedge/paper/pnl-distribution?trader=${t}`));
    const results = await Promise.all([...baseFetches, ...distFetches]);
    const [d, eq, risk] = results;
    const distArr = results.slice(3);
    const dists = Object.fromEntries(ALL_TRADERS.map((t, i) => [t, distArr[i]]));
    if (d.status !== "ok") {
      set(`<div class="muted">No paper trades yet.</div>`);
      return;
    }
    const s = d.summary;
    const TRADERS = ALL_TRADERS;

    const traderCards = TRADERS.map(t => {
      const x = s.by_trader?.[t] || {};
      const ret = x.return_pct;
      const retClass = signClass(ret);
      const pnlClass = signClass(x.closed_pnl);
      const ddClass = (x.drawdown_pct ?? 0) > 5 ? "neg" : "muted";
      return `<div class="card">
        <div class="card-title" style="color:${TRADER_COLORS[t]}">${TRADER_LABELS[t]}</div>
        <div class="muted mono" style="font-size:10px;margin-bottom:6px">${TRADER_DESC[t]}</div>
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
      <div class="grid grid-4" style="margin-bottom:16px">${traderCards}</div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">EQUITY CURVE · 4-TRADER HORSE RACE <span class="muted" style="font-weight:normal;font-size:10px">(continuous MTM, updates every tick)</span></div>
        <div class="chart-wrap tall"><canvas id="paperEquityChart"></canvas></div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">RISK STATS · MTM-DERIVED</div>
        ${renderRiskPanel(risk)}
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-title">P&L DISTRIBUTION PER TRADER <span class="muted" style="font-weight:normal;font-size:10px">(realized closed trades — test for normality / fat tails)</span></div>
        <div class="grid grid-4">
          ${ALL_TRADERS.map(t => `
            <div>
              <div class="muted mono" style="font-size:10px;margin-bottom:4px;color:${TRADER_COLORS[t]}">${TRADER_LABELS[t]}</div>
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
            <td style="color:${TRADER_COLORS[r.trader]}">${(r.trader || '—').toUpperCase()}</td>
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
            <div><span class="muted">Bankroll / trader:</span> <span class="amber">$10,000</span></div>
            <div><span class="muted">Per-position cap:</span> <span>2% = $200</span></div>
            <div><span class="muted">Aggregate cap:</span> <span>50% = $5,000</span></div>
            <div><span class="muted">Min trade:</span> <span>$5</span></div>
            <div><span class="muted">Entry zone:</span> <span>[0.30, 0.40] <span class="muted">(hardcoded)</span></span></div>
            <div><span class="muted">Target / Stop:</span> <span class="pos">0.60</span> / <span class="neg">0.20</span></div>
            <div><span class="muted">Force-exit:</span> <span>6h before resolution</span></div>
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
              <td style="color:${TRADER_COLORS[r.trader]}">${(r.trader || '—').toUpperCase()}</td>
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

    drawEquityChart("paperEquityChart", eq);
    for (const t of ALL_TRADERS) {
      drawHistogramChart(`distChart_${t}`, dists[t], TRADER_COLORS[t]);
    }
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

function renderRiskPanel(risk) {
  if (!risk || risk.status !== "ok") {
    return '<div class="muted">No risk-history yet — needs a few ticks of paper engine activity.</div>';
  }
  const TRADERS = ALL_TRADERS;
  const cells = TRADERS.map(t => {
    const r = risk.by_trader[t] || {};
    const retCls = signClass(r.total_return_pct);
    const ddCls = (r.max_drawdown_pct ?? 0) > 5 ? "neg" : "muted";
    const sharpe = r.sharpe;
    const sharpeCls = sharpe == null ? "muted" : (sharpe > 0 ? "pos" : "neg");
    return `<div>
      <div class="muted mono" style="font-size:10px;color:${TRADER_COLORS[t]}">${TRADER_LABELS[t]}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px 12px;font-family:var(--mono);font-size:11px;margin-top:6px">
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
  }).join("");
  return `<div class="grid grid-4">${cells}</div>`;
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
      set(`<div class="muted">No DriftEdge data yet.</div>`);
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
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderDEBooks() {
  try {
    const d = await jget("/api/driftedge/books");
    if (d.status !== "ok" || !d.items?.length) {
      set(`<div class="muted">No orderbook snapshots yet.</div>`);
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
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderSEHealth() {
  try {
    const h = await jget("/api/sentinel/health");
    if (h.status !== "ok") {
      set(`<div class="neg">Health endpoint returned ${h.status}</div>`);
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
            <div>Morning: ${statusPill(ps.launchd.morning.loaded, ps.launchd.morning.pid)}</div>
            <div>Midday: ${statusPill(ps.launchd.midday.loaded, ps.launchd.midday.pid)}</div>
            <div>Close: ${statusPill(ps.launchd.close.loaded, ps.launchd.close.pid)}</div>
            <div style="margin-top:8px"><span class="muted">Data:</span> ${ps.data_size_mb} MB</div>
            <div><span class="muted">Logs today:</span> ${ps.log_size_today_mb} MB</div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">DRIFTEDGE</div>
          <div style="font-family:var(--mono);font-size:11px;line-height:1.8">
            <div>Poll: ${statusPill(de.launchd.poll.loaded, de.launchd.poll.pid)}</div>
            <div style="margin-top:8px"><span class="muted">Data:</span> ${de.data_size_mb} MB</div>
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
    const html = events.map(e => `<div class="log-line log-${(e.level ?? "info").toLowerCase()}">
      <span class="log-ts">${fmtTimeLocal(e.ts)}</span>
      <span class="log-channel">${e.channel}</span>
      <span class="log-kind">${e.kind}</span>
    </div>`).join("");
    document.getElementById("recentLogs").innerHTML = html || '<span class="muted">No events.</span>';
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
  }
}

async function renderLogs(source) {
  try {
    const d = await jget(`/api/logs/${source}?max_lines=300`);
    const events = (d.events ?? []).reverse();
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
      return `<div class="log-line log-${(e.level ?? "info").toLowerCase()}">
        <span class="log-ts">${fmtTimeLocal(e.ts)}</span>
        <span class="log-channel">${e.channel}</span>
        <span class="log-kind">${e.kind}</span>${fields}
      </div>`;
    }).join("");
    set(`<div class="card"><div class="logs">${html}</div></div>`);
  } catch (e) {
    set(`<div class="neg">Error: ${e.message}</div>`);
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
      set(`<div class="muted">No news yet. Run <code>driftedge fetch-news</code> or wait for the daemon's 15-minute sweep.</div>`);
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
    set(`<div class="neg">Error: ${e.message}</div>`);
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
                <td style="color:${TRADER_COLORS[t.trader] || 'var(--text)'}">${(t.trader || '—').toUpperCase()}</td>
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
