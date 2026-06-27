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


def pinsight_paper(data_dir: Path) -> dict[str, Any]:
    """PinSight paper trader state + positions (same shape as DriftEdge).

    Schema-tolerant: supports the post-2026-06-03 cost-aware schema
    (entry_fill_price, entry_total_cost_usd, expected_pnl_at_entry_gross,
    peak_market_equity, etc.) AND the legacy pre-fix schema
    (entry_price, entry_size_usd, expected_pnl_at_entry, peak_equity).
    """
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

    def _pick(r, *names):
        """Return the first present + non-null value from a list of column names."""
        for n in names:
            v = r.get(n) if hasattr(r, "get") else (r[n] if n in r else None)
            if v is not None and not (isinstance(v, float) and pd.isna(v)):
                return v
        return None

    def _f(v, default=None):
        """Float-coerce that returns `default` on NaN/Inf so the JSON
        response is always strict-JSON compliant. FastAPI's JSONResponse
        uses json.dumps with allow_nan=False and rejects NaN/Inf with
        500. (Bug fix 2026-06-08.)"""
        if v is None:
            return default
        try:
            f = float(v)
        except (TypeError, ValueError):
            return default
        import math
        if math.isnan(f) or math.isinf(f):
            return default
        return f

    state: dict[str, Any] = {}
    if state_path.exists():
        try:
            st = pd.read_parquet(state_path)
            for _, r in st.iterrows():
                peak = _f(_pick(r, "peak_market_equity", "peak_equity"), 0.0)
                # Prefer the explicit current_market_equity column;
                # fall back to cash+open_exposure (cost basis).
                cur_eq = _f(_pick(r, "current_market_equity"))
                if cur_eq is None:
                    cur_eq = _f(r.get("cash_usd"), 0.0) + _f(r.get("open_exposure"), 0.0)
                state[str(r["trader"])] = {
                    "bankroll_init": _f(r.get("bankroll_init"), 0.0),
                    "cash_usd": round(_f(r.get("cash_usd"), 0.0), 2),
                    "open_exposure": round(_f(r.get("open_exposure"), 0.0), 2),
                    "closed_pnl": round(_f(r.get("closed_pnl"), 0.0), 2),
                    "peak_equity": round(_f(peak, 0.0), 2),
                    "drawdown_pct": round(_f(r.get("current_drawdown_pct"), 0.0), 3),
                    "total_equity": round(_f(cur_eq, 0.0), 2),
                }
        except Exception:
            pass

    open_df = df[df["status"] == "open"]
    closed_df = df[df["status"] != "open"]

    def _row(r) -> dict:
        entry_fill = _pick(r, "entry_fill_price", "entry_price")
        size_usd = _pick(r, "entry_total_cost_usd", "entry_notional_usd",
                          "entry_size_usd")
        exp_pnl = _pick(r, "expected_pnl_at_entry_gross",
                         "expected_pnl_at_entry")
        return {
            "trade_id": r.get("trade_id"),
            "kind": r.get("kind"),
            "strike": float(r["strike"]) if pd.notna(r.get("strike")) else None,
            "ticker": r.get("ticker"),
            "expiry": r.get("expiry"),
            "entry_ts": str(r.get("entry_ts")) if r.get("entry_ts") else None,
            "exit_ts": str(r.get("exit_ts")) if pd.notna(r.get("exit_ts")) else None,
            "entry_price": round(float(entry_fill), 4) if entry_fill is not None else None,
            "entry_mid": (round(float(r["entry_mid"]), 4)
                          if pd.notna(r.get("entry_mid")) else None),
            "exit_price": round(float(r["exit_price"]), 4) if pd.notna(r.get("exit_price")) else None,
            "n_contracts": int(r["n_contracts"]) if pd.notna(r.get("n_contracts")) else None,
            "size_usd": round(float(size_usd), 2) if size_usd is not None else None,
            "entry_commission_usd": (round(float(r["entry_commission_usd"]), 2)
                                       if pd.notna(r.get("entry_commission_usd")) else None),
            "exit_commission_usd": (round(float(r["exit_commission_usd"]), 2)
                                       if pd.notna(r.get("exit_commission_usd")) else None),
            "spot_at_entry": round(float(r["spot_at_entry"]), 2) if pd.notna(r.get("spot_at_entry")) else None,
            "spot_at_exit": round(float(r["spot_at_exit"]), 2) if pd.notna(r.get("spot_at_exit")) else None,
            "fair_at_entry": round(float(r["fair_at_entry"]), 4) if pd.notna(r.get("fair_at_entry")) else None,
            "edge_at_entry": round(float(r["edge_at_entry"]), 3) if pd.notna(r.get("edge_at_entry")) else None,
            "prob_itm_at_entry": round(float(r["prob_itm_at_entry"]), 3) if pd.notna(r.get("prob_itm_at_entry")) else None,
            "expected_pnl_at_entry": round(float(exp_pnl), 3) if exp_pnl is not None else None,
            "status": r.get("status"),
            "exit_reason": r.get("exit_reason"),
            "pnl_usd": round(float(r["pnl_usd"]), 2) if pd.notna(r.get("pnl_usd")) else None,
        }

    summary = {
        "total_trades": len(df),
        "open_count": len(open_df),
        "closed_count": len(closed_df),
        "wins": int((closed_df["pnl_usd"] > 0).sum()) if not closed_df.empty else 0,
        "losses": int((closed_df["pnl_usd"] <= 0).sum()) if not closed_df.empty else 0,
        "hit_rate": (round(float((closed_df["pnl_usd"] > 0).mean()), 3)
                      if not closed_df.empty else None),
        "total_pnl_usd": (round(float(closed_df["pnl_usd"].fillna(0).sum()), 2)
                          if not closed_df.empty else 0.0),
        "by_trader": state,
    }
    return {
        "status": "ok",
        "summary": summary,
        "open": [_row(r) for _, r in open_df.iterrows()],
        "closed": [_row(r) for _, r in closed_df.sort_values(
            "exit_ts", ascending=False).iterrows()],
    }


def pinsight_paper_equity_history(data_dir: Path) -> dict[str, Any]:
    """Schema-tolerant: prefer total_equity_market_usd (post-2026-06-03
    cost-aware schema) and fall back to total_equity_usd (legacy).

    NaN-safe: any malformed row (NaN in every equity column, NaN drawdown,
    etc.) is either repaired with a sensible fallback or dropped. The
    JSON layer rejects NaN, so we must never let one through.
    """
    eq_path = data_dir / "equity_history.parquet"
    if not eq_path.exists():
        return {"status": "no_data"}
    try:
        df = pd.read_parquet(eq_path)
    except Exception as exc:
        return {"status": "error", "err": str(exc)}
    if df.empty:
        return {"status": "no_data"}

    def _isnum(v) -> bool:
        """Truthy iff v is a finite number (not None, not NaN, not Inf)."""
        if v is None:
            return False
        try:
            f = float(v)
        except (TypeError, ValueError):
            return False
        return f == f and f not in (float("inf"), float("-inf"))

    def _num(v, default: float = 0.0) -> float:
        return float(v) if _isnum(v) else float(default)

    def _equity_value(row) -> Optional[float]:
        # Try every equity column in order; first finite value wins.
        for col in ("total_equity_market_usd", "total_equity_usd",
                     "total_equity_fair_usd"):
            v = row.get(col) if hasattr(row, "get") else None
            if _isnum(v):
                return float(v)
        # Last-resort reconstruction: cash + (mtm if finite, else 0).
        cash = row.get("cash_usd")
        if not _isnum(cash):
            return None  # signal: cannot reconstruct this row
        mtm_col = row.get("sum_current_market_value_usd")
        if not _isnum(mtm_col):
            mtm_col = row.get("sum_mtm_market_usd")
        return float(cash) + _num(mtm_col, 0.0)

    series: dict[str, list[dict]] = {}
    dropped = 0
    for trader, grp in df.groupby("trader"):
        grp = grp.sort_values("ts")
        rows: list[dict] = []
        last_good_equity: Optional[float] = None
        for _, r in grp.iterrows():
            eq = _equity_value(r)
            if eq is None:
                # No equity could be derived. Reuse the prior point's
                # equity if we have one; otherwise drop the row entirely.
                if last_good_equity is None:
                    dropped += 1
                    continue
                eq = last_good_equity
            else:
                last_good_equity = eq
            point = {
                "ts": str(r["ts"]),
                "equity": round(eq, 2),
                "drawdown_pct": round(_num(r.get("drawdown_pct"), 0.0), 3),
            }
            # Expose the dual MTM columns when present and finite.
            if _isnum(r.get("sum_mtm_fair_usd")):
                point["mtm_fair_usd"] = round(float(r["sum_mtm_fair_usd"]), 2)
            if _isnum(r.get("sum_mtm_market_usd")):
                point["mtm_market_usd"] = round(float(r["sum_mtm_market_usd"]), 2)
            if _isnum(r.get("total_equity_fair_usd")):
                point["equity_fair"] = round(float(r["total_equity_fair_usd"]), 2)
            rows.append(point)
        series[str(trader)] = rows
    payload: dict[str, Any] = {"status": "ok", "series": series}
    if dropped:
        payload["dropped_rows"] = dropped
    return payload


def pinsight_chain_full(data_dir: Path, top_contracts: int = 30) -> dict[str, Any]:
    """Latest chain with IV-smile series, vol-by-strike aggregates, and a
    top-volume contract list. Drives the CHAIN sub-tab's charts and table.
    """
    chains_root = data_dir / "chains"
    if not chains_root.exists():
        return {"status": "no_data"}

    latest_path: Optional[Path] = None
    latest_mtime = 0.0
    for symbol_dir in chains_root.iterdir():
        if not symbol_dir.is_dir():
            continue
        p = _latest_file(symbol_dir)
        if p and p.stat().st_mtime > latest_mtime:
            latest_path, latest_mtime = p, p.stat().st_mtime
    if latest_path is None:
        return {"status": "no_data"}

    df = pd.read_parquet(latest_path)
    if "_snapshot_ts" in df.columns:
        df = df[df["_snapshot_ts"] == df["_snapshot_ts"].max()]
    if df.empty:
        return {"status": "no_data"}

    spot = float(df["underlying_price"].iloc[0]) if "underlying_price" in df.columns else None
    underlying = latest_path.parent.name
    expiry = latest_path.stem

    # ── IV smile (calls vs puts) ──
    # Filter to a realistic strike window: ±15 % of spot. yfinance returns
    # synthetic IVs in the 2-4 range at deep OTM strikes where there is no
    # real trade; including those compresses the chart axis until the actual
    # smile is invisible.
    lo = spot * 0.85 if spot else 0
    hi = spot * 1.15 if spot else float("inf")
    calls_iv: list[dict] = []
    puts_iv: list[dict] = []
    for _, r in df.iterrows():
        iv = r.get("iv")
        strike = r.get("strike")
        if pd.isna(iv) or pd.isna(strike):
            continue
        s = float(strike)
        v = float(iv)
        if v <= 0 or v >= 2.0 or s < lo or s > hi:
            continue
        point = {"strike": s, "iv": round(v, 5)}
        if r.get("contract_type") == "call":
            calls_iv.append(point)
        elif r.get("contract_type") == "put":
            puts_iv.append(point)
    calls_iv.sort(key=lambda p: p["strike"])
    puts_iv.sort(key=lambda p: p["strike"])

    # ── Vol-by-strike (stacked calls+puts) ──
    vol_rows = (df.groupby(["strike", "contract_type"])["volume"]
                  .sum().unstack(fill_value=0))
    vol_by_strike = []
    for strike in sorted(vol_rows.index):
        vol_by_strike.append({
            "strike": float(strike),
            "call_vol": int(vol_rows.loc[strike].get("call", 0) or 0),
            "put_vol": int(vol_rows.loc[strike].get("put", 0) or 0),
        })

    # ── Top contracts by volume ──
    df = df.sort_values("volume", ascending=False).head(top_contracts)
    contracts = []
    for _, r in df.iterrows():
        contracts.append({
            "ticker": r.get("ticker"),
            "type": r.get("contract_type"),
            "strike": float(r["strike"]) if pd.notna(r.get("strike")) else None,
            "bid": float(r["bid"]) if pd.notna(r.get("bid")) else None,
            "ask": float(r["ask"]) if pd.notna(r.get("ask")) else None,
            "mid": float(r["mid"]) if pd.notna(r.get("mid")) else None,
            "last": float(r["last_price"]) if pd.notna(r.get("last_price")) else None,
            "volume": int(r["volume"]) if pd.notna(r.get("volume")) else 0,
            "open_interest": int(r["open_interest"]) if pd.notna(r.get("open_interest")) else 0,
            "iv": round(float(r["iv"]), 4) if pd.notna(r.get("iv")) else None,
            "itm": bool(r.get("in_the_money")) if pd.notna(r.get("in_the_money")) else None,
        })

    return {
        "status": "ok",
        "underlying": underlying,
        "expiry": expiry,
        "spot": spot,
        "snapshot_ts": str(df["_snapshot_ts"].max()) if "_snapshot_ts" in df.columns else None,
        "smile": {"calls": calls_iv, "puts": puts_iv},
        "vol_by_strike": vol_by_strike,
        "contracts": contracts,
    }


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
                    # Cost-basis equity (kept for backwards-compat consumers
                    # — frontend uses `total_equity` below which now
                    # prefers MTM).
                    "total_equity_cost_basis": round(
                        float(r["cash_usd"]) + float(r["open_exposure"]), 2),
                    "peak_equity": round(float(r["peak_equity"]), 2),
                    "drawdown_pct": round(float(r["current_drawdown_pct"]), 3),
                }
        except Exception:
            pass

    # ── MTM equity from the latest equity_history row per trader ──
    # Bug 5 fix (2026-06-05): the dashboard's `return_pct` was previously
    # computed from cost-basis equity, which equals bankroll_init +
    # closed_pnl — i.e., displayed return excluded unrealized MTM. Sourcing
    # equity from equity_history.parquet gives the user the real total.
    equity_path = data_dir / "equity_history.parquet"
    mtm_equity_by_trader: dict[str, float] = {}
    if equity_path.exists():
        try:
            eq = pd.read_parquet(equity_path)
            if not eq.empty and "trader" in eq.columns and "ts" in eq.columns:
                eq = eq.sort_values("ts")
                # Prefer the new MTM column; fall back to legacy name.
                eq_col = ("total_equity_market_usd"
                          if "total_equity_market_usd" in eq.columns
                          else ("total_equity_usd"
                                if "total_equity_usd" in eq.columns else None))
                if eq_col is not None:
                    latest = eq.groupby("trader").tail(1)
                    for _, r in latest.iterrows():
                        v = r[eq_col]
                        if pd.notna(v):
                            mtm_equity_by_trader[str(r["trader"])] = round(float(v), 2)
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
        bankroll = state.get("bankroll_init")
        # Prefer MTM equity for the headline total_equity / return_pct.
        # Falls back to cost-basis if equity_history has no row yet.
        mtm_equity = mtm_equity_by_trader.get(t)
        cost_equity = state.get("total_equity_cost_basis")
        total_equity = mtm_equity if mtm_equity is not None else cost_equity
        by_trader[t] = {
            **state,
            "total_equity": total_equity,
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
                round((total_equity / bankroll - 1) * 100, 3)
                if (total_equity is not None and bankroll) else None
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
    """Per-trader equity time series.

    Primary source: ``equity_history.parquet`` (continuous MTM written every
    paper-engine tick). Falls back to reconstructing from ``paper_trades``
    + a live-mid extrapolation when the new file isn't there yet.
    """
    equity_path = data_dir / "equity_history.parquet"
    state_path = data_dir / "paper_state.parquet"

    # ── Primary path: continuous MTM file written by paper.tick ──
    if equity_path.exists():
        try:
            edf = pd.read_parquet(equity_path)
        except Exception as exc:
            return {"status": "error", "err": str(exc)}
        if not edf.empty and "trader" in edf.columns:
            bankrolls: dict[str, float] = {}
            if state_path.exists():
                try:
                    st = pd.read_parquet(state_path)
                    for _, r in st.iterrows():
                        bankrolls[str(r["trader"])] = float(r["bankroll_init"])
                except Exception:
                    pass

            # Build per-trader cumulative-deployed lookup from closed trades.
            # cum_deployed_usd at time T = sum(entry_size_usd) for trades that
            # closed on or before T. Used by the "% Deployed" returns metric:
            # return = closed_pnl / cum_deployed (excludes open positions).
            import bisect as _bisect

            cum_dep_lookups: dict[str, list[tuple[float, float]]] = {}
            trades_path = data_dir / "paper_trades.parquet"
            if trades_path.exists():
                try:
                    tdf = pd.read_parquet(trades_path)
                    closed_tdf = tdf[
                        (tdf["status"] != "open") & tdf["exit_ts"].notna()
                    ].copy()
                    if not closed_tdf.empty and "trader" in closed_tdf.columns:
                        closed_tdf["entry_size_usd"] = (
                            closed_tdf["entry_size_usd"].fillna(0.0))
                        for tid, grp_t in closed_tdf.groupby("trader"):
                            grp_t = grp_t.sort_values("exit_ts")
                            grp_t["cum"] = grp_t["entry_size_usd"].cumsum()
                            pts: list[tuple[float, float]] = []
                            for _, tr in grp_t.iterrows():
                                try:
                                    ep = pd.Timestamp(tr["exit_ts"]).timestamp()
                                    pts.append((ep, float(tr["cum"])))
                                except Exception:
                                    pass
                            cum_dep_lookups[str(tid)] = pts
                except Exception:
                    pass

            def _cum_dep_at(lookup: list, ts_val) -> float:
                if not lookup:
                    return 0.0
                try:
                    ep = pd.Timestamp(ts_val).timestamp()
                except Exception:
                    return 0.0
                idx = _bisect.bisect_right([p[0] for p in lookup], ep) - 1
                return lookup[idx][1] if idx >= 0 else 0.0

            series: dict[str, list[dict[str, Any]]] = {}
            for trader, grp in edf.groupby("trader"):
                grp = grp.sort_values("ts")
                lookup = cum_dep_lookups.get(str(trader), [])
                series[str(trader)] = [
                    {"ts": str(r["ts"]),
                     "equity": round(float(r["total_equity_usd"]), 2),
                     "cash": round(float(r["cash_usd"]), 2),
                     "exposure": round(float(r["open_exposure_usd"]), 2),
                     "closed_pnl": round(float(r["closed_pnl_usd"]), 2),
                     "cum_deployed_usd": round(_cum_dep_at(lookup, r["ts"]), 2),
                     "drawdown_pct": round(float(r["drawdown_pct"]), 3),
                     "mtm": round(float(r["mtm_unrealized_usd"]), 2)}
                    for _, r in grp.iterrows()
                ]
            return {"status": "ok", "series": series,
                    "bankrolls": bankrolls or {"kelly": 10000, "equal": 10000,
                                               "volwt": 10000, "volharvest": 10000,
                                               "resolution": 10000},
                    "source": "equity_history"}

    # ── Fallback: reconstruct from trades when no equity_history yet ──
    trades_path = data_dir / "paper_trades.parquet"
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


_NEWS_OVERRIDES_FILE = "news_overrides.parquet"


def _load_news_overrides(data_dir: Path) -> dict[str, str]:
    p = data_dir / _NEWS_OVERRIDES_FILE
    if not p.exists():
        return {}
    try:
        df = pd.read_parquet(p)
        return {str(r["id"]): str(r["sentiment_label"]) for _, r in df.iterrows()}
    except Exception:
        return {}


def write_news_override(data_dir: Path, news_id: str, sentiment_label: str) -> dict:
    """Persist a manual sentiment override. The reader merges these on next load."""
    assert sentiment_label in {"positive", "negative", "neutral"}, \
        f"invalid sentiment_label: {sentiment_label}"
    p = data_dir / _NEWS_OVERRIDES_FILE
    overrides = _load_news_overrides(data_dir)
    overrides[news_id] = sentiment_label
    rows = [{"id": k, "sentiment_label": v,
             "overridden_ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}
            for k, v in overrides.items()]
    df = pd.DataFrame(rows)
    data_dir.mkdir(parents=True, exist_ok=True)
    df.to_parquet(p, compression="snappy", index=False)
    return {"status": "ok", "id": news_id, "sentiment_label": sentiment_label,
            "total_overrides": len(overrides)}


def driftedge_news(data_dir: Path, *, category: Optional[str] = None,
                   sentiment: Optional[str] = None,
                   limit: int = 200) -> dict[str, Any]:
    """Latest news items (Bloomberg-style headline + source + sentiment).

    Returns two stat blocks:
      * stats_global   — counts across the full multi-day pull (drives the
                         filter dropdowns and the "total" baseline)
      * stats_filtered — counts within the active filter (drives the
                         Positive / Negative / Neutral KPI tiles)
    """
    news_dir = data_dir / "news"
    if not news_dir.exists():
        return {"status": "no_data", "items": [], "stats_global": {}, "stats_filtered": {}}
    files = sorted(news_dir.glob("*.parquet"),
                   key=lambda p: p.stat().st_mtime, reverse=True)[:3]
    if not files:
        return {"status": "no_data", "items": [], "stats_global": {}, "stats_filtered": {}}

    dfs = []
    for p in files:
        try:
            dfs.append(pd.read_parquet(p))
        except Exception:
            continue
    if not dfs:
        return {"status": "no_data", "items": [], "stats_global": {}, "stats_filtered": {}}
    full = pd.concat(dfs, ignore_index=True).drop_duplicates(
        subset=["id"], keep="first")

    # ── Merge manual overrides (re-label sentiment, but keep raw score) ──
    overrides = _load_news_overrides(data_dir)
    if overrides:
        full = full.copy()
        full["_override"] = full["id"].astype(str).map(overrides)
        mask = full["_override"].notna()
        full.loc[mask, "sentiment_label"] = full.loc[mask, "_override"]
        full["overridden"] = mask

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
            "overridden": bool(r.get("overridden", False)),
        })

    # Filtered stats power the KPI tiles. We apply the category filter (but
    # not the sentiment filter — otherwise the +/−/■ breakdown collapses to
    # one bucket and the comparison stops being useful).
    df_for_kpi = full[full["category"] == category] if category else full

    stats_global = {
        "total": len(full),
        "by_sentiment": full["sentiment_label"].value_counts().to_dict(),
        "by_category": full["category"].value_counts().to_dict(),
        "by_source": full["source"].value_counts().head(15).to_dict(),
        "files_loaded": [p.name for p in files],
        "override_count": int(full.get("overridden", pd.Series(dtype=bool)).sum())
                          if "overridden" in full.columns else 0,
    }
    stats_filtered = {
        "total": len(df_for_kpi),
        "by_sentiment": df_for_kpi["sentiment_label"].value_counts().to_dict(),
    }

    return {"status": "ok", "items": items,
            "stats_global": stats_global,
            "stats_filtered": stats_filtered,
            # Keep `stats` for backward compatibility with anything reading the
            # old shape.
            "stats": stats_global}


def _sharpe(returns: pd.Series, periods_per_year: float = 365 * 24 * 12) -> Optional[float]:
    """Naive annualised Sharpe. periods_per_year defaults to 5-min ticks.

    The exact annualisation factor is approximate (depends on actual tick
    cadence) but it's stable across traders so cross-trader comparison is
    meaningful even if the absolute value is fuzzy.
    """
    if returns.empty or returns.std(ddof=0) == 0:
        return None
    return round(float(returns.mean() / returns.std(ddof=0) * (periods_per_year ** 0.5)), 3)


def _sortino(returns: pd.Series, periods_per_year: float = 365 * 24 * 12) -> Optional[float]:
    if returns.empty:
        return None
    downside = returns[returns < 0]
    if downside.empty or downside.std(ddof=0) == 0:
        return None
    return round(float(returns.mean() / downside.std(ddof=0) * (periods_per_year ** 0.5)), 3)


def _moments(values: list[float]) -> dict[str, Optional[float]]:
    """Mean / std / skew / kurtosis. Returns None when undefined."""
    if len(values) < 2:
        return {"mean": (round(values[0], 4) if values else None),
                "std": None, "skew": None, "kurtosis": None,
                "min": (values[0] if values else None),
                "max": (values[0] if values else None)}
    s = pd.Series(values, dtype=float)
    return {
        "mean": round(float(s.mean()), 4),
        "std": round(float(s.std(ddof=0)), 4),
        "skew": (round(float(s.skew()), 4) if len(s) >= 3 else None),
        "kurtosis": (round(float(s.kurt()), 4) if len(s) >= 4 else None),
        "min": round(float(s.min()), 4),
        "max": round(float(s.max()), 4),
    }


def driftedge_risk_stats(data_dir: Path) -> dict[str, Any]:
    """Per-trader risk panel: drawdown, Sharpe, win rate, profit factor.

    Drawdown / Sharpe / Sortino derive from ``equity_history.parquet`` (the
    continuous MTM record). Hit rate / profit factor / avg-win / avg-loss
    derive from realized trades in ``paper_trades.parquet``.
    """
    equity_path = data_dir / "equity_history.parquet"
    trades_path = data_dir / "paper_trades.parquet"

    out_by_trader: dict[str, dict[str, Any]] = {}

    eq: pd.DataFrame = pd.DataFrame()
    if equity_path.exists():
        try:
            eq = pd.read_parquet(equity_path)
        except Exception:
            eq = pd.DataFrame()

    trades: pd.DataFrame = pd.DataFrame()
    if trades_path.exists():
        try:
            trades = pd.read_parquet(trades_path)
        except Exception:
            trades = pd.DataFrame()

    traders = set()
    if not eq.empty and "trader" in eq.columns:
        traders.update(eq["trader"].dropna().unique())
    if not trades.empty and "trader" in trades.columns:
        traders.update(trades["trader"].dropna().unique())

    for trader in sorted(traders):
        row: dict[str, Any] = {"trader": trader}

        # ── Equity-derived metrics ──
        if not eq.empty:
            grp = eq[eq["trader"] == trader].sort_values("ts").copy()
            if not grp.empty:
                grp["ret"] = grp["total_equity_usd"].pct_change().fillna(0.0)
                peak = grp["total_equity_usd"].cummax()
                dd = (peak - grp["total_equity_usd"]) / peak.replace(0, float("nan"))
                row.update({
                    "snapshots": int(len(grp)),
                    "first_ts": str(grp["ts"].iloc[0]),
                    "last_ts": str(grp["ts"].iloc[-1]),
                    "start_equity": round(float(grp["total_equity_usd"].iloc[0]), 2),
                    "current_equity": round(float(grp["total_equity_usd"].iloc[-1]), 2),
                    "peak_equity": round(float(grp["peak_equity_usd"].iloc[-1]), 2),
                    "current_drawdown_pct": round(float(grp["drawdown_pct"].iloc[-1]), 3),
                    "max_drawdown_pct": round(float(dd.max() * 100), 3) if not dd.empty else None,
                    "total_return_pct": round(
                        (float(grp["total_equity_usd"].iloc[-1])
                         / float(grp["total_equity_usd"].iloc[0]) - 1) * 100, 3),
                    "sharpe": _sharpe(grp["ret"]),
                    "sortino": _sortino(grp["ret"]),
                    "vol_pct": round(float(grp["ret"].std(ddof=0) * 100), 4),
                })

        # ── Trade-derived metrics ──
        if not trades.empty:
            t_df = trades[trades["trader"] == trader]
            t_closed = t_df[t_df["status"] != "open"] if not t_df.empty else t_df
            if not t_closed.empty:
                pnl = t_closed["pnl_usd"].fillna(0)
                wins = pnl[pnl > 0]
                losses = pnl[pnl < 0]
                row.update({
                    "closed_trades": int(len(t_closed)),
                    "wins": int(len(wins)),
                    "losses": int(len(losses)),
                    "hit_rate": (round(float(len(wins) / len(t_closed)), 4)
                                  if len(t_closed) else None),
                    "avg_win_usd": round(float(wins.mean()), 4) if not wins.empty else 0.0,
                    "avg_loss_usd": round(float(losses.mean()), 4) if not losses.empty else 0.0,
                    "profit_factor": (round(float(wins.sum() / abs(losses.sum())), 3)
                                       if not losses.empty and losses.sum() != 0 else None),
                    "total_realized_pnl_usd": round(float(pnl.sum()), 2),
                })

        out_by_trader[trader] = row

    return {"status": "ok" if out_by_trader else "no_data",
            "by_trader": out_by_trader,
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def driftedge_pnl_distribution(data_dir: Path, *,
                                trader: Optional[str] = None,
                                venue: Optional[str] = None,
                                market_id: Optional[str] = None,
                                bins: int = 25) -> dict[str, Any]:
    """Histogram + moments of realized P&L.

    Filters:
      * trader      — restrict to one paper trader
      * venue       — restrict to one venue
      * market_id   — restrict to a single market (used by the modal)

    Returns histogram bin edges + counts plus (mean, std, skew, kurtosis,
    min, max) so the UI can render a chart AND a one-line normality
    diagnostic.
    """
    trades_path = data_dir / "paper_trades.parquet"
    if not trades_path.exists():
        return {"status": "no_data"}
    try:
        df = pd.read_parquet(trades_path)
    except Exception as exc:
        return {"status": "error", "err": str(exc)}
    if df.empty:
        return {"status": "no_data"}

    df = df[df["status"] != "open"]
    if trader:
        df = df[df["trader"] == trader]
    if venue:
        df = df[df.get("venue") == venue]
    if market_id:
        df = df[df.get("market_id") == market_id]

    pnls = df["pnl_usd"].dropna().astype(float).tolist()
    if not pnls:
        return {"status": "no_data", "filter": {"trader": trader,
                                                  "venue": venue,
                                                  "market_id": market_id}}

    # Symmetric bins around zero so normality is visually obvious.
    bound = max(abs(min(pnls)), abs(max(pnls)), 1e-6)
    step = (2 * bound) / bins
    edges = [round(-bound + i * step, 4) for i in range(bins + 1)]
    counts = [0] * bins
    for v in pnls:
        idx = min(int((v + bound) / step), bins - 1) if step > 0 else 0
        if idx < 0:
            idx = 0
        counts[idx] += 1

    moments = _moments(pnls)
    return {
        "status": "ok",
        "filter": {"trader": trader, "venue": venue, "market_id": market_id},
        "n": len(pnls),
        "bins": edges,
        "counts": counts,
        "moments": moments,
        "positive_share": round(sum(1 for v in pnls if v > 0) / len(pnls), 4),
        "negative_share": round(sum(1 for v in pnls if v < 0) / len(pnls), 4),
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
