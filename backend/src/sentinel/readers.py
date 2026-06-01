"""Read PinSight + DriftEdge data into JSON-friendly payloads."""
from __future__ import annotations

import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import pandas as pd


def _latest_file(dir_: Path, pattern: str = "*.parquet") -> Optional[Path]:
    if not dir_.exists():
        return None
    candidates = sorted(dir_.glob(pattern), key=lambda p: p.stat().st_mtime, reverse=True)
    return candidates[0] if candidates else None


def _records(df: pd.DataFrame, n: int = 100) -> list[dict]:
    return df.head(n).where(pd.notna(df), None).to_dict(orient="records")


# ---------- PinSight ----------

def pinsight_latest_chain(data_dir: Path) -> dict[str, Any]:
    """Return the most recently modified chain Parquet for any underlying."""
    chains_root = data_dir / "chains"
    if not chains_root.exists():
        return {"status": "no_data", "reason": "chains directory not found"}

    latest_path: Optional[Path] = None
    latest_mtime = 0.0
    for symbol_dir in chains_root.iterdir():
        if not symbol_dir.is_dir():
            continue
        p = _latest_file(symbol_dir)
        if p and p.stat().st_mtime > latest_mtime:
            latest_path, latest_mtime = p, p.stat().st_mtime

    if latest_path is None:
        return {"status": "no_data", "reason": "no chain parquets"}

    df = pd.read_parquet(latest_path)
    if "_snapshot_ts" in df.columns:
        latest_ts = df["_snapshot_ts"].max()
        df = df[df["_snapshot_ts"] == latest_ts]

    underlying = latest_path.parent.name
    expiry = latest_path.stem
    underlying_price = float(df["underlying_price"].iloc[0]) if not df.empty else None

    summary = {
        "status": "ok",
        "underlying": underlying,
        "expiry": expiry,
        "underlying_price": underlying_price,
        "snapshot_ts": str(df["_snapshot_ts"].max()) if "_snapshot_ts" in df.columns else None,
        "contracts": len(df),
        "calls": int((df["contract_type"] == "call").sum()),
        "puts": int((df["contract_type"] == "put").sum()),
        "total_call_vol": int(df[df["contract_type"] == "call"]["volume"].sum()),
        "total_put_vol": int(df[df["contract_type"] == "put"]["volume"].sum()),
        "file_path": str(latest_path),
        "file_mtime": datetime.fromtimestamp(latest_mtime).isoformat(),
    }
    return summary


def pinsight_flagged_contracts(data_dir: Path, top: int = 20) -> dict[str, Any]:
    chains_root = data_dir / "chains"
    if not chains_root.exists():
        return {"status": "no_data"}

    rows: list[dict] = []
    for symbol_dir in chains_root.iterdir():
        if not symbol_dir.is_dir():
            continue
        for p in symbol_dir.glob("*.parquet"):
            try:
                df = pd.read_parquet(p)
            except Exception:
                continue
            if df.empty:
                continue
            if "_snapshot_ts" in df.columns:
                df = df[df["_snapshot_ts"] == df["_snapshot_ts"].max()]
            df = df.copy()
            df["v_over_oi"] = df["volume"] / df["open_interest"].replace(0, float("nan"))
            df = df[(df["v_over_oi"] >= 1.0) & (df["volume"] >= 1000)]
            if df.empty:
                continue
            for _, r in df.iterrows():
                rows.append({
                    "underlying": symbol_dir.name,
                    "expiry": p.stem,
                    "type": r["contract_type"],
                    "strike": float(r["strike"]),
                    "volume": int(r["volume"]),
                    "open_interest": int(r["open_interest"]),
                    "v_over_oi": round(float(r["v_over_oi"]), 2),
                    "iv": round(float(r["iv"]), 4) if pd.notna(r.get("iv")) else None,
                })
    rows.sort(key=lambda r: r["v_over_oi"], reverse=True)
    return {"status": "ok", "count": len(rows), "items": rows[:top]}


# ---------- DriftEdge ----------

def driftedge_top_markets(data_dir: Path, top: int = 30) -> dict[str, Any]:
    markets_root = data_dir / "markets" / "polymarket"
    if not markets_root.exists():
        return {"status": "no_data"}
    p = _latest_file(markets_root)
    if p is None:
        return {"status": "no_data"}
    df = pd.read_parquet(p)
    if "_snapshot_ts" in df.columns:
        df = df[df["_snapshot_ts"] == df["_snapshot_ts"].max()]
    df = df.sort_values("volume_24h", ascending=False).head(top)
    items: list[dict] = []
    for _, r in df.iterrows():
        items.append({
            "market_id": r.get("market_id"),
            "question": r.get("question"),
            "category": r.get("category"),
            "end_date": r.get("end_date"),
            "yes_price": float(r["yes_price"]) if pd.notna(r.get("yes_price")) else None,
            "no_price": float(r["no_price"]) if pd.notna(r.get("no_price")) else None,
            "volume_24h": float(r["volume_24h"]) if pd.notna(r.get("volume_24h")) else None,
            "spread": float(r["spread"]) if pd.notna(r.get("spread")) else None,
        })
    return {
        "status": "ok",
        "snapshot_ts": str(df["_snapshot_ts"].max()) if "_snapshot_ts" in df.columns else None,
        "count": len(items),
        "items": items,
    }


def driftedge_paper_trades(data_dir: Path) -> dict[str, Any]:
    """Read paper_trades.parquet + paper_state.parquet and return a
    multi-trader summary."""
    trades_path = data_dir / "paper_trades.parquet"
    state_path = data_dir / "paper_state.parquet"
    if not trades_path.exists():
        return {"status": "no_data"}
    try:
        df = pd.read_parquet(trades_path)
    except Exception as exc:
        return {"status": "error", "err": str(exc)}
    if df.empty:
        return {"status": "no_data"}

    # Per-trader portfolio state from state file
    state_by_trader: dict[str, dict[str, Any]] = {}
    if state_path.exists():
        try:
            st = pd.read_parquet(state_path)
            for _, r in st.iterrows():
                state_by_trader[str(r["trader"])] = {
                    "bankroll_init": float(r["bankroll_init"]),
                    "cash_usd": round(float(r["cash_usd"]), 2),
                    "open_exposure": round(float(r["open_exposure"]), 2),
                    "closed_pnl": round(float(r["closed_pnl"]), 2),
                    "total_equity": round(float(r["cash_usd"]) + float(r["open_exposure"]), 2),
                    "peak_equity": round(float(r["peak_equity"]), 2),
                    "drawdown_pct": round(float(r["current_drawdown_pct"]), 3),
                }
        except Exception:
            pass

    open_df = df[df["status"] == "open"]
    closed_df = df[df["status"] != "open"]

    # Per-trader metrics
    by_trader: dict[str, dict[str, Any]] = {}
    traders_seen = set(state_by_trader.keys())
    if "trader" in df.columns:
        traders_seen.update(df["trader"].fillna("?").unique())
    for t in sorted(traders_seen):
        t_df = df[df["trader"].fillna("?") == t] if "trader" in df.columns else df.head(0)
        t_open = t_df[t_df["status"] == "open"]
        t_closed = t_df[t_df["status"] != "open"]
        state = state_by_trader.get(t, {})
        equity = state.get("total_equity")
        bankroll = state.get("bankroll_init")
        by_trader[t] = {
            **state,
            "total_trades": len(t_df),
            "open_count": len(t_open),
            "closed_count": len(t_closed),
            "wins": int((t_closed["pnl_usd"] > 0).sum()) if not t_closed.empty else 0,
            "losses": int((t_closed["pnl_usd"] <= 0).sum()) if not t_closed.empty else 0,
            "hit_rate": (
                round(float((t_closed["pnl_usd"] > 0).mean()), 3)
                if not t_closed.empty else None
            ),
            "avg_size": (
                round(float(t_df["entry_size_usd"].mean()), 2)
                if "entry_size_usd" in t_df.columns and not t_df.empty else None
            ),
            "return_pct": (
                round((equity / bankroll - 1) * 100, 3)
                if (equity is not None and bankroll) else None
            ),
        }

    by_venue: dict[str, dict[str, Any]] = {}
    for v in df.get("venue", pd.Series(dtype=str)).fillna("unknown").unique():
        v_df = df[df["venue"].fillna("unknown") == v]
        v_closed = v_df[v_df["status"] != "open"]
        by_venue[str(v)] = {
            "total": len(v_df),
            "open": int((v_df["status"] == "open").sum()),
            "closed": len(v_closed),
            "pnl_usd": (
                round(float(v_closed["pnl_usd"].fillna(0).sum()), 2)
                if not v_closed.empty else 0.0
            ),
            "hit_rate": (
                round(float((v_closed["pnl_usd"] > 0).mean()), 3)
                if not v_closed.empty else None
            ),
        }

    # Per-category breakdown for diagnostic visibility.
    by_category: dict[str, dict[str, Any]] = {}
    if "category" in df.columns:
        for cat in df["category"].fillna("other").unique():
            c_df = df[df["category"].fillna("other") == cat]
            c_closed = c_df[c_df["status"] != "open"]
            by_category[str(cat)] = {
                "total": len(c_df),
                "open": int((c_df["status"] == "open").sum()),
                "closed": len(c_closed),
                "pnl_usd": (
                    round(float(c_closed["pnl_usd"].fillna(0).sum()), 2)
                    if not c_closed.empty else 0.0
                ),
                "hit_rate": (
                    round(float((c_closed["pnl_usd"] > 0).mean()), 3)
                    if not c_closed.empty else None
                ),
                "avg_pnl": (
                    round(float(c_closed["pnl_usd"].fillna(0).mean()), 2)
                    if not c_closed.empty else None
                ),
            }

    summary = {
        "total_trades": len(df),
        "open_count": len(open_df),
        "closed_count": len(closed_df),
        "wins": int((closed_df["pnl_usd"] > 0).sum()) if not closed_df.empty else 0,
        "losses": int((closed_df["pnl_usd"] <= 0).sum()) if not closed_df.empty else 0,
        "hit_rate": (
            round(float((closed_df["pnl_usd"] > 0).mean()), 3)
            if not closed_df.empty else None
        ),
        "total_pnl_usd": (
            round(float(closed_df["pnl_usd"].fillna(0).sum()), 2)
            if not closed_df.empty else 0.0
        ),
        "avg_pnl_per_trade": (
            round(float(closed_df["pnl_usd"].fillna(0).mean()), 2)
            if not closed_df.empty else None
        ),
        "exit_reasons": (
            closed_df["exit_reason"].value_counts().to_dict()
            if not closed_df.empty else {}
        ),
        "by_venue": by_venue,
        "by_trader": by_trader,
        "by_category": by_category,
    }

    def _row(r) -> dict:
        return {
            "trade_id": r.get("trade_id"),
            "trader": r.get("trader") or "—",
            "venue": r.get("venue") or "—",
            "category": r.get("category") or "—",
            "market_id": r.get("market_id"),
            "question": r.get("question"),
            "entry_ts": str(r.get("entry_ts")) if r.get("entry_ts") else None,
            "exit_ts": str(r.get("exit_ts")) if pd.notna(r.get("exit_ts")) else None,
            "entry_price": round(float(r["entry_price"]), 4) if pd.notna(r.get("entry_price")) else None,
            "size_usd": round(float(r["entry_size_usd"]), 2) if pd.notna(r.get("entry_size_usd")) else None,
            "target": round(float(r["target"]), 3) if pd.notna(r.get("target")) else None,
            "stop": round(float(r["stop"]), 3) if pd.notna(r.get("stop")) else None,
            "status": r.get("status"),
            "exit_price": round(float(r["exit_price"]), 4) if pd.notna(r.get("exit_price")) else None,
            "exit_reason": r.get("exit_reason"),
            "pnl_usd": round(float(r["pnl_usd"]), 2) if pd.notna(r.get("pnl_usd")) else None,
        }

    return {
        "status": "ok",
        "summary": summary,
        "open": [_row(r) for _, r in open_df.iterrows()],
        "closed": [_row(r) for _, r in closed_df.sort_values(
            "exit_ts", ascending=False).iterrows()],
    }


def driftedge_equity_history(data_dir: Path) -> dict[str, Any]:
    """Compute equity time series per trader from closed trades, then
    extend the line to NOW by marking open positions to market via the
    most recent orderbook snapshot for each open market.

    Equity(t) = bankroll_init + sum(pnl_usd for closed trades exit_ts <= t)
              + mark-to-market(open positions @ t)
    The final point is at datetime.now() so the chart never looks 'stuck'.
    """
    trades_path = data_dir / "paper_trades.parquet"
    state_path = data_dir / "paper_state.parquet"
    if not trades_path.exists():
        return {"status": "no_data"}
    try:
        df = pd.read_parquet(trades_path)
    except Exception as exc:
        return {"status": "error", "err": str(exc)}
    if df.empty or "trader" not in df.columns:
        return {"status": "no_data"}

    bankrolls: dict[str, float] = {}
    if state_path.exists():
        try:
            st = pd.read_parquet(state_path)
            for _, r in st.iterrows():
                bankrolls[str(r["trader"])] = float(r["bankroll_init"])
        except Exception:
            pass

    # Mark-to-market helper: read latest orderbook for each open market.
    def _latest_mid(venue: str, market_id: str) -> Optional[float]:
        books_dir = data_dir / "books" / venue / market_id
        if not books_dir.exists():
            return None
        latest = max(books_dir.glob("*.parquet"),
                     key=lambda p: p.stat().st_mtime, default=None)
        if latest is None:
            return None
        try:
            bdf = pd.read_parquet(latest)
            if bdf.empty or "snapshot_ts" not in bdf.columns:
                return None
            snap = bdf[bdf["snapshot_ts"] == bdf["snapshot_ts"].max()]
            bids = snap[snap["side"] == "bid"]
            asks = snap[snap["side"] == "ask"]
            if bids.empty or asks.empty:
                return None
            return (float(bids["price"].max()) + float(asks["price"].min())) / 2.0
        except Exception:
            return None

    closed = df[df["status"] != "open"].copy()
    open_pos = df[df["status"] == "open"].copy()
    series: dict[str, list[dict[str, Any]]] = {}
    now_ts = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for trader in sorted(df["trader"].fillna("?").unique()):
        bank = bankrolls.get(trader, 10000.0)
        t_closed = closed[closed["trader"] == trader].copy()
        seed_ts = df[df["trader"] == trader]["entry_ts"].min()
        if seed_ts is None or pd.isna(seed_ts):
            seed_ts = now_ts
        points = [{"ts": str(seed_ts), "equity": round(bank, 2)}]

        running = bank
        if not t_closed.empty:
            t_closed = t_closed.sort_values("exit_ts")
            for _, r in t_closed.iterrows():
                running += float(r.get("pnl_usd") or 0.0)
                points.append({"ts": str(r.get("exit_ts")),
                               "equity": round(running, 2)})

        # Mark open positions to market and append a "now" point so the
        # equity line extends to the current moment.
        t_open = open_pos[open_pos["trader"] == trader]
        unrealized = 0.0
        for _, op in t_open.iterrows():
            mid = _latest_mid(op.get("venue", "polymarket"),
                              op.get("market_id"))
            if mid is None:
                continue
            entry = float(op.get("entry_price") or 0.0)
            shares = float(op.get("shares") or 0.0)
            unrealized += (mid - entry) * shares
        points.append({"ts": now_ts,
                       "equity": round(running + unrealized, 2)})

        series[trader] = points

    return {"status": "ok", "series": series,
            "bankrolls": bankrolls or {"kelly": 10000, "equal": 10000, "volwt": 10000}}


def driftedge_price_distribution(data_dir: Path) -> dict[str, Any]:
    """Histogram of yes_price across the latest markets snapshot."""
    markets_root = data_dir / "markets" / "polymarket"
    p = _latest_file(markets_root) if markets_root.exists() else None
    if p is None:
        return {"status": "no_data"}
    df = pd.read_parquet(p)
    if "_snapshot_ts" in df.columns:
        df = df[df["_snapshot_ts"] == df["_snapshot_ts"].max()]
    prices = df["yes_price"].dropna().tolist()
    bins = [i / 20 for i in range(21)]  # 0.00..1.00 in 0.05 steps
    counts = [0] * (len(bins) - 1)
    for v in prices:
        for i in range(len(bins) - 1):
            if bins[i] <= v < bins[i + 1] or (i == len(bins) - 2 and v == 1.0):
                counts[i] += 1
                break
    return {
        "status": "ok",
        "bins": bins,
        "counts": counts,
        "total": len(prices),
    }


def sentinel_health(pinsight_data: Path, pinsight_logs: Path,
                    driftedge_data: Path, driftedge_logs: Path,
                    sentinel_logs: Path) -> dict[str, Any]:
    """System-wide health snapshot."""

    def _dir_size_mb(d: Path) -> float:
        if not d.exists():
            return 0.0
        total = 0
        for root, _, files in os.walk(d):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return round(total / 1024 / 1024, 2)

    def _launchd_status(label: str) -> dict[str, Any]:
        try:
            out = subprocess.check_output(
                ["launchctl", "list"], text=True, timeout=3)
            for line in out.splitlines():
                if label in line:
                    parts = line.split("\t")
                    pid_s = parts[0] if parts else "-"
                    exit_s = parts[1] if len(parts) > 1 else "-"
                    return {"loaded": True,
                            "pid": None if pid_s == "-" else int(pid_s),
                            "last_exit_code": int(exit_s) if exit_s.lstrip("-").isdigit() else None}
        except Exception:
            pass
        return {"loaded": False, "pid": None, "last_exit_code": None}

    today = datetime.utcnow().strftime("%Y-%m-%d")

    def _today_log_size(log_dir: Path) -> float:
        if not log_dir.exists():
            return 0.0
        total = 0
        for p in log_dir.glob(f"*-{today}.jsonl"):
            try:
                total += p.stat().st_size
            except OSError:
                pass
        return round(total / 1024 / 1024, 3)

    return {
        "status": "ok",
        "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pinsight": {
            "data_size_mb": _dir_size_mb(pinsight_data),
            "log_size_today_mb": _today_log_size(pinsight_logs),
            "launchd": {
                "morning": _launchd_status("com.tanishk.pinsight.morning"),
                "midday": _launchd_status("com.tanishk.pinsight.midday"),
                "close": _launchd_status("com.tanishk.pinsight.close"),
            },
        },
        "driftedge": {
            "data_size_mb": _dir_size_mb(driftedge_data),
            "log_size_today_mb": _today_log_size(driftedge_logs),
            "launchd": {
                "poll": _launchd_status("com.tanishk.driftedge.poll"),
            },
        },
        "sentinel": {
            "log_size_today_mb": _today_log_size(sentinel_logs),
            "launchd": {
                "server": _launchd_status("com.tanishk.sentinel"),
            },
        },
    }


def driftedge_market_detail(data_dir: Path, venue: str,
                            market_id: str) -> dict[str, Any]:
    """Per-market deep dive: latest snapshot + price history from book archive + paper trades."""
    markets_root = data_dir / "markets" / venue
    meta: dict[str, Any] = {}
    if markets_root.exists():
        latest_mp = _latest_file(markets_root)
        if latest_mp is not None:
            try:
                mdf = pd.read_parquet(latest_mp)
                if "_snapshot_ts" in mdf.columns:
                    mdf = mdf[mdf["_snapshot_ts"] == mdf["_snapshot_ts"].max()]
                hit = mdf[mdf["market_id"] == market_id]
                if not hit.empty:
                    r = hit.iloc[0]
                    meta = {
                        "venue": venue,
                        "market_id": market_id,
                        "question": r.get("question"),
                        "category": r.get("category"),
                        "end_date": r.get("end_date"),
                        "yes_price": float(r["yes_price"]) if pd.notna(r.get("yes_price")) else None,
                        "no_price": float(r["no_price"]) if pd.notna(r.get("no_price")) else None,
                        "best_bid": float(r["best_bid"]) if pd.notna(r.get("best_bid")) else None,
                        "best_ask": float(r["best_ask"]) if pd.notna(r.get("best_ask")) else None,
                        "spread": float(r["spread"]) if pd.notna(r.get("spread")) else None,
                        "volume_24h": float(r["volume_24h"]) if pd.notna(r.get("volume_24h")) else None,
                    }
            except Exception:
                pass

    books_root = data_dir / "books" / venue / market_id
    points: list[dict[str, Any]] = []
    if books_root.exists():
        for parquet in sorted(books_root.glob("*.parquet")):
            try:
                bdf = pd.read_parquet(parquet)
            except Exception:
                continue
            if bdf.empty or "snapshot_ts" not in bdf.columns:
                continue
            for ts, snap in bdf.groupby("snapshot_ts"):
                bids = snap[snap["side"] == "bid"]
                asks = snap[snap["side"] == "ask"]
                top_bid = float(bids["price"].max()) if not bids.empty else None
                top_ask = float(asks["price"].min()) if not asks.empty else None
                mid = (top_bid + top_ask) / 2 if (top_bid is not None and top_ask is not None) else None
                points.append({"ts": str(ts), "bid": top_bid,
                               "ask": top_ask, "mid": mid})
    points.sort(key=lambda p: p["ts"])

    trades: list[dict[str, Any]] = []
    trades_path = data_dir / "paper_trades.parquet"
    if trades_path.exists():
        try:
            tdf = pd.read_parquet(trades_path)
            if "market_id" in tdf.columns:
                hit = tdf[tdf["market_id"] == market_id]
                for _, r in hit.iterrows():
                    trades.append({
                        "trader": r.get("trader"),
                        "entry_ts": str(r.get("entry_ts")) if r.get("entry_ts") else None,
                        "entry_price": float(r["entry_price"]) if pd.notna(r.get("entry_price")) else None,
                        "exit_ts": str(r.get("exit_ts")) if pd.notna(r.get("exit_ts")) else None,
                        "exit_price": float(r["exit_price"]) if pd.notna(r.get("exit_price")) else None,
                        "exit_reason": r.get("exit_reason"),
                        "size_usd": float(r["entry_size_usd"]) if pd.notna(r.get("entry_size_usd")) else None,
                        "pnl_usd": float(r["pnl_usd"]) if pd.notna(r.get("pnl_usd")) else None,
                        "status": r.get("status"),
                    })
        except Exception:
            pass

    return {
        "status": "ok" if (meta or points) else "no_data",
        "meta": meta,
        "history": points,
        "trades": trades,
        "snapshot_count": len(points),
    }


def driftedge_review_queue(data_dir: Path) -> dict[str, Any]:
    """Markets with confidence != 'high' awaiting manual classification."""
    p = data_dir / "market_categories.parquet"
    if not p.exists():
        return {"status": "no_data", "items": [], "stats": {}}
    try:
        df = pd.read_parquet(p)
    except Exception as exc:
        return {"status": "error", "err": str(exc)}
    if df.empty:
        return {"status": "ok", "items": [], "stats": {"total": 0}}

    review = df[~df["decided"]].copy()
    items = review.sort_values("first_seen", ascending=False).head(100).to_dict("records")
    for r in items:
        for k in ("first_seen", "decided_at"):
            if k in r and r[k] is not None:
                r[k] = str(r[k])
    stats = {
        "total": len(df),
        "decided": int(df["decided"].sum()),
        "needs_review": int((~df["decided"]).sum()),
        "by_category": df["category"].value_counts().to_dict(),
        "by_confidence": df["confidence"].value_counts().to_dict(),
    }
    return {"status": "ok", "items": items, "stats": stats}


def driftedge_news(data_dir: Path, *, category: Optional[str] = None,
                   sentiment: Optional[str] = None,
                   limit: int = 200) -> dict[str, Any]:
    """Latest news items (Bloomberg-style headline + source + sentiment)."""
    news_dir = data_dir / "news"
    if not news_dir.exists():
        return {"status": "no_data", "items": [], "stats": {}}
    files = sorted(news_dir.glob("*.parquet"),
                   key=lambda p: p.stat().st_mtime, reverse=True)[:3]
    if not files:
        return {"status": "no_data", "items": [], "stats": {}}

    dfs = []
    for p in files:
        try:
            dfs.append(pd.read_parquet(p))
        except Exception:
            continue
    if not dfs:
        return {"status": "no_data", "items": [], "stats": {}}
    full = pd.concat(dfs, ignore_index=True).drop_duplicates(
        subset=["id"], keep="first")

    df = full.copy()
    if category:
        df = df[df["category"] == category]
    if sentiment:
        df = df[df["sentiment_label"] == sentiment]

    df = df.sort_values("published_ts", ascending=False).head(limit)
    items = []
    for _, r in df.iterrows():
        items.append({
            "id": r.get("id"),
            "source": r.get("source"),
            "headline": r.get("headline"),
            "url": r.get("url"),
            "published_ts": str(r.get("published_ts")) if r.get("published_ts") else None,
            "category": r.get("category") or "other",
            "sentiment_score": float(r["sentiment_score"]) if pd.notna(r.get("sentiment_score")) else 0.0,
            "sentiment_label": r.get("sentiment_label") or "neutral",
        })

    stats = {
        "total": len(full),
        "by_sentiment": full["sentiment_label"].value_counts().to_dict(),
        "by_category": full["category"].value_counts().to_dict(),
        "by_source": full["source"].value_counts().head(15).to_dict(),
        "files_loaded": [p.name for p in files],
    }
    return {"status": "ok", "items": items, "stats": stats}


def driftedge_active_books(data_dir: Path) -> dict[str, Any]:
    """Count of orderbook Parquets per market — a liveness signal."""
    books_root = data_dir / "books" / "polymarket"
    if not books_root.exists():
        return {"status": "no_data"}
    markets: list[dict] = []
    for md in books_root.iterdir():
        if not md.is_dir():
            continue
        files = list(md.glob("*.parquet"))
        if not files:
            continue
        latest = max(files, key=lambda p: p.stat().st_mtime)
        try:
            df = pd.read_parquet(latest)
            snapshot_count = df["snapshot_ts"].nunique() if "snapshot_ts" in df.columns else 0
            last_ts = df["snapshot_ts"].max() if "snapshot_ts" in df.columns else None
        except Exception:
            snapshot_count, last_ts = 0, None
        markets.append({
            "market_id": md.name[:20] + "...",
            "snapshot_count_today": int(snapshot_count),
            "last_snapshot_ts": str(last_ts) if last_ts else None,
            "file_mtime": datetime.fromtimestamp(latest.stat().st_mtime).isoformat(),
        })
    markets.sort(key=lambda m: m["file_mtime"] or "", reverse=True)
    return {"status": "ok", "count": len(markets), "items": markets[:30]}


# ---------- Logs ----------

def tail_log_dir(log_dir: Path, max_lines: int = 200) -> list[dict]:
    """Return the last `max_lines` JSONL events across all of today's files."""
    if not log_dir.exists():
        return []
    today = datetime.utcnow().strftime("%Y-%m-%d")
    events: list[dict] = []
    for p in log_dir.glob(f"*-{today}.jsonl"):
        try:
            with p.open() as f:
                for line in f.readlines()[-max_lines:]:
                    try:
                        events.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
        except OSError:
            continue
    events.sort(key=lambda e: e.get("ts", ""))
    return events[-max_lines:]
