"""Sentinel runtime config."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()


@dataclass(frozen=True)
class Config:
    pinsight_data: Path
    pinsight_logs: Path
    driftedge_data: Path
    driftedge_logs: Path
    host: str
    port: int
    refresh_ms: int


def load() -> Config:
    return Config(
        pinsight_data=Path(os.getenv(
            "PINSIGHT_DATA_DIR",
            "/Users/tanishkyadav/dev/PinSight/data"
        )).resolve(),
        pinsight_logs=Path(os.getenv(
            "PINSIGHT_LOG_DIR",
            "/Users/tanishkyadav/dev/PinSight/logs"
        )).resolve(),
        driftedge_data=Path(os.getenv(
            "DRIFTEDGE_DATA_DIR",
            "/Users/tanishkyadav/dev/DriftEdge/data"
        )).resolve(),
        driftedge_logs=Path(os.getenv(
            "DRIFTEDGE_LOG_DIR",
            "/Users/tanishkyadav/dev/DriftEdge/logs"
        )).resolve(),
        host=os.getenv("SENTINEL_HOST", "127.0.0.1"),
        port=int(os.getenv("SENTINEL_PORT", "8765")),
        refresh_ms=int(os.getenv("SENTINEL_REFRESH_MS", "5000")),
    )
