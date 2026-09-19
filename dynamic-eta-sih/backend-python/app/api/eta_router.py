"""
backend-python/app/api/eta_router.py
======================================
Phase 3 — FastAPI Router for ETA Endpoints

Mounts under the prefix /api/v1/ml (registered in main.py).

ENDPOINTS:
  GET /api/v1/ml/baseline_eta?train_id=<int>
      → Mocked LightGBM: physics-based ETA (distance ÷ speed + existing delay)

  GET /api/v1/ml/dynamic_eta?train_id=<int>
      → Mocked STGNN: baseline + H3 congestion penalty + anomaly penalty

  GET /api/v1/ml/all_trains_eta
      → Batch: dynamic ETA for every train (used by the live map / dashboard)

  GET /api/v1/ml/congestion_snapshot
      → Returns all H3 cells that currently have ≥2 trains (for Deck.gl heatmap)

RESPONSE FORMAT (GTFS-RT inspired):
  {
    "trip_id":          "TRAIN-12004",
    "train_no":         "12004",
    "train_name":       "New Delhi Rajdhani Express",
    "train_type":       "Rajdhani",
    "current_lat":      28.655,
    "current_lng":      77.327,
    "h3_index":         "873da1ab2ffffff",
    "remaining_km":     210.5,
    "avg_speed_kmh":    130.0,
    "existing_delay_min": 0,
    "travel_time_min":  97.2,
    "total_eta_min":    97.2,
    "expected_arrival": "2026-09-13T18:43:22+00:00",
    "delay_seconds":    0,
    "status":           "ON_TIME",
    "model_used":       "baseline_lgbm_mock",
    "telemetry_age_s":  4.1
  }
"""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session
from sqlalchemy import text
from typing import List
from concurrent.futures import ThreadPoolExecutor

from app.core.database import get_db
from app.models.eta_engine import compute_baseline_eta, compute_dynamic_eta

router = APIRouter(
    prefix="/ml",
    tags=["ETA Inference"],
)


# =============================================================================
# ROUTE 1 — Baseline ETA (Mocked LightGBM)
# =============================================================================

@router.get(
    "/baseline_eta",
    summary="Baseline ETA — Mocked LightGBM",
    description=(
        "Calculates ETA using physics: **remaining_km ÷ avg_speed + existing_delay**. "
        "Represents what a LightGBM model trained on historical schedules would predict "
        "for a train running without any real-time disruptions."
    ),
)
def baseline_eta(
    train_id: int = Query(..., ge=1, description="Database ID of the train (1–12)"),
    db: Session = Depends(get_db),
):
    """
    Returns a GTFS-RT-style JSON payload with the baseline ETA for one train.
    Does NOT check congestion or live events — that's the dynamic endpoint's job.
    """
    result = compute_baseline_eta(db, train_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


# =============================================================================
# ROUTE 2 — Dynamic ETA (Mocked STGNN)
# =============================================================================

@router.get(
    "/dynamic_eta",
    summary="Dynamic ETA — Mocked STGNN (with congestion + anomaly penalties)",
    description=(
        "Augments the baseline ETA with real-time penalties:\n\n"
        "- **Congestion**: counts trains sharing the same H3 hex cell → +15 min/extra train (max +45)\n"
        "- **Weather fog**: active `weather_fog` event → +20 min\n"
        "- **Halt/Signal**: active halt/signal event → +10 min\n\n"
        "This models the 'knock-on delay' logic that a real STGNN would learn from spatial topology."
    ),
)
def dynamic_eta(
    train_id: int = Query(..., ge=1, description="Database ID of the train (1–12)"),
    db: Session = Depends(get_db),
):
    """
    Returns the dynamic ETA for one train including all congestion and event penalties.
    The 'baseline_eta_min' field in the response shows what it would have been without
    penalties, making the penalty contribution transparent.
    """
    result = compute_dynamic_eta(db, train_id)
    if "error" in result:
        raise HTTPException(status_code=404, detail=result["error"])
    return result


# =============================================================================
# ROUTE 3 — All Trains Dynamic ETA (batch, for the live dashboard)
# =============================================================================

@router.get(
    "/all_trains_eta",
    summary="All Trains — Dynamic ETA Batch",
    description=(
        "Returns the dynamic ETA for **all 12 trains** in a single request. "
        "Intended for the React live map and station-master dashboard to initialise their state."
    ),
)
def all_trains_eta(db: Session = Depends(get_db)):
    """
    Iterates over every train in the DB and computes dynamic ETA.
    Trains with errors (e.g. missing telemetry) are included with an error field
    so the frontend can degrade gracefully without a blank screen.
    """
    # Fetch all train IDs in one query instead of N separate calls
    train_rows = db.execute(
        text("SELECT id FROM trains ORDER BY id")
    ).fetchall()

    def calculate(row):
        from app.core.database import SessionLocal

        with SessionLocal() as session:
            return compute_dynamic_eta(session, row.id)

    # Each ETA calculation performs several DB queries. Limited parallelism
    # keeps the free database responsive while avoiding a 25-request queue.
    with ThreadPoolExecutor(max_workers=5) as executor:
        results: List[dict] = list(executor.map(calculate, train_rows))

    return {"count": len(results), "trains": results}


# =============================================================================
# ROUTE 4 — Congestion Snapshot (for Deck.gl H3HexagonLayer)
# =============================================================================

@router.get(
    "/congestion_snapshot",
    summary="H3 Congestion Snapshot — for Deck.gl heatmap",
    description=(
        "Returns every H3 hex cell that currently contains **≥2 trains**, "
        "along with the train count and a severity label. "
        "Feed this directly to the Deck.gl `H3HexagonLayer` on the React frontend."
    ),
)
def congestion_snapshot(db: Session = Depends(get_db)):
    """
    A single aggregation query on live_telemetry grouped by h3_index.
    Severity thresholds mirror the simulator's congestion detection:
      ≥3 trains → HIGH   (red on the map)
      2 trains  → MODERATE (amber)
    """
    rows = db.execute(text("""
        SELECT
            h3_index,
            COUNT(*)          AS train_count,
            ARRAY_AGG(train_id ORDER BY train_id) AS train_ids
        FROM live_telemetry
        WHERE h3_index IS NOT NULL
        GROUP BY h3_index
        HAVING COUNT(*) >= 2
        ORDER BY train_count DESC
    """)).fetchall()

    cells = []
    for row in rows:
        count = int(row.train_count)
        cells.append({
            "h3_index":    row.h3_index,
            "train_count": count,
            "train_ids":   list(row.train_ids),
            "severity":    "HIGH" if count >= 3 else "MODERATE",
        })

    return {
        "snapshot_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "congested_cells": len(cells),
        "cells": cells,
    }
