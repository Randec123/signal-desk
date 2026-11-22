/* Signal Desk — paper-trade viewer for Options Signal Scout and Stock Signal Scout. */
(() => {
  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "options", label: "Options" },
    { id: "stocks", label: "Stocks" },
    { id: "lowfloat", label: "Low Float" },
  ];

  const CANDLE_UP = "#26c6da";
  const CANDLE_DOWN = "#e8eef5";

  const state = {
    data: null,
    charts: {},
    tab: "overview",
    selectedId: null,
    filters: {
      options: emptyFilters(),
      stocks: emptyFilters(),
      lowfloat: emptyLfFilters(),
    },
    sort: {
      options: { key: "alert_time_et", dir: "desc" },
      stocks: { key: "alert_time_et", dir: "desc" },
      lowfloat: { key: "date_et", dir: "desc" },
    },
    lfMoveTab: "all",
  };

  function emptyFilters() {
    return { ticker: "", status: "", side: "", rating: "", firstHit: "", from: "", to: "" };
  }

  function emptyLfFilters() {
    return { ticker: "", session: "", catalyst: "", from: "", to: "" };
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

  // Missing values: null, undefined, or blank strings are "no value" (Number(null) is 0, which is wrong here).
  function toNum(value) {
    if (value === null || value === undefined) return NaN;
    if (typeof value === "string" && value.trim() === "") return NaN;
    if (typeof value === "boolean") return NaN;
    const n = Number(value);
    return Number.isFinite(n) ? n : NaN;
  }

  // A chart price level: must be a real positive number. Missing, blank, or 0 means "no level".
  function toPrice(value) {
    const n = toNum(value);
    return n > 0 ? n : NaN;
  }

  function formatNumber(value, digits = 2) {
    if (!Number.isFinite(toNum(value))) return "—";
    return toNum(value).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatUsd(value) {
    if (!Number.isFinite(toNum(value))) return "—";
    const n = toNum(value);
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}$${formatNumber(Math.abs(n), 2)}`;
  }

  function formatSigned(value, digits = 2, suffix = "") {
    if (!Number.isFinite(toNum(value))) return "—";
    const n = toNum(value);
    const sign = n < 0 ? "-" : n > 0 ? "+" : "";
    return `${sign}${formatNumber(Math.abs(n), digits)}${suffix}`;
  }

  function formatPct(value) {
    if (!Number.isFinite(toNum(value))) return "—";
    return formatSigned(value, 2, "%");
  }

  function formatWinRate(rate, winners, closed) {
    if (!Number.isFinite(toNum(rate)) || !closed) return "—";
    return `${formatNumber(toNum(rate) * 100, 1)}% (${winners}/${closed})`;
  }

  function pnlClass(value) {
    if (!Number.isFinite(toNum(value))) return "";
    if (toNum(value) > 0) return "up";
    if (toNum(value) < 0) return "down";
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
    const text = String(alert?.alert_time_et || alert?.date_et || "");
    const m = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : "";
  }

  function lfTime(alert) {
    if (alert?.date_et && alert?.time_et) return `${alert.date_et} ${alert.time_et}`;
    return alert?.date_et || "";
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
    if (String(alertId).startsWith("LF-")) return "lowfloat";
    return null;
  }

  function findAlert(alertId) {
    const data = state.data;
    if (!data || !alertId) return null;
    const hit = data.options.alerts.find((a) => a.alert_id === alertId)
      || data.stocks.alerts.find((a) => a.alert_id === alertId)
      || (data.lowfloat?.alerts || []).find((a) => a.alert_id === alertId);
    return hit || null;
  }

  async function loadData() {
    const stamp = Date.now();
    const deskRes = await fetch(`data/desk.json?t=${stamp}`, { cache: "no-store" });
    if (!deskRes.ok) throw new Error(`Could not load desk data (${deskRes.status})`);
    state.data = await deskRes.json();
    try {
      const chartRes = await fetch(`data/charts.json?t=${stamp}`, { cache: "no-store" });
      if (chartRes.ok) {
        const payload = await chartRes.json();
        state.charts = payload.charts || {};
      } else {
        state.charts = {};
      }
    } catch (err) {
      state.charts = {};
    }
  }

  function renderNav() {
    const ossN = state.data?.options?.summary?.alerts ?? 0;
    const sssN = state.data?.stocks?.summary?.alerts ?? 0;
    const lfN = state.data?.lowfloat?.summary?.alerts ?? 0;
    const counts = { overview: ossN + sssN + lfN, options: ossN, stocks: sssN, lowfloat: lfN };
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
      <span class="pill">Low Float ${d.lowfloat?.summary?.alerts ?? 0}</span>
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
      if (filters.session && String(a.session) !== filters.session) return false;
      if (filters.catalyst && String(a.catalyst_tag) !== filters.catalyst) return false;
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
    copy.sort((a, b) => {
      if (sort.key === "date_et" && (a.date_et || a.time_et)) {
        const cmp = compareValues({ t: lfTime(a) }, { t: lfTime(b) }, "t", sort.dir);
        if (cmp) return cmp;
        return compareValues(a, b, "alert_id", sort.dir);
      }
      return compareValues(a, b, sort.key, sort.dir);
    });
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
    if (kind === "lowfloat") {
      return `<div class="filters" data-filters="${kind}">
        ${optionSelect(`${kind}-ticker`, "Ticker", f.ticker, uniqueValues(alerts, "ticker"))}
        ${optionSelect(`${kind}-session`, "Session", f.session, uniqueValues(alerts, "session"))}
        ${optionSelect(`${kind}-catalyst`, "Catalyst", f.catalyst, uniqueValues(alerts, "catalyst_tag"))}
        ${dateInput(`${kind}-from`, "From", f.from)}
        ${dateInput(`${kind}-to`, "To", f.to)}
        <button type="button" class="btn" data-clear-filters="${kind}">Clear</button>
      </div>`;
    }
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
      [`#${kind}-session`, "session"],
      [`#${kind}-catalyst`, "catalyst"],
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
        state.filters[kind] = kind === "lowfloat" ? emptyLfFilters() : emptyFilters();
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
    if (kind === "lowfloat") {
      renderLowFloatDrawer(alert);
      return;
    }
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
      ${kind === "stocks" ? alertChartImage(alert) : ""}
      <div class="section-label">Price</div>
      ${renderPriceChart(alert, kind)}
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
    bindAlertChartImage(root);
  }

  function alertChartSrc(alert) {
    const path = alert && alert.alert_chart;
    if (isBlank(path) || !/^data\/alert-charts\/[A-Za-z0-9_.\-]+\.png$/.test(String(path))) return null;
    return String(path);
  }

  function alertChartImage(alert) {
    const src = alertChartSrc(alert);
    if (!src) return "";
    const label = `${dash(alert.ticker)} ${dash(alert.side)} chart at alert, ${etStamp(alert.alert_time_et)}`;
    return `<div class="section-label">Chart at alert</div>
      <figure class="alert-shot">
        <a class="alert-shot-link" href="${escapeHtml(src)}" target="_blank" rel="noopener" data-alert-shot="${escapeHtml(src)}" aria-label="Open full size: ${escapeHtml(label)}">
          <img src="${escapeHtml(src)}" alt="${escapeHtml(label)}" loading="lazy" decoding="async" width="1400" height="800">
          <span class="alert-shot-zoom" aria-hidden="true">Tap to enlarge</span>
        </a>
        <figcaption>Hourly candles and 8/20/50 EMAs up to the alert time, as sent with the alert. No later price action.</figcaption>
      </figure>`;
  }

  function bindAlertChartImage(root) {
    root.querySelectorAll("[data-alert-shot]").forEach((link) => {
      const img = link.querySelector("img");
      if (img) {
        img.addEventListener("error", () => {
          const fig = link.closest(".alert-shot");
          if (fig) fig.innerHTML = `<div class="chart-empty">Chart image could not be loaded.</div>`;
        });
      }
      link.addEventListener("click", (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
        event.preventDefault();
        openLightbox(link.getAttribute("data-alert-shot"), img ? img.alt : "Chart at alert");
      });
    });
  }

  function lightbox() {
    let el = document.getElementById("lightbox");
    if (!el) {
      el = document.createElement("div");
      el.id = "lightbox";
      el.className = "lightbox";
      el.hidden = true;
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-modal", "true");
      document.body.appendChild(el);
      el.addEventListener("click", (event) => {
        if (event.target.closest("a.lightbox-open")) return;
        closeLightbox();
      });
    }
    return el;
  }

  function openLightbox(src, alt) {
    const el = lightbox();
    el.setAttribute("aria-label", alt || "Chart at alert");
    el.innerHTML = `<button type="button" class="lightbox-close" aria-label="Close">×</button>
      <div class="lightbox-scroll"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}"></div>
      <a class="lightbox-open" href="${escapeHtml(src)}" target="_blank" rel="noopener">Open image in new tab</a>`;
    el.hidden = false;
    document.body.classList.add("lightbox-on");
  }

  function closeLightbox() {
    const el = document.getElementById("lightbox");
    if (!el || el.hidden) return false;
    el.hidden = true;
    el.innerHTML = "";
    document.body.classList.remove("lightbox-on");
    return true;
  }

  function bindDrawerClose(root) {
    const btn = $("[data-close-drawer]", root);
    if (btn) btn.addEventListener("click", closeDrawer);
    root.addEventListener("click", (event) => {
      if (event.target === root) closeDrawer();
    });
  }

  function renderLowFloatDrawer(alert) {
    const root = drawer();
    const title = `${alert.alert_id} · ${dash(alert.ticker)}`;
    const href = alert.news_url
      ? `<a href="${escapeHtml(alert.news_url)}" target="_blank" rel="noopener noreferrer">Source</a>`
      : "—";
    root.hidden = false;
    root.innerHTML = `<div class="drawer-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
      <div class="drawer-top">
        <div>
          <h2>${escapeHtml(title)}</h2>
          <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">
            <span class="chip">${escapeHtml(dash(alert.session))}</span>
            ${moveDayChip(alert)}
            <span class="chip">${escapeHtml(dash(alert.catalyst_tag))}</span>
            <span class="pill">NEWS ALERT</span>
          </div>
        </div>
        <button type="button" class="drawer-close" data-close-drawer aria-label="Close">×</button>
      </div>
      <div class="section-label">Headline</div>
      <p style="margin:0 0 8px;font-size:13px;color:var(--text)">${escapeHtml(dash(alert.news_headline))}</p>
      <p style="margin:0 0 12px;font-size:12px">${href}</p>
      <div class="section-label">Price since alert</div>
      ${renderPriceChart(alert, "lowfloat")}
      <div class="section-label">Details</div>
      <dl class="kv">
        ${kv("Alert time", etStamp(lfTime(alert)))}
        ${kv("Session", alert.session)}
        ${kv("Price at alert", formatNumber(alert.price_at_alert, 2))}
        ${kv("Float (M)", isBlank(alert.float_m) ? "—" : formatNumber(alert.float_m, 2))}
        ${kv("Rel. volume", isBlank(alert.rel_vol) ? "—" : `${formatNumber(alert.rel_vol, 0)}x`)}
        ${kv("Catalyst", alert.catalyst_tag)}
        ${kv("Move day", `${moveDayChip(alert)}${alert.move_day_basis ? ` <span class="dim">${escapeHtml(alert.move_day_basis)}</span>` : ""}`)}
        ${kv("Next session close", alert.nextSessionClose != null ? `${formatNumber(alert.nextSessionClose, 2)}${alert.nextSessionCloseDate ? ` (${alert.nextSessionCloseDate})` : ""}` : "—")}
        ${kv("Chg to next close", `<span class="${pnlClass(alert.chgToNextClosePct)}">${formatPct(alert.chgToNextClosePct)}</span>`)}
        ${kv("High since alert", alert.highSinceAlert != null ? `${formatNumber(alert.highSinceAlert, 2)}${alert.highSinceAlertTime ? ` at ${alert.highSinceAlertTime}` : ""}` : "—")}
        ${kv("High since alert %", `<span class="${pnlClass(alert.highSinceAlertPct)}">${formatPct(alert.highSinceAlertPct)}</span>`)}
        ${kv("Last", formatNumber(alert.lastPrice, 2))}
        ${kv("Chg to last", `<span class="${pnlClass(alert.chgToLastPct)}">${formatPct(alert.chgToLastPct)}</span>`)}
      </dl>
      <p class="panel-note" style="border:0;padding:8px 0 0">Low Float News Scout alerts are news scans, not paper trades. Performance is computed from Yahoo Finance bars stored when this page was built.</p>
    </div>`;
    bindDrawerClose(root);
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
    ].filter((r) => Number.isFinite(toPrice(r.px)));
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
    ].filter((r) => Number.isFinite(toPrice(r.px)));
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
    const { money = false, color = CANDLE_UP, height = 220 } = opts;
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
        <text x="${w - pad.r}" y="${Math.max(14, y(last.cumulative) - 8)}" text-anchor="end" fill="${Number(last.cumulative) >= 0 ? CANDLE_UP : CANDLE_DOWN}" font-size="11" font-family="var(--mono)">${escapeHtml(money ? formatUsd(last.cumulative) : formatSigned(last.cumulative, 3))}</text>
      </svg>
    </div>`;
  }


  function parseChartTime(value) {
    if (isBlank(value)) return null;
    const text = String(value).trim();
    const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!m) return null;
    return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  }

  function tickerCharts(ticker) {
    if (!ticker) return null;
    return state.charts[String(ticker).toUpperCase()] || null;
  }

  function sliceBars(bars, start, end) {
    if (!bars || !bars.length) return [];
    return bars.filter((bar) => {
      const dt = parseChartTime(bar.t);
      if (!dt) return false;
      if (start && dt < start) return false;
      if (end && dt > end) return false;
      return true;
    });
  }

  function downsampleBars(bars, maxBars) {
    if (!bars || bars.length <= maxBars) return bars || [];
    const out = [];
    const step = bars.length / maxBars;
    for (let i = 0; i < maxBars; i++) {
      const from = Math.floor(i * step);
      const to = Math.max(from + 1, Math.floor((i + 1) * step));
      const group = bars.slice(from, to);
      if (!group.length) continue;
      const first = group[0];
      const last = group[group.length - 1];
      let h = -Infinity;
      let l = Infinity;
      let v = 0;
      group.forEach((b) => {
        if (Number.isFinite(b.h)) h = Math.max(h, b.h);
        if (Number.isFinite(b.l)) l = Math.min(l, b.l);
        if (Number.isFinite(b.v)) v += b.v;
      });
      out.push({
        t: last.t,
        o: first.o,
        h: Number.isFinite(h) ? h : last.h,
        l: Number.isFinite(l) ? l : last.l,
        c: last.c,
        v,
      });
    }
    return out;
  }

  function barsForAlert(alert, kind) {
    const pack = tickerCharts(alert.ticker);
    if (!pack) return { bars: [], interval: null };
    const startRaw = kind === "lowfloat" ? lfTime(alert) : alert.alert_time_et;
    const start = parseChartTime(startRaw);
    const padMs = 36 * 60 * 60 * 1000;
    const from = start ? new Date(start.getTime() - padMs) : null;
    let end = null;
    const lastExit = [alert.exit3_time, alert.exit2_time, alert.exit1_time].find((v) => !isBlank(v));
    if (lastExit) {
      const exitDt = parseChartTime(lastExit);
      if (exitDt) end = new Date(exitDt.getTime() + padMs);
    }
    const intra = sliceBars(pack.intraday || [], from, end);
    if (intra.length >= 8) return { bars: downsampleBars(intra, 180), interval: "15m" };
    const daily = sliceBars(pack.daily || [], from ? new Date(from.getTime() - 2 * 86400000) : null, end);
    if (daily.length) return { bars: daily, interval: "1d" };
    if ((pack.daily || []).length) return { bars: pack.daily, interval: "1d" };
    return { bars: pack.intraday || [], interval: pack.intraday?.length ? "15m" : null };
  }

  function renderSparkline(bars, w = 132, h = 36) {
    const pts = (bars || []).filter((b) => Number.isFinite(toPrice(b.c)));
    if (pts.length < 2) return `<div class="spark empty">No chart</div>`;
    const ys = pts.map((b) => Number(b.c));
    let min = Math.min(...ys);
    let max = Math.max(...ys);
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
    const y = (v) => 2 + (1 - (v - min) / (max - min)) * (h - 4);
    const d = pts.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(Number(b.c)).toFixed(1)}`).join(" ");
    const up = ys[ys.length - 1] >= ys[0];
    const color = up ? CANDLE_UP : CANDLE_DOWN;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" /></svg>`;
  }

  function renderWinLoss(summary, opts = {}) {
    const winners = Number(summary?.winners || 0);
    const losers = Number(summary?.losers != null ? summary.losers : Math.max(0, (summary?.closedWithPnl || 0) - winners));
    const closed = winners + losers;
    const open = Number(summary?.open || 0);
    const partial = Number(summary?.partial || 0);
    const missed = Number(summary?.missedEntry || 0);
    const title = opts.title || "Win / loss";
    const note = opts.note || "Closed paper trades only. A win is P&amp;L greater than zero.";
    if (!closed && !open && !partial && !missed) {
      return `<div class="chart-empty">No trades to break down yet.</div>`;
    }
    const winPct = closed ? (winners / closed) * 100 : 0;
    const lossPct = closed ? (losers / closed) * 100 : 0;
    const parts = [];
    if (closed) {
      parts.push(`<div class="wl-bar"><div class="wl-win" style="width:${winPct}%"></div><div class="wl-loss" style="width:${lossPct}%"></div></div>`);
    } else {
      parts.push(`<div class="wl-bar muted"></div>`);
    }
    return `<div class="winloss">
      <div class="wl-head"><strong>${escapeHtml(title)}</strong><span>${closed ? `${formatWinRate(closed ? winners / closed : null, winners, closed)}` : "—"}</span></div>
      ${parts.join("")}
      <div class="chart-legend">
        <span><i class="swatch candle-up"></i> Wins ${winners}</span>
        <span><i class="swatch candle-down"></i> Losses ${losers}</span>
        ${open || partial || missed ? `<span class="dim">Open ${open} · Partial ${partial} · Missed ${missed}</span>` : ""}
      </div>
      <div class="panel-note" style="border:0;padding:6px 0 0">${note}</div>
    </div>`;
  }

  function renderPriceChart(alert, kind) {
    const { bars, interval } = barsForAlert(alert, kind);
    if (!bars.length) {
      return `<div class="chart-empty">Price history was not available when this page was built.</div>`;
    }
    const w = 640;
    const h = 250;
    const pad = { l: 50, r: 62, t: 16, b: 28 };
    const xs = bars.map((_, i) => i);
    const highs = bars.map((b) => toPrice(b.h ?? b.c)).filter(Number.isFinite);
    const lows = bars.map((b) => toPrice(b.l ?? b.c)).filter(Number.isFinite);
    const levels = priceLevels(alert, kind);
    const levelVals = levels.map((lv) => lv.px).filter(Number.isFinite);
    let min = Math.min(...lows, ...levelVals);
    let max = Math.max(...highs, ...levelVals);
    if (!Number.isFinite(min) || !Number.isFinite(max)) return `<div class="chart-empty">Price history was not available when this page was built.</div>`;
    if (min === max) {
      min -= 1;
      max += 1;
    }
    const padAmt = (max - min) * 0.08;
    min -= padAmt;
    max += padAmt;
    const innerW = w - pad.l - pad.r;
    const innerH = h - pad.t - pad.b;
    const slot = innerW / Math.max(bars.length, 1);
    const x = (i) => pad.l + (i + 0.5) * slot;
    const y = (v) => pad.t + (1 - (v - min) / (max - min)) * innerH;
    const bodyW = Math.max(1.2, Math.min(7, slot * 0.7));
    const candles = bars.map((b, i) => {
      const o = toPrice(b.o ?? b.c);
      const c = toPrice(b.c ?? b.o);
      const hi = toPrice(b.h ?? Math.max(o, c));
      const lo = toPrice(b.l ?? Math.min(o, c));
      if (![o, c, hi, lo].every(Number.isFinite)) return "";
      const up = c >= o;
      const color = up ? CANDLE_UP : CANDLE_DOWN;
      const top = y(Math.max(o, c));
      const bot = y(Math.min(o, c));
      const bodyH = Math.max(1, bot - top);
      const cx = x(i);
      return `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${y(hi).toFixed(1)}" y2="${y(lo).toFixed(1)}" stroke="${color}" stroke-width="1" />
        <rect x="${(cx - bodyW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bodyW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${color}" />`;
    }).join("");
    const ticks = 4;
    const grid = [];
    for (let i = 0; i <= ticks; i++) {
      const v = min + ((max - min) * i) / ticks;
      const yy = y(v);
      grid.push(`<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="var(--border)" />
        <text x="${pad.l - 6}" y="${yy + 3}" text-anchor="end" fill="var(--text-mute)" font-size="10" font-family="var(--mono)">${escapeHtml(formatNumber(v, 2))}</text>`);
    }
    const levelLines = levels.map((lv) => {
      const yy = y(lv.px);
      const dash = lv.dash ? `stroke-dasharray="${lv.dash}"` : "";
      return `<line x1="${pad.l}" x2="${w - pad.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${lv.color}" stroke-width="1.1" ${dash} />
        <text x="${w - pad.r + 4}" y="${yy + 3}" fill="${lv.color}" font-size="9" font-family="var(--mono)">${escapeHtml(lv.name)} ${formatNumber(lv.px, 2)}</text>`;
    }).join("");
    const alertRaw = kind === "lowfloat" ? lfTime(alert) : alert.alert_time_et;
    const alertDt = parseChartTime(alertRaw);
    let alertMark = "";
    if (alertDt) {
      let idx = 0;
      let best = Infinity;
      bars.forEach((b, i) => {
        const dt = parseChartTime(b.t);
        if (!dt) return;
        const diff = Math.abs(dt - alertDt);
        if (diff < best) {
          best = diff;
          idx = i;
        }
      });
      const cx = x(idx);
      alertMark = `<line x1="${cx.toFixed(1)}" x2="${cx.toFixed(1)}" y1="${pad.t}" y2="${h - pad.b}" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 3" />
        <text x="${cx.toFixed(1)}" y="${pad.t + 10}" text-anchor="middle" fill="var(--accent)" font-size="9">Alert</text>`;
    }
    const firstT = String(bars[0].t || "").slice(5, 16);
    const lastT = String(bars[bars.length - 1].t || "").slice(5, 16);
    const lastC = bars[bars.length - 1].c;
    return `<div class="chart-wrap price-chart">
      <svg class="chart-svg" viewBox="0 0 ${w} ${h}" role="img" aria-label="Price chart">
        ${grid.join("")}
        ${alertMark}
        ${levelLines}
        ${candles}
        <text x="${pad.l}" y="${h - 8}" fill="var(--text-mute)" font-size="9" font-family="var(--mono)">${escapeHtml(firstT)}</text>
        <text x="${w - pad.r}" y="${h - 8}" text-anchor="end" fill="var(--text-mute)" font-size="9" font-family="var(--mono)">${escapeHtml(lastT)}</text>
        ${Number.isFinite(toPrice(lastC)) ? `<text x="${w - pad.r}" y="${Math.max(14, y(toPrice(lastC)) - 8)}" text-anchor="end" fill="${toPrice(lastC) >= toNum(bars[0].c) ? CANDLE_UP : CANDLE_DOWN}" font-size="11" font-family="var(--mono)">${escapeHtml(formatNumber(lastC, 2))}</text>` : ""}
      </svg>
      <div class="chart-legend">
        <span><i class="swatch candle-up"></i> Up</span>
        <span><i class="swatch candle-down"></i> Down</span>
        <span class="dim">${interval === "15m" ? "15-minute bars (includes pre/post when available)" : "Daily bars"} from Yahoo Finance, stored at build time</span>
      </div>
    </div>`;
  }

  function priceLevels(alert, kind) {
    if (kind === "lowfloat") {
      const rows = [{ name: "Alert", px: toPrice(alert.price_at_alert), color: "var(--amber)", dash: "4 3" }];
      if (Number.isFinite(toPrice(alert.nextSessionClose))) {
        rows.push({ name: "Next close", px: toPrice(alert.nextSessionClose), color: CANDLE_UP });
      }
      if (Number.isFinite(toPrice(alert.highSinceAlert))) {
        rows.push({ name: "High since", px: toPrice(alert.highSinceAlert), color: "var(--accent)" });
      }
      if (Number.isFinite(toPrice(alert.lastPrice))) {
        rows.push({ name: "Last", px: toPrice(alert.lastPrice), color: CANDLE_DOWN, dash: "2 2" });
      }
      return rows.filter((r) => Number.isFinite(r.px));
    }
    if (kind === "options") {
      return [
        { name: "Stop", px: toPrice(alert.stop_level), color: CANDLE_DOWN, dash: "4 3" },
        { name: "Zone lo", px: toPrice(alert.entry_zone_lo), color: "var(--amber)", dash: "2 2" },
        { name: "Zone hi", px: toPrice(alert.entry_zone_hi), color: "var(--amber)", dash: "2 2" },
        { name: "Alert", px: toPrice(alert.underlying_at_alert), color: "var(--accent)" },
        { name: "TP1", px: toPrice(alert.tp1), color: CANDLE_UP },
        { name: "TP2", px: toPrice(alert.tp2), color: CANDLE_UP, dash: "4 2" },
        { name: "TP3", px: toPrice(alert.tp3), color: CANDLE_UP, dash: "1 3" },
      ].filter((r) => Number.isFinite(r.px));
    }
    const rows = [
      { name: "Stop", px: toPrice(alert.stop), color: CANDLE_DOWN, dash: "4 3" },
      { name: "Zone lo", px: toPrice(alert.entry_zone_lo), color: "var(--amber)", dash: "2 2" },
      { name: "Zone hi", px: toPrice(alert.entry_zone_hi), color: "var(--amber)", dash: "2 2" },
      { name: "Alert", px: toPrice(alert.price_at_alert), color: "var(--accent)" },
      { name: "Entry", px: toPrice(alert.entry_px), color: "var(--amber)" },
      { name: "TP1", px: toPrice(alert.tp1), color: CANDLE_UP },
      { name: "TP2", px: toPrice(alert.tp2), color: CANDLE_UP, dash: "4 2" },
      { name: "TP3", px: toPrice(alert.tp3), color: CANDLE_UP, dash: "1 3" },
    ];
    if (Number.isFinite(toPrice(alert.exit1_px))) rows.push({ name: "Exit 1", px: toPrice(alert.exit1_px), color: CANDLE_DOWN, dash: "2 2" });
    if (Number.isFinite(toPrice(alert.exit2_px))) rows.push({ name: "Exit 2", px: toPrice(alert.exit2_px), color: CANDLE_DOWN, dash: "2 2" });
    return rows.filter((r) => Number.isFinite(r.px));
  }

  function todayRows(list, kind) {
    if (!list.length) return `<div class="empty">No alerts dated ${escapeHtml(state.data.todayET)} ET.</div>`;
    if (kind === "lowfloat") {
      return `<div class="today-list">${list.map((a) => {
        const pack = tickerCharts(a.ticker);
        const sparkBars = (pack?.intraday && pack.intraday.length ? pack.intraday : pack?.daily) || [];
        return `<div class="alert-row" data-alert-id="${escapeHtml(a.alert_id)}">
          <div class="id">${escapeHtml(a.alert_id)}</div>
          <div>
            <div class="name-row"><span class="sym">${escapeHtml(dash(a.ticker))}</span> <span class="chip">${escapeHtml(dash(a.session))}</span> ${moveDayChip(a)}</div>
            <div class="sub">${escapeHtml(etStamp(lfTime(a)))} · ${escapeHtml(dash(a.catalyst_tag))}</div>
          </div>
          <div class="right">
            ${renderSparkline(sparkBars)}
            <div class="mono ${pnlClass(a.highSinceAlertPct)}">${formatPct(a.highSinceAlertPct)}</div>
          </div>
        </div>`;
      }).join("")}</div>`;
    }
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
            <div class="panel-head"><h2>Options by ticker</h2></div>
            ${tickerTable(oss.tickers, "options")}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Stocks by ticker</h2></div>
            ${tickerTable(sss.tickers, "stocks")}
          </section>
        </div>
        <div class="overview-grid">
          <section class="panel">
            <div class="panel-head"><h2>Options Signal Scout</h2><span class="panel-updated">${oss.alerts} alerts</span></div>
            ${summaryCards(oss, "options")}
            <div class="panel-note">Equity is cumulative paper P&amp;L in dollars. Closed trades are plotted at their last exit; open and partial trades are marked at the as-of time (amber dots). Chart up is teal, down is white.</div>
            ${renderEquity(oss.equity, { money: true, color: CANDLE_UP })}
            ${renderWinLoss(oss)}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Stock Signal Scout</h2><span class="panel-updated">${sss.alerts} alerts</span></div>
            ${summaryCards(sss, "stocks")}
            <div class="panel-note">This log reports dollars per share and R, not an account-dollar total. The curve below is cumulative R on filled paper trades. Amber dots are open or partial marks at the as-of time.</div>
            ${renderEquity(sss.equityR, { money: false, color: CANDLE_UP })}
            <div class="chart-legend"><span><i class="swatch candle-up"></i> Cumulative R</span></div>
            ${renderWinLoss(sss)}
          </section>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Today’s alerts</h2><span class="panel-updated">${escapeHtml(d.todayET)} ET</span></div>
          <div class="panel-note">Options: ${d.today.options.length} · Stocks: ${d.today.stocks.length} · Low Float: ${(d.today.lowfloat || []).length}</div>
          <div class="overview-grid today-grid">
            <div>
              <div class="panel-head"><h2>Options</h2></div>
              ${todayRows(d.today.options, "options")}
            </div>
            <div>
              <div class="panel-head"><h2>Stocks</h2></div>
              ${todayRows(d.today.stocks, "stocks")}
            </div>
            <div>
              <div class="panel-head"><h2>Low Float</h2></div>
              ${todayRows(d.today.lowfloat || [], "lowfloat")}
            </div>
          </div>
        </section>
      </div>`;
    bindAlertClicks();
  }

  function optionsTable(rows, sort) {
    const body = rows.map((a) => `<tr data-alert-id="${escapeHtml(a.alert_id)}" class="${state.selectedId === a.alert_id ? "selected" : ""}">
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
      <td class="mono">${escapeHtml(etStamp(a.alert_time_et))}</td>
      <td class="mono">${escapeHtml(a.alert_id)}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
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
        ${th("Alert time", "alert_time_et", sort)}
        ${th("ID", "alert_id", sort)}
      </tr></thead>
      <tbody>${body || `<tr><td colspan="12" class="empty">No alerts match these filters.</td></tr>`}</tbody>
    </table></div>`;
  }

  function stocksTable(rows, sort) {
    const body = rows.map((a) => `<tr data-alert-id="${escapeHtml(a.alert_id)}" class="${state.selectedId === a.alert_id ? "selected" : ""}">
      <td>${escapeHtml(dash(a.ticker))}</td>
      <td class="${sideClass(a.side)}">${escapeHtml(dash(a.side))}</td>
      <td>${escapeHtml(dash(a.rating))}</td>
      <td>${statusChip(a.status)}</td>
      <td>${firstHitChip(a.first_hit) || "—"}</td>
      <td class="num">${formatNumber(a.entry_px, 2)}</td>
      <td class="num ${pnlClass(a.pnl_per_share)}">${isBlank(a.pnl_per_share) ? "—" : formatSigned(a.pnl_per_share, 4)}</td>
      <td class="num ${pnlClass(a.r_result)}">${isBlank(a.r_result) ? "—" : formatSigned(a.r_result, 3, "R")}</td>
      <td>${escapeHtml(dash(a.exit_rule))}</td>
      <td class="mono">${escapeHtml(etStamp(a.alert_time_et))}</td>
      <td class="mono">${escapeHtml(a.alert_id)}</td>
    </tr>`).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
        ${th("Ticker", "ticker", sort)}
        ${th("Dir", "side", sort)}
        ${th("Rating", "rating", sort)}
        ${th("Status", "status", sort)}
        ${th("First hit", "first_hit", sort)}
        ${th("Entry", "entry_px", sort, "num")}
        ${th("P&L $/sh", "pnl_per_share", sort, "num")}
        ${th("R", "r_result", sort, "num")}
        ${th("Exit rule", "exit_rule", sort)}
        ${th("Alert time", "alert_time_et", sort)}
        ${th("ID", "alert_id", sort)}
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
      ? renderEquity(pack.summary.equity, { money: true, color: CANDLE_UP })
      : renderEquity(pack.summary.equityR, { money: false, color: CANDLE_UP });
    const perShare = kind === "stocks"
      ? renderEquity(pack.summary.equity, { money: true, color: CANDLE_UP, height: 180 })
      : "";
    const equityNote = kind === "options"
      ? "Cumulative paper P&L in dollars. Closed trades plot at the last exit; open and partial marks plot at the as-of time (amber). Up is teal, down is white."
      : "Cumulative R on filled paper trades. The second curve is cumulative dollars per share (the log has no share count). Open and partial marks plot at the as-of time (amber).";
    workspace().innerHTML = `
      <div class="stack">
        <div>
          <h1 class="page-head">${escapeHtml(title)}</h1>
          <p class="page-lead">Paper trades only. ${escapeHtml(pack.summary.winRateNote)} Showing ${sorted.length} of ${pack.alerts.length} alerts. Open an alert to see its price chart with entry, stop, and targets.</p>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>By ticker</h2><span class="panel-updated">Matches current filters</span></div>
          ${tickerTable(filteredTickerRows(filtered, kind), kind)}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Totals</h2><span class="panel-updated">As of ${escapeHtml(state.data.asOfET)}</span></div>
          ${summaryCards(pack.summary, kind)}
        </section>
        <div class="overview-grid">
          <section class="panel">
            <div class="panel-head"><h2>Equity curve</h2></div>
            <div class="panel-note">${equityNote}</div>
            ${equity}
            ${kind === "stocks" ? `<div class="panel-note">Cumulative dollars per share</div>${perShare}` : ""}
          </section>
          <section class="panel">
            <div class="panel-head"><h2>Win / loss</h2></div>
            ${renderWinLoss(pack.summary)}
          </section>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Alerts</h2><span class="panel-updated">${sorted.length} shown</span></div>
          ${renderFilters(kind, pack.alerts)}
          ${table}
        </section>
      </div>`;
    bindFilters(kind);
    bindSort(kind);
    bindAlertClicks();
  }


  function moveDayChipClass(label) {
    if (label === "Day 1") return "move-day1";
    if (label === "Day 2" || label === "Day 3") return "move-day23";
    if (label === "Day 4+") return "move-day4";
    return "move-unknown";
  }

  function moveDayChip(alert) {
    const label = alert.move_day || "Unknown";
    const basis = alert.move_day_basis || "";
    const title = basis ? ` title="${escapeHtml(basis)}"` : "";
    return `<span class="chip ${moveDayChipClass(label)}"${title}>${escapeHtml(label)}</span>`;
  }

  function alertsForMoveTab(alerts, tab) {
    if (tab === "day1") return alerts.filter((a) => a.move_day === "Day 1");
    if (tab === "day23") return alerts.filter((a) => a.move_day === "Day 2" || a.move_day === "Day 3");
    if (tab === "day4") return alerts.filter((a) => a.move_day === "Day 4+");
    if (tab === "unknown") return alerts.filter((a) => a.move_day === "Unknown" || !a.move_day);
    return alerts;
  }

  function moveTabStats(alerts) {
    const nexts = alerts.filter((a) => typeof a.chgToNextClosePct === "number");
    const highs = alerts.filter((a) => typeof a.highSinceAlertPct === "number");
    const avg = (rows, key) => (rows.length ? rows.reduce((sum, a) => sum + a[key], 0) / rows.length : null);
    return {
      count: alerts.length,
      avgNext: avg(nexts, "chgToNextClosePct"),
      avgHigh: avg(highs, "highSinceAlertPct"),
    };
  }

  function renderMoveTabs(alerts) {
    const counts = {
      all: alerts.length,
      day1: alerts.filter((a) => a.move_day === "Day 1").length,
      day23: alerts.filter((a) => a.move_day === "Day 2" || a.move_day === "Day 3").length,
      day4: alerts.filter((a) => a.move_day === "Day 4+").length,
      unknown: alerts.filter((a) => a.move_day === "Unknown" || !a.move_day).length,
    };
    const tabs = [
      { id: "all", label: "All" },
      { id: "day1", label: "Day 1" },
      { id: "day23", label: "Day 2-3 continuation" },
    ];
    if (counts.day4) tabs.push({ id: "day4", label: "Day 4+" });
    if (counts.unknown) tabs.push({ id: "unknown", label: "Unknown" });
    if (!tabs.some((t) => t.id === state.lfMoveTab)) state.lfMoveTab = "all";

    const buttons = tabs.map((t) => {
      const active = state.lfMoveTab === t.id ? " active" : "";
      return `<button type="button" class="move-tab${active}" data-move-tab="${t.id}" role="tab" aria-selected="${state.lfMoveTab === t.id ? "true" : "false"}">${escapeHtml(t.label)} <span class="count">${counts[t.id]}</span></button>`;
    }).join("");

    const stats = tabs.map((t) => {
      const s = moveTabStats(alertsForMoveTab(alerts, t.id));
      const active = state.lfMoveTab === t.id ? " active" : "";
      return `<button type="button" class="move-stat${active}" data-move-tab="${t.id}">
        <div class="k">${escapeHtml(t.label)}</div>
        <div class="v">${s.count} alert${s.count === 1 ? "" : "s"}</div>
        <div class="d">Avg next close <span class="${pnlClass(s.avgNext)}">${formatPct(s.avgNext)}</span><br>Avg high since <span class="${pnlClass(s.avgHigh)}">${formatPct(s.avgHigh)}</span></div>
      </button>`;
    }).join("");

    const note = state.data?.lowfloat?.summary?.moveDayNote
      || "Day 1 is the first session of a move: the prior regular session was not up 20% or more and did not trade at least 5x its 20-day average volume, and there was no earlier low-float alert on that ticker in the prior 2 trading days. Day 2 and Day 3 are continuations. Premarket alerts belong to the coming session; after-hours alerts belong to the session that just closed.";

    return `<div class="move-tabs" role="tablist" aria-label="Move day">${buttons}</div>
      <div class="move-stats">${stats}</div>
      <p class="panel-note move-note">${escapeHtml(note)}</p>`;
  }

  function bindMoveTabs() {
    workspace().querySelectorAll("[data-move-tab]").forEach((el) => {
      el.addEventListener("click", () => {
        const tab = el.getAttribute("data-move-tab");
        if (!tab || tab === state.lfMoveTab) return;
        state.lfMoveTab = tab;
        render();
      });
    });
  }

  function lowfloatTable(rows, sort) {
    const body = rows.map((a) => {
      const pack = tickerCharts(a.ticker);
      const sparkBars = (pack?.intraday && pack.intraday.length ? pack.intraday : pack?.daily) || [];
      const href = a.news_url
        ? `<a href="${escapeHtml(a.news_url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">Link</a>`
        : "—";
      const news = a.news_headline
        ? (a.news_url
          ? `<a href="${escapeHtml(a.news_url)}" target="_blank" rel="noopener noreferrer" onclick="event.stopPropagation()">${escapeHtml(a.news_headline)}</a>`
          : escapeHtml(a.news_headline))
        : href;
      return `<tr data-alert-id="${escapeHtml(a.alert_id)}" class="${state.selectedId === a.alert_id ? "selected" : ""}">
        <td>${escapeHtml(dash(a.ticker))}</td>
        <td class="news-cell">${news}</td>
        <td>${moveDayChip(a)}</td>
        <td>${escapeHtml(dash(a.session))}</td>
        <td class="num">${formatNumber(a.price_at_alert, 2)}</td>
        <td class="num">${isBlank(a.float_m) ? "—" : formatNumber(a.float_m, 2)}</td>
        <td class="num">${isBlank(a.rel_vol) ? "—" : formatNumber(a.rel_vol, 0)}</td>
        <td>${escapeHtml(dash(a.catalyst_tag))}</td>
        <td class="chart-cell">${renderSparkline(sparkBars)}</td>
        <td class="num ${pnlClass(a.chgToNextClosePct)}">${formatPct(a.chgToNextClosePct)}</td>
        <td class="num ${pnlClass(a.highSinceAlertPct)}">${formatPct(a.highSinceAlertPct)}</td>
        <td class="num ${pnlClass(a.chgToLastPct)}">${formatPct(a.chgToLastPct)}</td>
        <td class="mono">${escapeHtml(etStamp(lfTime(a)))}</td>
        <td class="mono">${escapeHtml(a.alert_id)}</td>
      </tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="data">
      <thead><tr>
        ${th("Ticker", "ticker", sort)}
        ${th("News", "news_headline", sort)}
        ${th("Move day", "move_day", sort)}
        ${th("Session", "session", sort)}
        ${th("Alert px", "price_at_alert", sort, "num")}
        ${th("Float M", "float_m", sort, "num")}
        ${th("RVOL", "rel_vol", sort, "num")}
        ${th("Catalyst", "catalyst_tag", sort)}
        <th>Chart</th>
        ${th("Next close %", "chgToNextClosePct", sort, "num")}
        ${th("High since %", "highSinceAlertPct", sort, "num")}
        ${th("Last %", "chgToLastPct", sort, "num")}
        ${th("Alert time", "date_et", sort)}
        ${th("ID", "alert_id", sort)}
      </tr></thead>
      <tbody>${body || `<tr><td colspan="15" class="empty">No alerts match these filters.</td></tr>`}</tbody>
    </table></div>`;
  }

  function renderLowFloat() {
    const pack = state.data.lowfloat || { alerts: [], summary: { alerts: 0, emptyNote: "Alerts will appear after the next Low Float News Scout scan." } };
    const alerts = pack.alerts || [];
    if (!alerts.length) {
      workspace().innerHTML = `
        <div class="stack">
          <div>
            <h1 class="page-head">Low Float News Scout</h1>
            <p class="page-lead">News alerts on stocks with a float under about 20 million shares, priced $1 to $25, with breaking news and relative volume of at least 5x. These are not paper trades.</p>
          </div>
          <section class="panel">
            <div class="empty-state">
              <h2>No low-float alerts yet</h2>
              <p>${escapeHtml(pack.summary.emptyNote || "Alerts will appear after the next Low Float News Scout scan.")}</p>
            </div>
          </section>
        </div>`;
      return;
    }
    const moveFiltered = alertsForMoveTab(alerts, state.lfMoveTab);
    const filtered = applyFilters(moveFiltered, state.filters.lowfloat);
    const sorted = sortAlerts(filtered, state.sort.lowfloat);
    const sum = pack.summary;
    workspace().innerHTML = `
      <div class="stack">
        <div>
          <h1 class="page-head">Low Float News Scout</h1>
          <p class="page-lead">News alerts, not paper trades. Next-session close is the regular-session close after a premarket alert, or the next trading day after an after-hours alert. High-since and last prices come from Yahoo Finance bars stored when this page was built. Showing ${sorted.length} of ${alerts.length} alerts.</p>
        </div>
        <div class="score-grid">
          <div class="score-card"><div class="k">Alerts</div><div class="v">${sum.alerts}</div><div class="d">${sum.tickers} tickers · Premarket ${sum.bySession?.premarket || 0} · After hours ${sum.bySession?.afterhours || 0}</div></div>
          <div class="score-card"><div class="k">Next-close win rate</div><div class="v">${escapeHtml(formatWinRate(sum.nextCloseWinRate, sum.nextCloseWinners, sum.withNextClose))}</div><div class="d">Share of alerts whose next regular-session close was above the alert price.</div></div>
          <div class="score-card"><div class="k">Avg next-close chg</div><div class="v ${pnlClass(sum.avgChgToNextClosePct)}">${formatPct(sum.avgChgToNextClosePct)}</div><div class="d">Average percent change from the alert price to the next session close.</div></div>
          <div class="score-card"><div class="k">Avg high since alert</div><div class="v ${pnlClass(sum.avgHighSinceAlertPct)}">${formatPct(sum.avgHighSinceAlertPct)}</div><div class="d">Average of each alert's high after the alert time, versus the alert price.</div></div>
        </div>
        <section class="panel">
          <div class="panel-head"><h2>Next-close breakdown</h2></div>
          ${renderWinLoss({ winners: sum.nextCloseWinners, losers: (sum.withNextClose || 0) - (sum.nextCloseWinners || 0), closedWithPnl: sum.withNextClose }, { title: "Next session close vs alert price", note: "A win means the next regular-session close was above the price in the alert. This is not a paper-trade P&amp;L." })}
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Alerts</h2><span class="panel-updated">${sorted.length} shown</span></div>
          ${renderMoveTabs(alerts)}
          ${renderFilters("lowfloat", alerts)}
          ${lowfloatTable(sorted, state.sort.lowfloat)}
        </section>
      </div>`;
    bindMoveTabs();
    bindFilters("lowfloat");
    bindSort("lowfloat");
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
    else if (state.tab === "stocks") renderBot("stocks");
    else if (state.tab === "lowfloat") renderLowFloat();
    else renderOverview();
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
    if (event.key !== "Escape") return;
    if (closeLightbox()) return;
    if (!drawer().hidden) closeDrawer();
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
