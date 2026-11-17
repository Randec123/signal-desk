# WickHound Signals

A paper-trade desk for Options Signal Scout and Stock Signal Scout alerts, plus a Low Float News Scout section.

**Live site:** https://randec123.github.io/signal-desk/

Every number on the site is copied from the paper logs. No real orders, and no Webull or TradingView paper orders, are placed from these alerts.

## What’s on the site

- **Overview** — totals per bot (alert count, open / partial / closed / missed entry, closed-trade win rate, paper P&L), today’s alerts, a cumulative equity curve, a win/loss breakdown, and a per-ticker summary.
- **Options** and **Stocks** — filters for ticker, status, direction, rating, first hit, and date range; a sortable table; a detail card for each alert with a price chart (entry, stop, targets, and current/exit when available); a win/loss breakdown; and a ticker summary that follows the filters. The stock equity curve is shown in R, with a second dollars-per-share curve (the log has no share count).
- **Low Float** — Low Float News Scout alerts (not paper trades), with a mini chart, next-session close, and high-since-alert performance. If the log is empty, the tab shows a short empty state until the next scan.

Times are America/New_York and are labeled ET. The page shows an “as of” stamp from when the data file was built.

## How P&L and win rate are counted

- **Win rate** is closed paper trades with P&L greater than zero, divided by closed trades that have a P&L. Open, partial, and missed entries are left out.
- **Options Signal Scout** P&L is `pnl_usd` in dollars for 1 contract, after commissions, as logged. The overview shows closed-only P&L and a mark-to-market total that also includes open and partial marks.
- **Stock Signal Scout** P&L is `pnl_per_share` (dollars per share, no commission) and `r_result` (R). The stock equity curve is cumulative R. The log does not record a share count, so the site does not invent an account-dollar total.
- Equity curves plot closed trades at their last exit time. Open and partial marks are plotted at the build’s as-of time (amber dots). Missed entries are omitted because they have no fill.

Status values are the ones in the logs: `open`, `partial`, `closed`, and `missed entry`. First-hit values are `TP1`, `TP2`, `TP3`, or `stop` when logged.

Options trades may show `exit_rule` as `thirds`, `75/25`, or a hybrid such as `thirds->75/25 from 2026-11-16 17:11`. The 75/25 rule (75% at TP1, the rest at TP2, TP3 ignored) applies to new Options alerts from 5:11 PM ET on November 16, 2026, and to every Stock Signal Scout trade. Alternate re-score columns from the options log are shown on the detail card when present.

## Data

The site reads `data/desk.json` and `data/charts.json`, which are built from:

- `/workspace/trading-log/oss_alerts_log.csv` (see `oss_alerts_README.md`)
- `/workspace/trading-log/sss_alerts_log.csv` (see `sss_alerts_README.md`)
- `/workspace/trading-log/lowfloat_alerts_log.csv` (see `lowfloat_alerts_README.md`)

Price history is fetched at build time from the Yahoo Finance chart API and stored in `data/charts.json`. If a ticker fetch fails, that chart is omitted and the rest of the desk still builds. Chart candles use teal for up and white for down.

Rebuild and publish:

```bash
bash /workspace/signal-desk/publish.sh
```

That script rebuilds the JSON, commits files under `data/` only if they changed, pulls/rebases, and pushes. It needs `GH_TOKEN` in the environment. The token is passed through a one-time `git -c http.extraheader` and is never written to `.git/config`.

To rebuild without publishing:

```bash
python3 /workspace/signal-desk/tools/build-data.py
```

Override the log directory with `SIGNAL_DESK_LOG_DIR` if the CSVs are not in `/workspace/trading-log`.

## Local preview

```bash
python3 -m http.server 8080 --directory /workspace/signal-desk
```

Then open http://127.0.0.1:8080/

## Hosting

GitHub Pages, from the `main` branch at the repository root. The app is installable (manifest, service worker, icons). Bump `CACHE_VERSION` in `sw.js` whenever the app shell changes.
