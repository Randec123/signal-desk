#!/usr/bin/env python3
"""Build data/desk.json from the Options and Stock Signal Scout paper logs."""

from __future__ import annotations

import csv
import json
import os
import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
ROOT = Path(__file__).resolve().parents[1]
DEFAULT_LOG_DIR = Path("/workspace/trading-log")
OUT = ROOT / "data" / "desk.json"

NUMERIC_RE = re.compile(r"^-?\d+(\.\d+)?$")


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


def load_csv(path: Path) -> list[dict]:
    if not path.is_file():
        raise FileNotFoundError(f"Missing log: {path}")
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
        "closedWithPnl": wr["closedWithPnl"],
        "pnlUnit": "dollars per share (no commission, 1 unit of risk)",
        "rUnit": "R vs the fill-to-stop distance",
        "winRateNote": "Closed paper trades with pnl_per_share > 0, divided by closed trades that have a P&L. Open, partial, and missed entries are excluded.",
        "tickers": ticker_summaries(alerts, "pnl_per_share", "r_result"),
        "equity": equity_points(alerts, "pnl_per_share", as_of_naive),
        "equityR": equity_points(alerts, "r_result", as_of_naive),
    }


def alert_date(alert: dict) -> str | None:
    dt = parse_dt(alert.get("alert_time_et") if isinstance(alert.get("alert_time_et"), str) else None)
    if not dt:
        return None
    return dt.strftime("%Y-%m-%d")


def main() -> None:
    log_dir = Path(os.environ.get("SIGNAL_DESK_LOG_DIR", DEFAULT_LOG_DIR))
    oss_path = log_dir / "oss_alerts_log.csv"
    sss_path = log_dir / "sss_alerts_log.csv"
    now = now_et()
    as_of_naive = now.strftime("%Y-%m-%d %H:%M")
    today = now.strftime("%Y-%m-%d")

    oss = load_csv(oss_path)
    sss = load_csv(sss_path)

    payload = {
        "asOfET": format_as_of(now),
        "asOfISO": now.isoformat(),
        "todayET": today,
        "disclaimer": "Paper trades only. No real orders, and no Webull or TradingView paper orders, are placed from these alerts.",
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
        },
        "options": {
            "alerts": oss,
            "summary": summarize_oss(oss, as_of_naive),
        },
        "stocks": {
            "alerts": sss,
            "summary": summarize_sss(sss, as_of_naive),
        },
        "today": {
            "dateET": today,
            "options": [a for a in oss if alert_date(a) == today],
            "stocks": [a for a in sss if alert_date(a) == today],
        },
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    tmp.replace(OUT)


if __name__ == "__main__":
    main()
