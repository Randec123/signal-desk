#!/usr/bin/env python3
"""Build data/desk.json from the Options, Stock, and Low Float Scout logs."""

from __future__ import annotations

import csv
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOG_DIR = Path("/workspace/trading-log")
OUT = ROOT / "data" / "desk.json"
CHARTS_OUT = ROOT / "data" / "charts.json"
ALERT_CHART_DIR = ROOT / "data" / "alert-charts"
ALERT_CHART_RENDERER = Path(os.environ.get("SSS_CHART_RENDERER", "/workspace/stock-signal-scout/chart_alert.py"))
ALERT_CHART_PYTHON = Path(os.environ.get("SSS_CHART_PYTHON", "/workspace/stock-signal-scout/.venv/bin/python"))
ALERT_CHART_COLORS = 160  # palette size for PNG quantization (keeps committed files small)

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



# Low-float move-day classification, from stored Yahoo daily bars (not guesses).
# A regular session is a "big move day" if it closed at least +20% from the
# prior close, or if volume was at least 5x the average volume of the prior
# 20 sessions (using as many sessions as are available, minimum 5).
BIG_MOVE_PCT = 20.0
VOLUME_SPIKE_X = 5.0
VOLUME_AVG_LOOKBACK = 20
VOLUME_AVG_MIN_BARS = 5
MOVE_DAY_LABELS = ("Day 1", "Day 2", "Day 3", "Day 4+", "Unknown")


def lf_session_date(alert: dict) -> date | None:
    """Premarket belongs to the coming session; after-hours to the session that just closed."""
    dt = lf_alert_dt(alert)
    if not dt:
        return None
    return dt.date()


def daily_rows(daily: list[dict]) -> list[tuple[date, dict]]:
    rows: list[tuple[date, dict]] = []
    for bar in daily or []:
        dt = bar_dt(bar)
        if not dt or bar.get("c") is None:
            continue
        rows.append((dt.date(), bar))
    rows.sort(key=lambda item: item[0])
    return rows


def format_move_pct(pct: float) -> str:
    sign = "+" if pct >= 0 else ""
    return f"{sign}{pct:.0f}%"


def format_vol_mult(mult: float) -> str:
    if mult >= 10:
        return f"{mult:,.0f}x volume"
    return f"{mult:.1f}x volume"


def short_date(value: date) -> str:
    return f"{value.strftime('%b')} {value.day}"


def session_move_stats(rows: list[tuple[date, dict]], day: date) -> dict:
    idx = next((i for i, (d, _) in enumerate(rows) if d == day), None)
    if idx is None:
        return {"status": "missing", "pct": None, "vol_mult": None, "is_big": False, "reasons": []}
    _date, bar = rows[idx]
    close = bar.get("c")
    vol = bar.get("v")
    pct = None
    if idx > 0:
        pct = pct_change(rows[idx - 1][1].get("c"), close)
    prior_vols: list[float] = []
    start = max(0, idx - VOLUME_AVG_LOOKBACK)
    for i in range(start, idx):
        value = rows[i][1].get("v")
        if isinstance(value, (int, float)):
            prior_vols.append(float(value))
    vol_mult = None
    if isinstance(vol, (int, float)) and len(prior_vols) >= VOLUME_AVG_MIN_BARS:
        avg = sum(prior_vols) / len(prior_vols)
        if avg > 0:
            vol_mult = float(vol) / avg
    reasons: list[str] = []
    is_big = False
    if pct is not None and pct >= BIG_MOVE_PCT:
        is_big = True
        reasons.append(format_move_pct(pct))
    if vol_mult is not None and vol_mult >= VOLUME_SPIKE_X:
        is_big = True
        reasons.append(format_vol_mult(vol_mult))
    return {
        "status": "ok",
        "pct": pct,
        "vol_mult": vol_mult,
        "is_big": is_big,
        "reasons": reasons,
    }


def describe_session_stats(stats: dict) -> str:
    parts = []
    if stats.get("pct") is not None:
        parts.append(format_move_pct(stats["pct"]))
    if stats.get("vol_mult") is not None and stats["vol_mult"] > 0:
        parts.append(format_vol_mult(stats["vol_mult"]))
    return " on ".join(parts) if parts else "no close or volume"


def trading_calendar(rows: list[tuple[date, dict]], extra_dates) -> list[date]:
    dates = {d for d, _ in rows}
    dates.update(d for d in extra_dates if d is not None)
    return sorted(dates)


def prior_dates(dates: list[date], session: date, n: int = 2) -> list[date]:
    priors = [d for d in dates if d < session]
    return priors[-n:] if n else priors


def trading_days_inclusive(dates: list[date], start: date, end: date) -> int:
    return len([d for d in dates if start <= d <= end])


def classify_move_day(
    alert: dict,
    rows: list[tuple[date, dict]],
    alert_dates: set[date],
    dates: list[date],
) -> tuple[str, str]:
    session = lf_session_date(alert)
    if session is None:
        return "Unknown", "Alert time is missing."

    def is_link(day: date) -> tuple[bool, dict, bool]:
        has_alert = day in alert_dates
        stats = session_move_stats(rows, day)
        return has_alert or bool(stats.get("is_big")), stats, has_alert

    lookback = prior_dates(dates, session, 2)
    prior = lookback[-1] if lookback else None
    linked_days = []
    for day in lookback:
        linked, stats, has_alert = is_link(day)
        if linked:
            linked_days.append((day, stats, has_alert))

    if not linked_days:
        if prior is None:
            if not rows:
                return "Unknown", "No daily bars to judge the prior session."
            return "Day 1", "No prior session in the stored daily bars; treated as the first day of the move."
        stats = session_move_stats(rows, prior)
        if stats["status"] == "missing" and prior not in alert_dates and not rows:
            return "Unknown", "No daily bars to judge the prior session."
        if stats["status"] == "missing" and prior not in alert_dates:
            return "Unknown", f"Prior session {short_date(prior)} bars are missing."
        return (
            "Day 1",
            f"Prior session {short_date(prior)} was not a big move "
            f"({describe_session_stats(stats)}); no earlier alert in the prior 2 trading days.",
        )

    cursor = session
    start = session
    visited: set[date] = set()
    while cursor not in visited:
        visited.add(cursor)
        links = [day for day in prior_dates(dates, cursor, 2) if is_link(day)[0]]
        if not links:
            start = cursor
            break
        cursor = links[0]
        start = cursor

    if dates:
        day_num = trading_days_inclusive(dates, start, session)
    else:
        day_num = 1
        walker = start
        while walker < session:
            walker += timedelta(days=1)
            if walker.weekday() < 5:
                day_num += 1

    if day_num <= 1:
        label = "Day 1"
    elif day_num == 2:
        label = "Day 2"
    elif day_num == 3:
        label = "Day 3"
    else:
        label = "Day 4+"

    start_stats = session_move_stats(rows, start)
    offset = max(day_num - 1, 0)
    if offset == 0:
        offset_txt = "Same session as"
    elif offset == 1:
        offset_txt = "1 trading day after"
    else:
        offset_txt = f"{offset} trading days after"
    if start_stats.get("is_big"):
        basis = f"{offset_txt} {short_date(start)} {describe_session_stats(start_stats)}"
    elif start in alert_dates:
        basis = f"{offset_txt} the {short_date(start)} alert on this ticker"
        if start_stats.get("status") == "ok":
            basis += f" ({describe_session_stats(start_stats)})"
    else:
        basis = f"{offset_txt} {short_date(start)}"
    return label, basis


def attach_lowfloat_move_days(alerts: list[dict], charts: dict[str, dict]) -> None:
    by_ticker: dict[str, list[dict]] = {}
    for alert in alerts:
        ticker = str(alert.get("ticker") or "").strip().upper()
        by_ticker.setdefault(ticker, []).append(alert)

    for ticker, group in by_ticker.items():
        pack = charts.get(ticker) or {}
        rows = daily_rows(pack.get("daily") or [])
        alert_dates = {d for d in (lf_session_date(a) for a in group) if d}
        dates = trading_calendar(rows, alert_dates)
        for alert in group:
            label, basis = classify_move_day(alert, rows, alert_dates, dates)
            alert["move_day"] = label
            alert["move_day_basis"] = basis


def move_day_stats(alerts: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for label in MOVE_DAY_LABELS:
        subset = [a for a in alerts if a.get("move_day") == label]
        nexts = [a["chgToNextClosePct"] for a in subset if isinstance(a.get("chgToNextClosePct"), (int, float))]
        highs = [a["highSinceAlertPct"] for a in subset if isinstance(a.get("highSinceAlertPct"), (int, float))]
        out[label] = {
            "alerts": len(subset),
            "withNextClose": len(nexts),
            "avgChgToNextClosePct": None if not nexts else round(sum(nexts) / len(nexts), 4),
            "avgHighSinceAlertPct": None if not highs else round(sum(highs) / len(highs), 4),
        }
    return out


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
        "byMoveDay": {label: sum(1 for a in alerts if a.get("move_day") == label) for label in MOVE_DAY_LABELS},
        "moveDayStats": move_day_stats(alerts),
        "moveDayNote": (
            "Day 1 is the first session of a move: the prior regular session was not up 20% or more "
            "and did not trade at least 5x its 20-day average volume, and there was no earlier "
            "low-float alert on that ticker in the prior 2 trading days. Day 2, Day 3, and Day 4+ "
            "count trading days from that start. Premarket alerts belong to the coming session; "
            "after-hours alerts belong to the session that just closed. If daily bars are missing, "
            "the alert is marked Unknown."
        ),
        "emptyNote": "Alerts will appear after the next Low Float News Scout scan.",
    }


# ---------------------------------------------------------------------------
# Stock Signal Scout alert-time chart images (data/alert-charts/*.png)
# ---------------------------------------------------------------------------


def alert_chart_name(alert: dict) -> str | None:
    dt = parse_dt(alert.get("alert_time_et"))
    ticker = str(alert.get("ticker") or "").upper().strip()
    if not dt or not ticker or not re.fullmatch(r"[A-Z0-9.\-]+", ticker):
        return None
    return f"SSS_{ticker}_{dt.strftime('%Y%m%d_%H%M')}.png"


def fetch_hourly_rth_before(ticker: str, alert_dt: datetime) -> list[dict]:
    """Yahoo hourly regular-session bars that had fully closed by alert_dt (ET naive)."""
    start = (alert_dt - timedelta(days=45)).replace(tzinfo=ET)
    end = (alert_dt + timedelta(days=1)).replace(tzinfo=ET)
    params = urllib.parse.urlencode(
        {"period1": int(start.timestamp()), "period2": int(end.timestamp()), "interval": "1h", "events": "div,split"}
    )
    url = f"{YAHOO_CHART.format(ticker=urllib.parse.quote(ticker))}?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": YAHOO_UA, "Accept": "application/json"})
    payload = None
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                payload = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
            time.sleep(0.5 * (attempt + 1))
    result = ((payload or {}).get("chart") or {}).get("result") or []
    if not result:
        return []
    node = result[0]
    quote = ((node.get("indicators") or {}).get("quote") or [{}])[0]
    bars = []
    for i, ts in enumerate(node.get("timestamp") or []):
        bar = compact_bar(ts, quote, i)
        if not bar or None in (bar["o"], bar["h"], bar["l"], bar["c"]):
            continue
        t = ts_to_et_naive(ts)
        minutes = t.hour * 60 + t.minute
        if t.weekday() >= 5 or minutes < 9 * 60 + 30 or minutes >= 16 * 60:
            continue  # regular session only
        bar_end = min(t + timedelta(hours=1), t.replace(hour=16, minute=0))
        if bar_end > alert_dt:
            continue  # bar still forming (or after) at the alert: no later price action
        bars.append({**bar, "_dt": t})
    return bars


def prior_day_levels(bars: list[dict], alert_dt: datetime) -> dict:
    days = sorted({b["_dt"].date() for b in bars if b["_dt"].date() < alert_dt.date()})
    if not days:
        return {}
    prev = [b for b in bars if b["_dt"].date() == days[-1]]
    return {"pdh": max(b["h"] for b in prev), "pdl": min(b["l"] for b in prev)}


def compress_png(path: Path) -> None:
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        return
    try:
        with Image.open(path) as img:
            q = img.convert("RGB").quantize(colors=ALERT_CHART_COLORS, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            tmp = path.with_suffix(".q.png")
            q.save(tmp, optimize=True)
        if tmp.stat().st_size < path.stat().st_size:
            tmp.replace(path)
        else:
            tmp.unlink()
    except Exception:  # noqa: BLE001 - compression is best effort
        pass


def render_sss_alert_chart(alert: dict, out_path: Path) -> str | None:
    """Render one alert chart. Returns an error string, or None on success."""
    alert_dt = parse_dt(alert.get("alert_time_et"))
    if not alert_dt:
        return "bad alert time"
    if not ALERT_CHART_RENDERER.is_file() or not ALERT_CHART_PYTHON.is_file():
        return "renderer not available"
    ticker = str(alert["ticker"]).upper()
    bars = fetch_hourly_rth_before(ticker, alert_dt)
    if len(bars) < 20:
        return f"only {len(bars)} hourly bars"
    data = {
        "ticker": ticker,
        "side": str(alert.get("side") or "").upper(),
        "rating": alert.get("rating"),
        "entry_low": alert.get("entry_zone_lo"),
        "entry_high": alert.get("entry_zone_hi"),
        "stop": alert.get("stop"),
        "tp1": alert.get("tp1"),
        "tp2": alert.get("tp2"),
        "tp3": alert.get("tp3"),
        "alert_time": alert_dt.strftime("%Y-%m-%dT%H:%M:%S"),  # naive = ET for the renderer
        **prior_day_levels(bars, alert_dt),
        "bars": [
            {
                "time": b["_dt"].replace(tzinfo=ET).isoformat(),
                "open": b["o"],
                "high": b["h"],
                "low": b["l"],
                "close": b["c"],
                "volume": b["v"] or 0,
            }
            for b in bars
        ],
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmpdir:
        in_json = Path(tmpdir) / "alert.json"
        tmp_png = Path(tmpdir) / out_path.name
        in_json.write_text(json.dumps(data), encoding="utf-8")
        try:
            proc = subprocess.run(
                [str(ALERT_CHART_PYTHON), str(ALERT_CHART_RENDERER), str(in_json), "-o", str(tmp_png)],
                capture_output=True,
                text=True,
                timeout=120,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            return f"renderer failed: {exc}"
        if proc.returncode != 0 or not tmp_png.is_file():
            tail = (proc.stderr or proc.stdout or "").strip().splitlines()[-1:] or ["unknown error"]
            return f"renderer failed: {tail[0][:200]}"
        compress_png(tmp_png)
        tmp_png.replace(out_path)
    return None


def attach_sss_alert_charts(alerts: list[dict], allow_render: bool) -> dict[str, str]:
    """Ensure each stock alert has data/alert-charts/SSS_*.png; record the path on the alert."""
    errors: dict[str, str] = {}
    force = os.environ.get("SIGNAL_DESK_RERENDER_ALERT_CHARTS", "").strip() in {"1", "true", "yes"}
    for alert in alerts:
        alert["alert_chart"] = None
        name = alert_chart_name(alert)
        if not name:
            continue
        path = ALERT_CHART_DIR / name
        if (force or not path.is_file()) and allow_render:
            err = render_sss_alert_chart(alert, path)
            if err:
                errors[str(alert.get("alert_id"))] = err
                print(f"alert chart skipped for {alert.get('alert_id')} {alert.get('ticker')}: {err}", file=sys.stderr)
            else:
                print(f"alert chart rendered: {path.relative_to(ROOT)}", file=sys.stderr)
            time.sleep(0.12)
        if path.is_file():
            alert["alert_chart"] = str(path.relative_to(ROOT))
    return errors


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
    existing_charts: dict[str, dict] = {}
    if CHARTS_OUT.is_file():
        try:
            existing_charts = (json.loads(CHARTS_OUT.read_text(encoding="utf-8")) or {}).get("charts") or {}
        except (OSError, json.JSONDecodeError):
            existing_charts = {}
    if not skip_charts:
        for ticker in collect_tickers(oss, sss, lowfloat):
            pack = fetch_ticker_charts(ticker)
            old = existing_charts.get(ticker) or {}
            if old:
                if not pack.get("daily") and old.get("daily"):
                    pack["daily"] = old["daily"]
                    pack["errors"] = [e for e in (pack.get("errors") or []) if e != "daily"]
                if not pack.get("intraday") and old.get("intraday"):
                    pack["intraday"] = old["intraday"]
                    pack["errors"] = [e for e in (pack.get("errors") or []) if e != "intraday"]
                if pack.get("last") is None and old.get("last") is not None:
                    pack["last"] = old["last"]
            charts[ticker] = pack
            if pack.get("errors"):
                chart_errors[ticker] = pack["errors"]
    elif existing_charts:
        charts = existing_charts
    alert_chart_errors = attach_sss_alert_charts(sss, allow_render=not skip_charts)
    attach_lowfloat_performance(lowfloat, charts)
    attach_lowfloat_move_days(lowfloat, charts)

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
        "alertChartErrors": alert_chart_errors,
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
