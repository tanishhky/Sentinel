"""Read PinSight + DriftEdge data into JSON-friendly payloads."""
from __future__ import annotations

import json
from datetime import datetime
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
