"""Sentinel runtime config."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Default to sibling repos checked out alongside Sentinel (../PinSight, ../DriftEdge).
# Override any of these with the matching *_DIR environment variable (see .env.example).
_SIBLINGS = Path(__file__).resolve().parents[4]


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
            str(_SIBLINGS / "PinSight" / "data")
        )).resolve(),
        pinsight_logs=Path(os.getenv(
            "PINSIGHT_LOG_DIR",
            str(_SIBLINGS / "PinSight" / "logs")
        )).resolve(),
        driftedge_data=Path(os.getenv(
            "DRIFTEDGE_DATA_DIR",
            str(_SIBLINGS / "DriftEdge" / "data")
        )).resolve(),
        driftedge_logs=Path(os.getenv(
            "DRIFTEDGE_LOG_DIR",
            str(_SIBLINGS / "DriftEdge" / "logs")
        )).resolve(),
        host=os.getenv("SENTINEL_HOST", "127.0.0.1"),
        port=int(os.getenv("SENTINEL_PORT", "8765")),
        refresh_ms=int(os.getenv("SENTINEL_REFRESH_MS", "5000")),
    )
