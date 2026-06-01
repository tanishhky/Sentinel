"""Sentinel FastAPI server.

Routes:
  GET  /api/health
  GET  /api/pinsight/chain        latest chain snapshot summary
  GET  /api/pinsight/flags        flagged contracts (vol/OI >= 1)
  GET  /api/driftedge/markets     top markets by 24h volume
  GET  /api/driftedge/books       liveness of orderbook polling
  GET  /api/logs/pinsight         today's PinSight events (JSON)
  GET  /api/logs/driftedge        today's DriftEdge events (JSON)
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from . import config as cfg
from . import readers


_STATIC_DIR = Path(__file__).parent / "static"
# Server-process boot timestamp used as cache-buster for static assets.
# Every server restart invalidates the browser cache automatically.
_VERSION = int(time.time())


def create_app() -> FastAPI:
    c = cfg.load()
    app = FastAPI(title="Sentinel", version="0.0.1")

    app.mount("/static", StaticFiles(directory=str(_STATIC_DIR)), name="static")

    @app.get("/", response_class=HTMLResponse)
    def root():
        # Inject ?v=<boot_ts> into static asset URLs so the browser fetches
        # fresh app.js / theme.css after every server restart.
        html = (_STATIC_DIR / "index.html").read_text()
        html = html.replace("/static/theme.css",
                            f"/static/theme.css?v={_VERSION}")
        html = html.replace("/static/app.js",
                            f"/static/app.js?v={_VERSION}")
        return HTMLResponse(content=html, headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        })

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=False,
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    def health():
        return {
            "status": "ok",
            "pinsight_data": str(c.pinsight_data),
            "driftedge_data": str(c.driftedge_data),
            "refresh_ms": c.refresh_ms,
        }

    @app.get("/api/pinsight/chain")
    def pinsight_chain():
        return readers.pinsight_latest_chain(c.pinsight_data)

    @app.get("/api/pinsight/flags")
    def pinsight_flags(top: int = 20):
        return readers.pinsight_flagged_contracts(c.pinsight_data, top=top)

    @app.get("/api/driftedge/markets")
    def driftedge_markets(top: int = 30):
        return readers.driftedge_top_markets(c.driftedge_data, top=top)

    @app.get("/api/driftedge/books")
    def driftedge_books():
        return readers.driftedge_active_books(c.driftedge_data)

    @app.get("/api/driftedge/paper")
    def driftedge_paper():
        return readers.driftedge_paper_trades(c.driftedge_data)

    @app.get("/api/driftedge/paper/equity-history")
    def driftedge_equity_history():
        return readers.driftedge_equity_history(c.driftedge_data)

    @app.get("/api/driftedge/price-distribution")
    def driftedge_price_distribution():
        return readers.driftedge_price_distribution(c.driftedge_data)

    @app.get("/api/sentinel/health")
    def sentinel_health_endpoint():
        return readers.sentinel_health(
            c.pinsight_data, c.pinsight_logs,
            c.driftedge_data, c.driftedge_logs,
            Path("/Users/tanishkyadav/dev/Sentinel/logs"),
        )

    @app.get("/api/driftedge/market/{venue}/{market_id:path}")
    def driftedge_market(venue: str, market_id: str):
        return readers.driftedge_market_detail(c.driftedge_data,
                                                venue, market_id)

    @app.get("/api/driftedge/classifier/review")
    def driftedge_review():
        return readers.driftedge_review_queue(c.driftedge_data)

    @app.get("/api/driftedge/news")
    def driftedge_news(category: Optional[str] = None,
                       sentiment: Optional[str] = None,
                       limit: int = 200):
        return readers.driftedge_news(c.driftedge_data,
                                       category=category,
                                       sentiment=sentiment, limit=limit)

    @app.get("/api/logs/pinsight")
    def logs_pinsight(max_lines: int = 200):
        return {"events": readers.tail_log_dir(c.pinsight_logs, max_lines)}

    @app.get("/api/logs/driftedge")
    def logs_driftedge(max_lines: int = 200):
        return {"events": readers.tail_log_dir(c.driftedge_logs, max_lines)}

    return app


app = create_app()


def main():
    import uvicorn
    c = cfg.load()
    uvicorn.run("sentinel.server:app", host=c.host, port=c.port, log_level="info")


if __name__ == "__main__":
    main()
