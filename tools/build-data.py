#!/usr/bin/env python3
"""Build data/desk.json from the Options, Stock, and Low Float Scout logs."""

from __future__ import annotations

import csv
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOG_DIR = Path("/workspace/trading-log")
OUT = ROOT / "data" / "desk.json"
CHARTS_OUT = ROOT / "data" / "charts.json"

NUMERIC_RE = re.compile(r"^-?\d+(\.\d+)?$")
YAHOO_UA = "Mozilla/5.0 (compatible; WickHoundSignals/1.0; +https://randec123.github.io/signal-desk/)"
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"


def now_et() -> datetime:
    return datetime.now(ET)


def format_as_of(dt: datetime) -> str:
    hour = dt.strftime("%I").lstrip("0") or "0"
    return f"{hour}:{dt.strftime('%M')} {dt.strftime('%p')} ET, {dt.strftime('%b')} {dt.day}, {dt.year}"


def format_mtime(path: Path) -> str | None:
    if not path.is_file():
        return None
    dt = datetime.fromtimestamp(path.stat().st_mtime, ET)
    return format_as_of(dt)


def parse_value(raw: str):
    if raw is None:
        return None
    text = raw.strip()
    if text == "":
        return None
    if NUMERIC_RE.fullmatch(text):
        if "." in text:
            return float(text)
        try:
            return int(text)
        except ValueError:
            return float(text)
    return text


def load_csv(path: Path, required: bool = True) -> list[dict]:
    if not path.is_file():
        if required:
            raise FileNotFoundError(f"Missing log: {path}")
        return []
    with path.open(newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        rows = []
        for row in reader:
            parsed = {key: parse_value(value) if isinstance(value, str) else value for key, value in row.items()}
            rows.append(parsed)
        return rows


def parse_dt(value) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    text = value.strip()
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def last_exit_time(alert: dict) -> str | None:
    times = []
    for key in ("exit1_time", "exit2_time", "exit3_time"):
        val = alert.get(key)
        if isinstance(val, str) and val.strip():
            times.append(val.strip())
    if not times:
        return None

    def sort_key(item: str):
        dt = parse_dt(item)
        return dt or datetime.min

    times.sort(key=sort_key)
    return times[-1]


def equity_points(alerts: list[dict], pnl_key: str, as_of_naive: str) -> list[dict]:
    items = []
    for alert in alerts:
        if alert.get("status") == "missed entry":
            continue
        pnl = alert.get(pnl_key)
        if pnl is None:
            continue
        status = alert.get("status")
        if status == "closed":
            when = last_exit_time(alert) or alert.get("alert_time_et") or as_of_naive
            kind = "closed"
        else:
            when = as_of_naive
            kind = "mark"
        items.append(
            {
                "timeET": when,
                "pnl": pnl,
                "alertId": alert.get("alert_id"),
                "ticker": alert.get("ticker"),
                "kind": kind,
            }
        )

    def item_key(item: dict):
        dt = parse_dt(item["timeET"]) or datetime.min
        return (dt, item.get("alertId") or "")

    items.sort(key=item_key)
    cumulative = 0.0
    series = []
    for item in items:
        cumulative += float(item["pnl"])
        series.append(
            {
                "timeET": item["timeET"],
                "pnl": round(float(item["pnl"]), 6),
                "cumulative": round(cumulative, 6),
                "alertId": item["alertId"],
                "ticker": item["ticker"],
                "kind": item["kind"],
            }
        )
    return series


def count_by(alerts: list[dict], key: str) -> dict:
    out: dict[str, int] = {}
    for alert in alerts:
        val = alert.get(key)
        label = "—" if val is None or val == "" else str(val)
        out[label] = out.get(label, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def filled(alerts: list[dict]) -> list[dict]:
    return [a for a in alerts if a.get("status") in ("open", "partial", "closed")]


def closed(alerts: list[dict]) -> list[dict]:
    return [a for a in alerts if a.get("status") == "closed"]


def sum_num(alerts: list[dict], key: str) -> float | None:
    vals = [a.get(key) for a in alerts if isinstance(a.get(key), (int, float))]
    if not vals:
        return None
    return round(sum(float(v) for v in vals), 6)


def win_rate(closed_alerts: list[dict], pnl_key: str) -> dict:
    with_pnl = [a for a in closed_alerts if isinstance(a.get(pnl_key), (int, float))]
    winners = [a for a in with_pnl if a[pnl_key] > 0]
    count = len(with_pnl)
    return {
        "closedWithPnl": count,
        "winners": len(winners),
        "losers": count - len(winners),
        "winRate": None if count == 0 else round(len(winners) / count, 4),
    }


def ticker_summaries(alerts: list[dict], pnl_key: str, r_key: str | None, extra_keys: list[str] | None = None) -> list[dict]:
    groups: dict[str, list[dict]] = {}
    for alert in alerts:
        ticker = str(alert.get("ticker") or "—")
        groups.setdefault(ticker, []).append(alert)
    rows = []
    for ticker, group in sorted(groups.items()):
        c = closed(group)
        wr = win_rate(c, pnl_key)
        row = {
            "ticker": ticker,
            "alerts": len(group),
            "open": sum(1 for a in group if a.get("status") == "open"),
            "partial": sum(1 for a in group if a.get("status") == "partial"),
            "closed": len(c),
            "missedEntry": sum(1 for a in group if a.get("status") == "missed entry"),
            "closedPnl": sum_num(c, pnl_key),
            "markPnl": sum_num(filled(group), pnl_key),
            "winRate": wr["winRate"],
            "winners": wr["winners"],
            "losers": wr["losers"],
            "closedWithPnl": wr["closedWithPnl"],
        }
        if r_key:
            row["closedR"] = sum_num(c, r_key)
            row["markR"] = sum_num(filled(group), r_key)
        if extra_keys:
            for key in extra_keys:
                row[key] = sorted({str(a.get(key)) for a in group if a.get(key) not in (None, "")})
        rows.append(row)
    return rows


def summarize_oss(alerts: list[dict], as_of_naive: str) -> dict:
    c = closed(alerts)
    f = filled(alerts)
    wr = win_rate(c, "pnl_usd")
    by_status = count_by(alerts, "status")
    return {
        "bot": "Options Signal Scout",
        "botId": "oss",
        "alerts": len(alerts),
        "byStatus": by_status,
        "open": by_status.get("open", 0),
        "partial": by_status.get("partial", 0),
        "closed": by_status.get("closed", 0),
        "missedEntry": by_status.get("missed entry", 0),
        "closedPnlUsd": sum_num(c, "pnl_usd"),
        "markPnlUsd": sum_num(f, "pnl_usd"),
        "closedR": sum_num(c, "r_underlying"),
        "markR": sum_num(f, "r_underlying"),
        "winRate": wr["winRate"],
        "winners": wr["winners"],
        "losers": wr["losers"],
        "closedWithPnl": wr["closedWithPnl"],
        "pnlUnit": "USD (1 contract, after commissions)",
        "rUnit": "underlying R vs underlying_at_alert",
        "winRateNote": "Closed paper trades with pnl_usd > 0, divided by closed trades that have a P&L. Open, partial, and missed entries are excluded.",
        "tickers": ticker_summaries(alerts, "pnl_usd", "r_underlying"),
        "equity": equity_points(alerts, "pnl_usd", as_of_naive),
        "altEquityClosed": equity_points(
            [a for a in c if isinstance(a.get("alt_pnl_usd"), (int, float))],
            "alt_pnl_usd",
            as_of_naive,
        ),
    }


def summarize_sss(alerts: list[dict], as_of_naive: str) -> dict:
    c = closed(alerts)
    f = filled(alerts)
    wr = win_rate(c, "pnl_per_share")
    by_status = count_by(alerts, "status")
    return {
        "bot": "Stock Signal Scout",
        "botId": "sss",
        "alerts": len(alerts),
        "byStatus": by_status,
        "open": by_status.get("open", 0),
        "partial": by_status.get("partial", 0),
        "closed": by_status.get("closed", 0),
        "missedEntry": by_status.get("missed entry", 0),
        "closedPnlPerShare": sum_num(c, "pnl_per_share"),
        "markPnlPerShare": sum_num(f, "pnl_per_share"),
        "closedR": sum_num(c, "r_result"),
        "markR": sum_num(f, "r_result"),
        "winRate": wr["winRate"],
        "winners": wr["winners"],
        "losers": wr["losers"],
        "closedWithPnl": wr["closedWithPnl"],
        "pnlUnit": "dollars per share (no commission, 1 unit of risk)",
        "rUnit": "R vs the fill-to-stop distance",
        "winRateNote": "Closed paper trades with pnl_per_share > 0, divided by closed trades that have a P&L. Open, partial, and missed entries are excluded.",
        "tickers": ticker_summaries(alerts, "pnl_per_share", "r_result"),
        "equity": equity_points(alerts, "pnl_per_share", as_of_naive),
        "equityR": equity_points(alerts, "r_result", as_of_naive),
    }


def alert_date(alert: dict) -> str | None:
    raw = alert.get("alert_time_et")
    if not isinstance(raw, str):
        raw = None
        if alert.get("date_et"):
            raw = str(alert.get("date_et"))
    dt = parse_dt(raw)
    if not dt:
        return None
    return dt.strftime("%Y-%m-%d")


def lf_alert_dt(alert: dict) -> datetime | None:
    date = alert.get("date_et")
    time_et = alert.get("time_et")
    if date and time_et:
        return parse_dt(f"{date} {time_et}")
    if date:
        return parse_dt(str(date))
    return None


def ts_to_et_naive(ts: int | float) -> datetime:
    return datetime.fromtimestamp(int(ts), ET).replace(tzinfo=None)


def format_bar_time(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d %H:%M")


def compact_bar(ts: int, quote: dict, i: int) -> dict | None:
    o, h, l, c = quote["open"][i], quote["high"][i], quote["low"][i], quote["close"][i]
    if c is None and o is None:
        return None
    vol = quote.get("volume") or []
    v = vol[i] if i < len(vol) else None
    dt = ts_to_et_naive(ts)
    return {
        "t": format_bar_time(dt),
        "o": None if o is None else round(float(o), 6),
        "h": None if h is None else round(float(h), 6),
        "l": None if l is None else round(float(l), 6),
        "c": None if c is None else round(float(c), 6),
        "v": None if v is None else int(v),
    }


def fetch_yahoo(ticker: str, interval: str, range_: str, include_prepost: bool = False) -> dict | None:
    params = f"range={range_}&interval={interval}&events=div%2Csplit"
    if include_prepost:
        params += "&includePrePost=true"
    url = f"{YAHOO_CHART.format(ticker=urllib.parse.quote(ticker))}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": YAHOO_UA, "Accept": "application/json"})
    last_err = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            result = (payload.get("chart") or {}).get("result") or []
            if not result:
                err = (payload.get("chart") or {}).get("error")
                last_err = err or "no result"
                break
            node = result[0]
            timestamps = node.get("timestamp") or []
            quote = ((node.get("indicators") or {}).get("quote") or [{}])[0]
            bars = []
            for i, ts in enumerate(timestamps):
                bar = compact_bar(ts, quote, i)
                if bar:
                    bars.append(bar)
            meta = node.get("meta") or {}
            return {
                "ticker": ticker,
                "interval": interval,
                "range": range_,
                "bars": bars,
                "last": meta.get("regularMarketPrice") or meta.get("chartPreviousClose"),
                "currency": meta.get("currency"),
                "exchange": meta.get("exchangeName") or meta.get("fullExchangeName"),
            }
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError) as exc:
            last_err = str(exc)
            time.sleep(0.4 * (attempt + 1))
    return None if last_err else None


def fetch_ticker_charts(ticker: str) -> dict:
    daily = fetch_yahoo(ticker, "1d", "3mo", include_prepost=False)
    time.sleep(0.12)
    intraday = fetch_yahoo(ticker, "15m", "10d", include_prepost=True)
    time.sleep(0.12)
    errors = []
    if daily is None:
        errors.append("daily")
    if intraday is None:
        errors.append("intraday")
    last = None
    if daily and daily.get("last") is not None:
        last = daily["last"]
    elif intraday and intraday.get("last") is not None:
        last = intraday["last"]
    return {
        "ticker": ticker,
        "daily": (daily or {}).get("bars") or [],
        "intraday": (intraday or {}).get("bars") or [],
        "last": None if last is None else round(float(last), 6),
        "exchange": (daily or intraday or {}).get("exchange"),
        "errors": errors,
        "source": "yahoo",
    }


def collect_tickers(oss: list[dict], sss: list[dict], lowfloat: list[dict]) -> list[str]:
    tickers = []
    seen = set()
    for group in (oss, sss, lowfloat):
        for row in group:
            ticker = str(row.get("ticker") or "").strip().upper()
            if not ticker or ticker in seen:
                continue
            seen.add(ticker)
            tickers.append(ticker)
    return tickers


def pct_change(start, end) -> float | None:
    if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
        return None
    if start == 0:
        return None
    return round((float(end) - float(start)) / float(start) * 100.0, 4)


def bar_dt(bar: dict) -> datetime | None:
    return parse_dt(bar.get("t") if isinstance(bar.get("t"), str) else None)


def next_session_close(daily: list[dict], alert_dt: datetime, session: str) -> tuple[float | None, str | None]:
    if not daily or not alert_dt:
        return None, None
    session = str(session or "").lower()
    # Premarket: next regular close is the same calendar day's session.
    # After hours: next regular close is the next trading day.
    min_date = alert_dt.date() if session == "premarket" else (alert_dt.date() + timedelta(days=1))
    for bar in daily:
        dt = bar_dt(bar)
        if not dt or bar.get("c") is None:
            continue
        if dt.date() >= min_date:
            return float(bar["c"]), dt.strftime("%Y-%m-%d")
    return None, None


def high_since_alert(bars: list[dict], alert_dt: datetime) -> tuple[float | None, str | None]:
    best = None
    best_t = None
    for bar in bars:
        dt = bar_dt(bar)
        if not dt or dt < alert_dt:
            continue
        high = bar.get("h")
        if high is None:
            high = bar.get("c")
        if high is None:
            continue
        high = float(high)
        if best is None or high > best:
            best = high
            best_t = bar.get("t")
    return best, best_t


def attach_lowfloat_performance(alerts: list[dict], charts: dict[str, dict]) -> None:
    for alert in alerts:
        ticker = str(alert.get("ticker") or "").strip().upper()
        pack = charts.get(ticker) or {}
        daily = pack.get("daily") or []
        intraday = pack.get("intraday") or []
        alert_dt = lf_alert_dt(alert)
        price = alert.get("price_at_alert")
        close_px, close_date = next_session_close(daily, alert_dt, alert.get("session") or "") if alert_dt else (None, None)
        high_px, high_t = high_since_alert(intraday or daily, alert_dt) if alert_dt else (None, None)
        last = pack.get("last")
        if last is None and daily:
            last = daily[-1].get("c")
        if last is None and intraday:
            last = intraday[-1].get("c")
        alert["nextSessionClose"] = None if close_px is None else round(close_px, 6)
        alert["nextSessionCloseDate"] = close_date
        alert["chgToNextClosePct"] = pct_change(price, close_px)
        alert["highSinceAlert"] = None if high_px is None else round(high_px, 6)
        alert["highSinceAlertTime"] = high_t
        alert["highSinceAlertPct"] = pct_change(price, high_px)
        alert["lastPrice"] = None if last is None else round(float(last), 6)
        alert["chgToLastPct"] = pct_change(price, last)
        alert["chartAvailable"] = bool(daily or intraday)


def summarize_lowfloat(alerts: list[dict]) -> dict:
    by_session = count_by(alerts, "session")
    by_tag = count_by(alerts, "catalyst_tag")
    with_next = [a for a in alerts if isinstance(a.get("chgToNextClosePct"), (int, float))]
    next_winners = [a for a in with_next if a["chgToNextClosePct"] > 0]
    return {
        "bot": "Low Float News Scout",
        "botId": "lowfloat",
        "alerts": len(alerts),
        "bySession": by_session,
        "byCatalyst": by_tag,
        "tickers": len({str(a.get("ticker") or "") for a in alerts if a.get("ticker")}),
        "withNextClose": len(with_next),
        "nextCloseWinners": len(next_winners),
        "nextCloseWinRate": None if not with_next else round(len(next_winners) / len(with_next), 4),
        "avgChgToNextClosePct": None if not with_next else round(sum(a["chgToNextClosePct"] for a in with_next) / len(with_next), 4),
        "avgHighSinceAlertPct": (
            None
            if not [a for a in alerts if isinstance(a.get("highSinceAlertPct"), (int, float))]
            else round(
                sum(a["highSinceAlertPct"] for a in alerts if isinstance(a.get("highSinceAlertPct"), (int, float)))
                / len([a for a in alerts if isinstance(a.get("highSinceAlertPct"), (int, float))]),
                4,
            )
        ),
        "emptyNote": "Alerts will appear after the next Low Float News Scout scan.",
    }


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(path)


def main() -> None:
    log_dir = Path(os.environ.get("SIGNAL_DESK_LOG_DIR", DEFAULT_LOG_DIR))
    oss_path = log_dir / "oss_alerts_log.csv"
    sss_path = log_dir / "sss_alerts_log.csv"
    lf_path = log_dir / "lowfloat_alerts_log.csv"
    now = now_et()
    as_of_naive = now.strftime("%Y-%m-%d %H:%M")
    today = now.strftime("%Y-%m-%d")

    oss = load_csv(oss_path, required=True)
    sss = load_csv(sss_path, required=True)
    lowfloat = load_csv(lf_path, required=False)

    skip_charts = os.environ.get("SIGNAL_DESK_SKIP_CHARTS", "").strip() in {"1", "true", "yes"}
    charts: dict[str, dict] = {}
    chart_errors: dict[str, list[str]] = {}
    if not skip_charts:
        for ticker in collect_tickers(oss, sss, lowfloat):
            pack = fetch_ticker_charts(ticker)
            charts[ticker] = pack
            if pack.get("errors"):
                chart_errors[ticker] = pack["errors"]
    attach_lowfloat_performance(lowfloat, charts)

    payload = {
        "asOfET": format_as_of(now),
        "asOfISO": now.isoformat(),
        "todayET": today,
        "disclaimer": "Paper trades only. No real orders, and no Webull or TradingView paper orders, are placed from these alerts. Low Float News Scout rows are news alerts, not paper trades.",
        "chartSource": "Yahoo Finance chart API, fetched at build time. A missing ticker or failed request is omitted; the rest of the desk still builds.",
        "sources": {
            "oss": {
                "file": "oss_alerts_log.csv",
                "logMtimeET": format_mtime(oss_path),
                "rows": len(oss),
            },
            "sss": {
                "file": "sss_alerts_log.csv",
                "logMtimeET": format_mtime(sss_path),
                "rows": len(sss),
            },
            "lowfloat": {
                "file": "lowfloat_alerts_log.csv",
                "logMtimeET": format_mtime(lf_path),
                "rows": len(lowfloat),
            },
        },
        "options": {
            "alerts": oss,
            "summary": summarize_oss(oss, as_of_naive),
        },
        "stocks": {
            "alerts": sss,
            "summary": summarize_sss(sss, as_of_naive),
        },
        "lowfloat": {
            "alerts": lowfloat,
            "summary": summarize_lowfloat(lowfloat),
        },
        "today": {
            "dateET": today,
            "options": [a for a in oss if alert_date(a) == today],
            "stocks": [a for a in sss if alert_date(a) == today],
            "lowfloat": [a for a in lowfloat if alert_date(a) == today],
        },
        "chartTickers": {
            ticker: {
                "last": pack.get("last"),
                "hasDaily": bool(pack.get("daily")),
                "hasIntraday": bool(pack.get("intraday")),
                "errors": pack.get("errors") or [],
            }
            for ticker, pack in charts.items()
        },
        "chartErrors": chart_errors,
    }

    write_json(OUT, payload)
    # Compact JSON: charts are large; pretty-print only the smaller desk file.
    CHARTS_OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = CHARTS_OUT.with_suffix(CHARTS_OUT.suffix + ".tmp")
    tmp.write_text(
        json.dumps(
            {
                "asOfET": payload["asOfET"],
                "source": payload["chartSource"],
                "charts": charts,
                "errors": chart_errors,
            },
            separators=(",", ":"),
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    tmp.replace(CHARTS_OUT)


if __name__ == "__main__":
    main()
