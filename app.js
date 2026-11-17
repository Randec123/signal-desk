/* Signal Desk — paper-trade viewer for Options Signal Scout and Stock Signal Scout. */
(() => {
  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "options", label: "Options" },
    { id: "stocks", label: "Stocks" },
  ];

  const state = {
    data: null,
    tab: "overview",
    selectedId: null,
    filters: {
      options: emptyFilters(),
      stocks: emptyFilters(),
    },
    sort: {
      options: { key: "alert_time_et", dir: "desc" },
      stocks: { key: "alert_time_et", dir: "desc" },
    },
  };

  function emptyFilters() {
    return { ticker: "", status: "", side: "", rating: "", firstHit: "", from: "", to: "" };
  }

  const workspace = () => document.getElementById("workspace");
  const statusBar = () => document.getElementById("status-bar");
  const drawer = () => document.getElementById("drawer");

  function $(sel, root = document) {
    return root.querySelector(sel);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isBlank(value) {
    return value === null || value === undefined || value === "";
  }

  function dash(value) {
    return isBlank(value) ? "—" : String(value);
  }

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(Number(value))) return "—";
    return Number(value).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatUsd(value) {
    if (!Number.isFinite(Number(value))) return "—";
    const n = Number(value);
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}$${formatNumber(Math.abs(n), 2)}`;
  }

  function formatSigned(value, digits = 2, suffix = "") {
    if (!Number.isFinite(Number(value))) return "—";
    const n = Number(value);
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}${formatNumber(Math.abs(n), digits)}${suffix}`;
  }

  function formatPct(value) {
    if (!Number.isFinite(Number(value))) return "—";
    return formatSigned(value, 2, "%");
  }

  function formatWinRate(rate, winners, closed) {
    if (!Number.isFinite(Number(rate)) || !closed) return "—";
    return `${formatNumber(Number(rate) * 100, 1)}% (${winners}/${closed})`;
  }

  function pnlClass(value) {
    if (!Number.isFinite(Number(value))) return "";
    if (Number(value) > 0) return "up";
    if (Number(value) < 0) return "down";
    return "";
  }

  function statusChip(status) {
    const raw = dash(status);
    const key = String(status || "").toLowerCase();
    const cls = key === "open" ? "open"
      : key === "partial" ? "partial"
      : key === "closed" ? "closed"
      : key === "missed entry" ? "missed"
      : "";
    return `<span class="chip ${cls}">${escapeHtml(raw)}</span>`;
  }

  function firstHitChip(hit) {
    if (isBlank(hit)) return "";
    const cls = String(hit).toLowerCase() === "stop" ? "stop" : "hit";
    return `<span class="chip ${cls}">${escapeHtml(hit)}</span>`;
  }

  function sideClass(side) {
    const s = String(side || "").toUpperCase();
    if (s === "CALL" || s === "LONG") return "side-call";
    if (s === "PUT" || s === "SHORT") return "side-put";
    return "";
  }

  function etStamp(value) {
    if (isBlank(value)) return "—";
    const text = String(value);
    return /ET\b/.test(text) ? text : `${text} ET`;
  }

  function alertDate(alert) {
    const text = String(alert?.alert_time_et || "");
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function parseHash() {
    const raw = (location.hash || "#overview").replace(/^#/, "");
    const [tab, id] = raw.split("/");
    if (TABS.some((t) => t.id === tab)) {
      state.tab = tab;
      state.selectedId = id || null;
    } else {
      state.tab = "overview";
      state.selectedId = null;
    }
  }

  function setHash(tab, id) {
    const next = id ? `#${tab}/${id}` : `#${tab}`;
    if (location.hash !== next) history.replaceState(null, "", next);
    state.tab = tab;
    state.selectedId = id || null;
  }

  function botOf(alertId) {
    if (String(alertId).startsWith("OSS-")) return "options";
    if (String(alertId).startsWith("SSS-")) return "stocks";
    return null;
  }

  function findAlert(alertId) {
    const data = state.data;
    if (!data || !alertId) return null;
    const hit = data.options.alerts.find((a) => a.alert_id === alertId)
      || data.stocks.alerts.find((a) => a.alert_id === alertId);
    return hit || null;
  }

  async function loadData() {
    const res = await fetch(`data/desk.json?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not load desk data (${res.status})`);
    state.data = await res.json();
  }

  function renderNav() {
    const ossN = state.data?.options?.summary?.alerts ?? 0;
    const sssN = state.data?.stocks?.summary?.alerts ?? 0;
    const counts = { overview: ossN + sssN, options: ossN, stocks: sssN };
    const side = document.getElementById("side-nav");
    const mobile = document.getElementById("mobile-tabs");
    const buttons = TABS.map((tab) => {
      const active = state.tab === tab.id ? "active" : "";
      return `<button type="button" class="nav-btn ${active}" data-tab="${tab.id}">
        ${escapeHtml(tab.label)}<span class="count">${counts[tab.id]}</span>
      </button>`;
    }).join("");
    const mobileBtns = TABS.map((tab) => {
      const active = state.tab === tab.id ? "active" : "";
      return `<button type="button" class="${active}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>`;
    }).join("");
    side.innerHTML = buttons;
    mobile.innerHTML = mobileBtns;
    [...side.querySelectorAll("[data-tab]"), ...mobile.querySelectorAll("[data-tab]")].forEach((btn) => {
      btn.addEventListener("click", () => {
        setHash(btn.getAttribute("data-tab"));
        render();
      });
    });
  }

  function renderStatus() {
    const d = state.data;
    if (!d) {
      statusBar().innerHTML = `<span class="err">No data loaded.</span>`;
      return;
    }
    statusBar().innerHTML = `
      <span class="pill snap">PAPER TRADES</span>
      <span class="pill">Options ${d.options.summary.alerts}</span>
      <span class="pill">Stocks ${d.stocks.summary.alerts}</span>
      <span class="status-asof">As of ${escapeHtml(d.asOfET)}</span>
    `;
  }

  function uniqueValues(alerts, key) {
    return [...new Set(alerts.map((a) => a[key]).filter((v) => !isBlank(v)).map(String))].sort();
  }

  function applyFilters(alerts, filters) {
    return alerts.filter((a) => {
      if (filters.ticker && String(a.ticker) !== filters.ticker) return false;
      if (filters.status && String(a.status) !== filters.status) return false;
      if (filters.side && String(a.side) !== filters.side) return false;
      if (filters.rating && String(a.rating) !== filters.rating) return false;
      if (filters.firstHit === "__none__" && !isBlank(a.first_hit)) return false;
      if (filters.firstHit && filters.firstHit !== "__none__" && String(a.first_hit) !== filters.firstHit) return false;
      const day = alertDate(a);
      if (filters.from && day && day < filters.from) return false;
      if (filters.to && day && day > filters.to) return false;
      return true;
    });
  }

  function compareValues(a, b, key, dir) {
    const av = a?.[key];
    const bv = b?.[key];
    const aBlank = isBlank(av);
    const bBlank = isBlank(bv);
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    let cmp = 0;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv), "en", { numeric: true, sensitivity: "base" });
    return dir === "asc" ? cmp : -cmp;
  }

  function sortAlerts(alerts, sort) {
    const copy = alerts.slice();
    copy.sort((a, b) => compareValues(a, b, sort.key, sort.dir));
    return copy;
  }

  function optionSelect(id, label, value, options, includeBlank = "All") {
    const opts = [`<option value="">${escapeHtml(includeBlank)}</option>`]
      .concat(options.map((o) => {
        const val = typeof o === "object" ? o.value : o;
        const lab = typeof o === "object" ? o.label : o;
        return `<option value="${escapeHtml(val)}" ${String(value) === String(val) ? "selected" : ""}>${escapeHtml(lab)}</option>`;
      }));
    return `<div class="filter">
      <label for="${id}">${escapeHtml(label)}</label>
      <select id="${id}">${opts.join("")}</select>
    </div>`;
  }

  function dateInput(id, label, value) {
    return `<div class="filter">
      <label for="${id}">${escapeHtml(label)}</label>
      <input type="date" id="${id}" value="${escapeHtml(value || "")}" />
    </div>`;
  }

  function renderFilters(kind, alerts) {
    const f = state.filters[kind];
    const firstHits = uniqueValues(alerts, "first_hit");
    const firstOpts = firstHits.map((v) => ({ value: v, label: v }));
    firstOpts.push({ value: "__none__", label: "None yet" });
    return `<div class="filters" data-filters="${kind}">
      ${optionSelect(`${kind}-ticker`, "Ticker", f.ticker, uniqueValues(alerts, "ticker"))}
      ${optionSelect(`${kind}-status`, "Status", f.status, uniqueValues(alerts, "status"))}
      ${optionSelect(`${kind}-side`, "Direction", f.side, uniqueValues(alerts, "side"))}
      ${optionSelect(`${kind}-rating`, "Rating", f.rating, uniqueValues(alerts, "rating"))}
      ${optionSelect(`${kind}-first`, "First hit", f.firstHit, firstOpts)}
      ${dateInput(`${kind}-from`, "From", f.from)}
      ${dateInput(`${kind}-to`, "To", f.to)}
      <div class="filter"><label>&nbsp;</label><button type="button" class="btn" data-clear-filters="${kind}">Clear</button></div>
    </div>`;
  }

  function bindFilters(kind) {
    const box = $(`[data-filters="${kind}"]`);
    if (!box) return;
    const f = state.filters[kind];
    const map = [
      [`#${kind}-ticker`, "ticker"],
      [`#${kind}-status`, "status"],
      [`#${kind}-side`, "side"],
      [`#${kind}-rating`, "rating"],
      [`#${kind}-first`, "firstHit"],
      [`#${kind}-from`, "from"],
      [`#${kind}-to`, "to"],
    ];
    map.forEach(([sel, key]) => {
      const el = $(sel, box);
      if (!el) return;
      el.addEventListener("change", () => {
        f[key] = el.value;
        render();
      });
    });
    const clear = $(`[data-clear-filters="${kind}"]`, box);
    if (clear) {
      clear.addEventListener("click", () => {
        state.filters[kind] = emptyFilters();
        render();
      });
    }
  }

  function th(label, key, sort, extraClass = "") {
    const active = sort.key === key;
    const cls = `sortable ${extraClass} ${active ? "sorted" : ""} ${active && sort.dir === "asc" ? "asc" : ""}`.trim();
    return `<th class="${cls}" data-sort="${escapeHtml(key)}">${escapeHtml(label)}</th>`;
  }

  function bindSort(kind) {
    workspace().querySelectorAll("th[data-sort]").forEach((thEl) => {
      thEl.addEventListener("click", () => {
        const key = thEl.getAttribute("data-sort");
        const current = state.sort[kind];
        if (current.key === key) current.dir = current.dir === "asc" ? "desc" : "asc";
        else {
          current.key = key;
          current.dir = key === "alert_time_et" ? "desc" : "desc";
        }
        render();
      });
    });
  }

  function bindAlertClicks() {
    workspace().querySelectorAll("[data-alert-id]").forEach((el) => {
      el.addEventListener("click", () => openAlert(el.getAttribute("data-alert-id")));
    });
  }

  function openAlert(alertId) {
    const bot = botOf(alertId) || state.tab;
    const tab = bot === "options" || bot === "stocks" ? bot : state.tab;
    setHash(tab, alertId);
    render();
    renderDrawer(alertId);
  }

  function closeDrawer() {
    const tab = state.tab === "overview" ? "overview" : (botOf(state.selectedId) || state.tab);
    setHash(tab === "overview" ? "overview" : tab);
    drawer().hidden = true;
    drawer().innerHTML = "";
    workspace().querySelectorAll("tr.selected").forEach((r) => r.classList.remove("selected"));
  }

  function renderDrawer(alertId) {
    const alert = findAlert(alertId);
    const root = drawer();
    if (!alert) {
      root.hidden = true;
      root.innerHTML = "";
      return;
    }
    const kind = botOf(alert.alert_id);
    const title = `${alert.alert_id} · ${dash(alert.ticker)} ${dash(alert.side)}`;
    const levels = kind === "options" ? optionLevels(alert) : stockLevels(alert);
    const exits = exitBlocks(alert, kind);
    const fields = kind === "options" ? optionFields(alert) : stockFields(alert);
    root.hidden = false;
    root.innerHTML = `<div class="drawer-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="drawer-top">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
            ${statusChip(alert.status)}
            ${firstHitChip(alert.first_hit)}
            <span class="chip">${escapeHtml(dash(alert.rating))}</span>
            <span class="pill snap">PAPER</span>
          </div>
        </div>
        <button type="button" class="drawer-close" data-close-drawer aria-label="Close">×</button>
      </div>
      <div class="section-label">Setup</div>
      <p style="margin:0 0 12px;font-size:13px;color:var(--text)">${escapeHtml(dash(alert.setup_type))}</p>
      <div class="section-label">Levels</div>
      <div class="levels">${levels}</div>
      <div class="section-label">Details</div>
      <dl class="kv">${fields}</dl>
      ${exits}
      ${isBlank(alert.notes) ? "" : `<div class="section-label">Notes</div><div class="notes">${escapeHtml(alert.notes)}</div>`}
    </div>`;
    $("[data-close-drawer]", root).addEventListener("click", closeDrawer);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeDrawer();
    });
  }

  function kv(label, value, cls = "") {
    if (value === undefined) return "";
    const display = isBlank(value) && value !== 0 ? "—" : value;
    return `<dt>${escapeHtml(label)}</dt><dd class="${cls}">${typeof display === "string" && display.includes("<") ? display : escapeHtml(String(display))}</dd>`;
  }

  function optionFields(a) {
    return [
      kv("Alert time", etStamp(a.alert_time_et)),
      kv("Contract", a.contract_desc),
      kv("OCC symbol", a.contract_occ, "mono"),
      kv("Expiry", a.expiry),
      kv("Time-exit date", a.time_exit_date),
      kv("Contracts", a.contracts),
      kv("Entry zone", zoneText(a.entry_zone_lo, a.entry_zone_hi)),
      kv("Underlying at alert", formatNumber(a.underlying_at_alert, 2)),
      kv("Entry fill", formatNumber(a.entry_fill, 2)),
      kv("Entry source", a.entry_source),
      kv("Stop rule", a.stop_rule),
      kv("Stop level", formatNumber(a.stop_level, 2)),
      kv("Exit rule", a.exit_rule),
      kv("Paper P&L ($)", `<span class="${pnlClass(a.pnl_usd)}">${formatUsd(a.pnl_usd)}</span>`),
      kv("Paper P&L (%)", `<span class="${pnlClass(a.pnl_pct)}">${formatPct(a.pnl_pct)}</span>`),
      kv("Underlying R", `<span class="${pnlClass(a.r_underlying)}">${formatSigned(a.r_underlying, 2, "R")}</span>`),
      kv("Option MFE / MAE", `${formatSigned(a.mfe_opt, 2)} / ${formatSigned(a.mae_opt, 2)}`),
      kv("Underlying MFE / MAE", `${formatSigned(a.mfe_und, 2)} / ${formatSigned(a.mae_und, 2)}`),
      kv("Alt rule", a.alt_rule),
      isBlank(a.alt_pnl_usd) && isBlank(a.alt_pnl_pct) && isBlank(a.alt_r_underlying)
        ? ""
        : kv("Alt P&L / R", `<span class="${pnlClass(a.alt_pnl_usd)}">${formatUsd(a.alt_pnl_usd)}</span> · <span class="${pnlClass(a.alt_pnl_pct)}">${formatPct(a.alt_pnl_pct)}</span> · <span class="${pnlClass(a.alt_r_underlying)}">${formatSigned(a.alt_r_underlying, 2, "R")}</span>`),
    ].join("");
  }

  function stockFields(a) {
    return [
      kv("Alert time", etStamp(a.alert_time_et)),
      kv("Price at alert", formatNumber(a.price_at_alert, 2)),
      kv("Entry zone", zoneText(a.entry_zone_lo, a.entry_zone_hi)),
      kv("Entry time", etStamp(a.entry_time)),
      kv("Entry price", formatNumber(a.entry_px, 2)),
      kv("Stop", formatNumber(a.stop, 2)),
      kv("Exit rule", a.exit_rule),
      kv("Paper P&L ($/share)", `<span class="${pnlClass(a.pnl_per_share)}">${formatSigned(a.pnl_per_share, 4)}</span>`),
      kv("R result", `<span class="${pnlClass(a.r_result)}">${formatSigned(a.r_result, 3, "R")}</span>`),
      kv("MFE / MAE", `${formatSigned(a.mfe, 4)} / ${formatSigned(a.mae, 4)}`),
    ].join("");
  }

  function zoneText(lo, hi) {
    if (isBlank(lo) && isBlank(hi)) return "—";
    return `${formatNumber(lo, 2)} – ${formatNumber(hi, 2)}`;
  }

  function optionLevels(a) {
    const rows = [
      { name: "Stop", px: a.stop_level },
      { name: "Zone lo", px: a.entry_zone_lo },
      { name: "Zone hi", px: a.entry_zone_hi },
      { name: "Underlying", px: a.underlying_at_alert },
      { name: "TP1", px: a.tp1 },
      { name: "TP2", px: a.tp2 },
      { name: "TP3", px: a.tp3 },
    ].filter((r) => Number.isFinite(Number(r.px)));
    return levelRows(rows, a.exit_rule);
  }

  function stockLevels(a) {
    const rows = [
      { name: "Stop", px: a.stop },
      { name: "Zone lo", px: a.entry_zone_lo },
      { name: "Zone hi", px: a.entry_zone_hi },
      { name: "Alert px", px: a.price_at_alert },
      { name: "Entry", px: a.entry_px },
      { name: "TP1", px: a.tp1 },
      { name: "TP2", px: a.tp2 },
      { name: "TP3", px: a.tp3 },
    ].filter((r) => Number.isFinite(Number(r.px)));
    return levelRows(rows, a.exit_rule);
  }

  function levelRows(rows, exitRule) {
    if (!rows.length) return `<div class="empty">No levels in the log.</div>`;
    const prices = rows.map((r) => Number(r.px));
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const span = max - min || 1;
    return rows.map((r) => {
      const px = Number(r.px);
      const width = Math.max(6, ((px - min) / span) * 100);
      const note = r.name === "TP3" && String(exitRule || "").includes("75/25")
        ? `<span class="chip">ignored under 75/25</span>`
        : "";
      return `<div class="level">
        <div class="name">${escapeHtml(r.name)}</div>
        <div class="level-bar"><span style="width:${width}%;background:var(--accent)"></span></div>
        <div class="px">${formatNumber(px, 2)} ${note}</div>
      </div>`;
    }).join("");
  }

  function exitBlocks(alert, kind) {
    const slots = kind === "options"
      ? [
          ["Exit 1", alert.exit1_time, alert.exit1_px, alert.exit1_reason],
          ["Exit 2", alert.exit2_time, alert.exit2_px, alert.exit2_reason],
          ["Exit 3", alert.exit3_time, alert.exit3_px, alert.exit3_reason],
        ]
      : [
          ["Exit 1", alert.exit1_time, alert.exit1_px, alert.exit1_reason],
          ["Exit 2", alert.exit2_time, alert.exit2_px, alert.exit2_reason],
        ];
    const items = slots.filter(([, time, px, reason]) => !isBlank(time) || !isBlank(px) || !isBlank(reason));
    if (!items.length) return "";
    return `<div class="section-label">Outcome / exits</div>
      <div class="exit-list">${items.map(([label, time, px, reason]) => `
        <div class="exit-item">
          <div><strong>${escapeHtml(label)}</strong> · ${formatNumber(px, 4)}</div>
          <div class="when">${escapeHtml(etStamp(time))}</div>
          <div style="margin-top:4px">${escapeHtml(dash(reason))}</div>
        </div>`).join("")}</div>`;
  }

  function summaryCards(summary, kind) {
    const closedPnl = kind === "options" ? formatUsd(summary.closedPnlUsd) : formatSigned(summary.closedPnlPerShare, 4);
    const markPnl = kind === "options" ? formatUsd(summary.markPnlUsd) : formatSigned(summary.markPnlPerShare, 4);
    const closedCls = pnlClass(kind === "options" ? summary.closedPnlUsd : summary.closedPnlPerShare);
    const markCls = pnlClass(kind === "options" ? summary.markPnlUsd : summary.markPnlPerShare);
    const pnlClosedLabel = kind === "options" ? "Closed paper P&L" : "Closed P&L ($/share)";
    const pnlMarkLabel = kind === "options" ? "Mark-to-market P&L" : "Mark-to-market ($/share)";
    return `
      <div class="score-grid">
        <div class="score-card"><div class="k">Alerts</div><div class="v">${summary.alerts}</div><div class="d">Open ${summary.open} · Partial ${summary.partial} · Closed ${summary.closed} · Missed ${summary.missedEntry}</div></div>
        <div class="score-card"><div class="k">Win rate (closed)</div><div class="v">${escapeHtml(formatWinRate(summary.winRate, summary.winners, summary.closedWithPnl))}</div><div class="d">Open, partial, and missed entries are left out.</div></div>
        <div class="score-card"><div class="k">${pnlClosedLabel}</div><div class="v ${closedCls}">${closedPnl}</div><div class="d">${escapeHtml(summary.pnlUnit)}</div></div>
        <div class="score-card"><div class="k">${pnlMarkLabel}</div><div class="v ${markCls}">${markPnl}</div><div class="d">Includes open and partial marks. Closed-only is on the left.${kind === "stocks" && summary.markR != null ? ` Mark R: ${formatSigned(summary.markR, 3, "R")}.` : ""}</div></div>
      </div>`;
  }

  function tickerTable(rows, kind) {
    if (!rows.length) return `<div class="empty">No tickers in the log.</div>`;
    const pnlHead = kind === "options" ? "Mark P&L $" : "Mark $/share";
    const closedHead = kind === "options" ? "Closed P&L $" : "Closed $/share";
    const body = rows.map((r) => `<tr>
      <td>${escapeHtml(r.ticker)}</td>
      <td class="num">${r.alerts}</td>
      <td class="num">${r.open}</td>
      <td class="num">${r.partial}</td>
      <td class="num">${r.closed}</td>
      <td class="num">${r.missedEntry}</td>
      <td class="num">${escapeHtml(formatWinRate(r.winRate, r.winners, r.closedWithPnl))}</td>
      <td class="num ${pnlClass(r.closedPnl)}">${kind === "options" ? formatUsd(r.closedPnl) : formatSigned(r.closedPnl, 4)}</td>
      <td class="num ${pnlClass(r.markPnl)}">${kind === "options" ? formatUsd(r.markPnl) : formatSigned(r.markPnl, 4)}</td>
      <td class="num ${pnlClass(r.markR)}">${formatSigned(r.markR, 3, "R")}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
        <th>Ticker</th><th class="num">Alerts</th><th class="num">Open</th><th class="num">Partial</th>
        <th class="num">Closed</th><th class="num">Missed</th><th class="num">Win rate</th>
        <th class="num">${closedHead}</th><th class="num">${pnlHead}</th><th class="num">Mark R</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>`;
  }

  function renderEquity(series, opts = {}) {
    const { money = false, color = "var(--accent)", height = 220 } = opts;
    if (!series || !series.length) {
      return `<div class="chart-empty">No filled paper trades to plot yet.</div>`;
    }
    const w = 640;
    const h = height;
    const pad = { l: 58, r: 16, t: 16, b: 36 };
    const ys = series.map((p) => p.cumulative);
    let min = Math.min(0, ...ys);
    let max = Math.max(0, ...ys);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const xRange = Math.max(series.length - 1, 1);
    const x = (i) => pad.l + (i / xRange) * (w - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);
    const points = series.map((p, i) => `${x(i).toFixed(1)},${y(p.cumulative).toFixed(1)}`).join(" ");
    const zero = y(0);
    const area = `${x(0).toFixed(1)},${zero.toFixed(1)} ${points} ${x(series.length - 1).toFixed(1)},${zero.toFixed(1)}`;
    const last = series[series.length - 1];
    const ticks = 4;
    const grid = [];
    for (let i = 0; i <= ticks; i++) {
      const v = min + ((max - min) * i) / ticks;
      const yy = y(v);
      const label = money ? formatUsd(v) : formatNumber(v, 2);
      grid.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border)" />
        <text x="${pad.l - 8}" y="${yy + 3}" text-anchor="end" fill="var(--text-mute)" font-size="10" font-family="var(--mono)">${escapeHtml(label)}</text>`);
    }
    const labels = series.map((p, i) => {
      const show = i === 0 || i === series.length - 1 || series.length <= 6;
      if (!show) return "";
      return `<text x="${x(i).toFixed(1)}" y="${h - 10}" text-anchor="middle" fill="var(--text-mute)" font-size="9" font-family="var(--mono)">${escapeHtml(String(p.timeET).slice(5, 16))}</text>`;
    }).join("");
    const dots = series.map((p, i) =>
      `<circle cx="${x(i).toFixed(1)}" cy="${y(p.cumulative).toFixed(1)}" r="3.2" fill="${p.kind === "mark" ? "var(--amber)" : color}" />`
    ).join("");
    return `<div class="chart-wrap" style="position:relative">
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Cumulative paper P&amp;L">
        ${grid.join("")}
        <line x1="${pad.l}" x2="${w - pad.r}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}" stroke="var(--border-strong)" stroke-dasharray="3 3" />
        <polygon points="${area}" fill="${color}" opacity="0.12" />
        <polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />
        ${dots}
        ${labels}
        <text x="${w - pad.r}" y="${Math.max(14, y(last.cumulative) - 8)}" text-anchor="end" fill="${Number(last.cumulative) >= 0 ? "var(--green)" : "var(--red)"}" font-size="11" font-family="var(--mono)">${escapeHtml(money ? formatUsd(last.cumulative) : formatSigned(last.cumulative, 3))}</text>
      </svg>
    </div>`;
  }

  function todayRows(list, kind) {
    if (!list.length) return `<div class="empty">No alerts dated ${escapeHtml(state.data.todayET)} ET.</div>`;
    return `<div class="today-list">${list.map((a) => {
      const pnl = kind === "options" ? a.pnl_usd : a.pnl_per_share;
      const pnlText = kind === "options" ? formatUsd(a.pnl_usd) : (isBlank(a.pnl_per_share) ? "—" : `${formatSigned(a.pnl_per_share, 4)} /sh`);
      return `<div class="alert-row" data-alert-id="${escapeHtml(a.alert_id)}">
        <div class="id">${escapeHtml(a.alert_id)}</div>
        <div>
          <div class="name-row"><span class="sym">${escapeHtml(dash(a.ticker))}</span> <span class="${sideClass(a.side)}">${escapeHtml(dash(a.side))}</span> ${statusChip(a.status)} ${firstHitChip(a.first_hit)}</div>
          <div class="sub">${escapeHtml(etStamp(a.alert_time_et))} · ${escapeHtml(dash(a.rating))} · ${escapeHtml(dash(a.setup_type))}</div>
        </div>
        <div class="right"><div class="mono ${pnlClass(pnl)}">${pnlText}</div></div>
      </div>`;
    }).join("")}</div>`;
  }

  function renderOverview() {
    const d = state.data;
    const oss = d.options.summary;
    const sss = d.stocks.summary;
    workspace().innerHTML = `
      <div class="stack">
        <div>
          <h1 class="page-head">Overview</h1>
          <p class="page-lead">${escapeHtml(d.disclaimer)} Totals use the paper logs as of ${escapeHtml(d.asOfET)}. Win rate counts only closed trades with a P&amp;L.</p>
        </div>
        <div class="overview-grid">
          <section class="panel">
            <div class="panel-head"><h2>Options Signal Scout</h2><span class="panel-updated">${oss.alerts} alerts</span></div>
            ${summaryCards(oss, "options")}
            <div class="panel-note">Equity is cumulative paper P&amp;L in dollars. Closed trades are plotted at their last exit; open and partial trades are marked at the as-of time (amber dots).</div>
            ${renderEquity(oss.equity, { money: true, color: "var(--accent)" })}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Stock Signal Scout</h2><span class="panel-updated">${sss.alerts} alerts</span></div>
            ${summaryCards(sss, "stocks")}
            <div class="panel-note">This log reports dollars per share and R, not an account-dollar total. The curve below is cumulative R on filled paper trades. Amber dots are open or partial marks at the as-of time.</div>
            ${renderEquity(sss.equityR, { money: false, color: "var(--cyan)" })}
            <div class="chart-legend"><span><i class="swatch r"></i> Cumulative R</span></div>
          </section>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Today’s alerts</h2><span class="panel-updated">${escapeHtml(d.todayET)} ET</span></div>
          <div class="panel-note">Options: ${d.today.options.length} · Stocks: ${d.today.stocks.length}</div>
          <div class="overview-grid" style="gap:0">
            <div>
              <div class="panel-head"><h2>Options</h2></div>
              ${todayRows(d.today.options, "options")}
            </div>
            <div>
              <div class="panel-head"><h2>Stocks</h2></div>
              ${todayRows(d.today.stocks, "stocks")}
            </div>
          </div>
        </section>
        <div class="overview-grid">
          <section class="panel">
            <div class="panel-head"><h2>Options by ticker</h2></div>
            ${tickerTable(oss.tickers, "options")}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Stocks by ticker</h2></div>
            ${tickerTable(sss.tickers, "stocks")}
          </section>
        </div>
      </div>`;
    bindAlertClicks();
  }

  function optionsTable(rows, sort) {
    const body = rows.map((a) => `<tr data-alert-id="${escapeHtml(a.alert_id)}" class="${state.selectedId === a.alert_id ? "selected" : ""}">
      <td class="mono">${escapeHtml(etStamp(a.alert_time_et))}</td>
      <td class="mono">${escapeHtml(a.alert_id)}</td>
      <td>${escapeHtml(dash(a.ticker))}</td>
      <td class="${sideClass(a.side)}">${escapeHtml(dash(a.side))}</td>
      <td>${escapeHtml(dash(a.rating))}</td>
      <td>${escapeHtml(dash(a.contract_desc))}</td>
      <td>${statusChip(a.status)}</td>
      <td>${firstHitChip(a.first_hit) || "—"}</td>
      <td class="num ${pnlClass(a.pnl_usd)}">${formatUsd(a.pnl_usd)}</td>
      <td class="num ${pnlClass(a.pnl_pct)}">${formatPct(a.pnl_pct)}</td>
      <td class="num ${pnlClass(a.r_underlying)}">${formatSigned(a.r_underlying, 2, "R")}</td>
      <td>${escapeHtml(dash(a.exit_rule))}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
        ${th("Alert time", "alert_time_et", sort)}
        ${th("ID", "alert_id", sort)}
        ${th("Ticker", "ticker", sort)}
        ${th("Dir", "side", sort)}
        ${th("Rating", "rating", sort)}
        ${th("Contract", "contract_desc", sort)}
        ${th("Status", "status", sort)}
        ${th("First hit", "first_hit", sort)}
        ${th("P&L $", "pnl_usd", sort, "num")}
        ${th("P&L %", "pnl_pct", sort, "num")}
        ${th("R", "r_underlying", sort, "num")}
        ${th("Exit rule", "exit_rule", sort)}
      </tr></thead>
      <tbody>${body || `<tr><td colspan="12" class="empty">No alerts match these filters.</td></tr>`}</tbody>
    </table></div>`;
  }

  function stocksTable(rows, sort) {
    const body = rows.map((a) => `<tr data-alert-id="${escapeHtml(a.alert_id)}" class="${state.selectedId === a.alert_id ? "selected" : ""}">
      <td class="mono">${escapeHtml(etStamp(a.alert_time_et))}</td>
      <td class="mono">${escapeHtml(a.alert_id)}</td>
      <td>${escapeHtml(dash(a.ticker))}</td>
      <td class="${sideClass(a.side)}">${escapeHtml(dash(a.side))}</td>
      <td>${escapeHtml(dash(a.rating))}</td>
      <td>${statusChip(a.status)}</td>
      <td>${firstHitChip(a.first_hit) || "—"}</td>
      <td class="num">${formatNumber(a.entry_px, 2)}</td>
      <td class="num ${pnlClass(a.pnl_per_share)}">${isBlank(a.pnl_per_share) ? "—" : formatSigned(a.pnl_per_share, 4)}</td>
      <td class="num ${pnlClass(a.r_result)}">${isBlank(a.r_result) ? "—" : formatSigned(a.r_result, 3, "R")}</td>
      <td>${escapeHtml(dash(a.exit_rule))}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
        ${th("Alert time", "alert_time_et", sort)}
        ${th("ID", "alert_id", sort)}
        ${th("Ticker", "ticker", sort)}
        ${th("Dir", "side", sort)}
        ${th("Rating", "rating", sort)}
        ${th("Status", "status", sort)}
        ${th("First hit", "first_hit", sort)}
        ${th("Entry", "entry_px", sort, "num")}
        ${th("P&L $/sh", "pnl_per_share", sort, "num")}
        ${th("R", "r_result", sort, "num")}
        ${th("Exit rule", "exit_rule", sort)}
      </tr></thead>
      <tbody>${body || `<tr><td colspan="11" class="empty">No alerts match these filters.</td></tr>`}</tbody>
    </table></div>`;
  }

  function filteredTickerRows(alerts, kind) {
    const groups = new Map();
    alerts.forEach((a) => {
      const t = a.ticker || "—";
      if (!groups.has(t)) groups.set(t, []);
      groups.get(t).push(a);
    });
    const pnlKey = kind === "options" ? "pnl_usd" : "pnl_per_share";
    const rKey = kind === "options" ? "r_underlying" : "r_result";
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ticker, group]) => {
      const closed = group.filter((a) => a.status === "closed");
      const filled = group.filter((a) => a.status === "open" || a.status === "partial" || a.status === "closed");
      const withPnl = closed.filter((a) => typeof a[pnlKey] === "number");
      const winners = withPnl.filter((a) => a[pnlKey] > 0);
      const sum = (list, key) => {
        const vals = list.filter((a) => typeof a[key] === "number").map((a) => a[key]);
        return vals.length ? vals.reduce((x, y) => x + y, 0) : null;
      };
      return {
        ticker,
        alerts: group.length,
        open: group.filter((a) => a.status === "open").length,
        partial: group.filter((a) => a.status === "partial").length,
        closed: closed.length,
        missedEntry: group.filter((a) => a.status === "missed entry").length,
        closedPnl: sum(closed, pnlKey),
        markPnl: sum(filled, pnlKey),
        markR: sum(filled, rKey),
        winRate: withPnl.length ? winners.length / withPnl.length : null,
        winners: winners.length,
        closedWithPnl: withPnl.length,
      };
    });
  }

  function renderBot(kind) {
    const pack = kind === "options" ? state.data.options : state.data.stocks;
    const title = pack.summary.bot;
    const filtered = applyFilters(pack.alerts, state.filters[kind]);
    const sorted = sortAlerts(filtered, state.sort[kind]);
    const table = kind === "options" ? optionsTable(sorted, state.sort[kind]) : stocksTable(sorted, state.sort[kind]);
    const equity = kind === "options"
      ? renderEquity(pack.summary.equity, { money: true, color: "var(--accent)" })
      : renderEquity(pack.summary.equityR, { money: false, color: "var(--cyan)" });
    const equityNote = kind === "options"
      ? "Cumulative paper P&L in dollars. Closed trades plot at the last exit; open and partial marks plot at the as-of time (amber)."
      : "Cumulative R on filled paper trades (dollars-per-share is in the table). Open and partial marks plot at the as-of time (amber).";
    workspace().innerHTML = `
      <div class="stack">
        <div>
          <h1 class="page-head">${escapeHtml(title)}</h1>
          <p class="page-lead">Paper trades only. ${escapeHtml(pack.summary.winRateNote)} Showing ${sorted.length} of ${pack.alerts.length} alerts.</p>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Totals</h2><span class="panel-updated">As of ${escapeHtml(state.data.asOfET)}</span></div>
          ${summaryCards(pack.summary, kind)}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Equity curve</h2></div>
          <div class="panel-note">${equityNote}</div>
          ${equity}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Alerts</h2><span class="panel-updated">${sorted.length} shown</span></div>
          ${renderFilters(kind, pack.alerts)}
          ${table}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>By ticker</h2><span class="panel-updated">Matches current filters</span></div>
          ${tickerTable(filteredTickerRows(filtered, kind), kind)}
        </section>
      </div>`;
    bindFilters(kind);
    bindSort(kind);
    bindAlertClicks();
  }

  function render() {
    parseHash();
    renderNav();
    renderStatus();
    if (!state.data) {
      workspace().innerHTML = `<div class="err">Could not load data/desk.json.</div>`;
      return;
    }
    if (state.tab === "overview") renderOverview();
    else if (state.tab === "options") renderBot("options");
    else renderBot("stocks");
    if (state.selectedId) renderDrawer(state.selectedId);
    else {
      drawer().hidden = true;
      drawer().innerHTML = "";
    }
  }

  function toast(message) {
    const el = document.getElementById("toast");
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 3200);
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !drawer().hidden) closeDrawer();
  });

  window.addEventListener("hashchange", () => render());

  loadData()
    .then(() => render())
    .catch((err) => {
      statusBar().innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
      workspace().innerHTML = `<div class="callout warn">${escapeHtml(err.message)}</div>`;
      toast(err.message);
    });
})();
