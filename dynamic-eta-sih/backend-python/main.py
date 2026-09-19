"""
backend-python/main.py
=======================
FastAPI application entry point — Phase 3–6: AI Inference + RAG Copilot

PHASE 3 ADDITIONS:
  - Registered ETA router under /api/v1
  - Endpoints: /api/v1/ml/baseline_eta, /api/v1/ml/dynamic_eta,
               /api/v1/ml/all_trains_eta, /api/v1/ml/congestion_snapshot

PHASE 6 ADDITIONS:
  - POST /api/v1/chat — Text-to-SQL RAG chatbot powered by LangChain + Groq
  - Interactive docs: http://localhost:8000/docs (Swagger UI)

HOW TO RUN:
  cd backend-python
  .venv/Scripts/uvicorn main:app --reload --port 8000
"""


import os
import threading
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

from app.core.database import test_connection
from app.api.eta_router import router as eta_router

simulator_thread = None
simulator_error = None


def run_embedded_simulator():
    global simulator_error
    try:
        from app.simulator.generator import main as run_simulator
        run_simulator()
    except Exception as exc:
        simulator_error = str(exc)
        print(f"  [FastAPI] Simulator stopped: {exc}", flush=True)

# =============================================================================
# APP FACTORY
# =============================================================================

app = FastAPI(
    title="Dynamic Train ETA — AI Inference + Copilot API",
    description=(
        "FastAPI microservice for the Dynamic Train ETA Prediction System (SIH 2026).\n\n"
        "**Phase 3** endpoints provide mocked LightGBM baseline ETAs and mocked STGNN "
        "dynamic ETAs (with H3 congestion + anomaly penalties).\n\n"
        "**Phase 6** adds a Text-to-SQL RAG chatbot via LangChain + Groq.\n\n"
        "Run the Python simulator (`generator.py`) alongside this service to see live data."
    ),
    version="0.6.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

# ---------------------------------------------------------------------------
# CORS — allow all origins in dev so the React frontend (any port) can connect
# Tighten this to specific origin(s) before production deployment.
# ---------------------------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # e.g. restrict to ["http://localhost:5173"] for Vite
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# ROUTERS
# ---------------------------------------------------------------------------

# Phase 3: ETA inference endpoints
# Full paths: /api/v1/ml/baseline_eta, /api/v1/ml/dynamic_eta, etc.
app.include_router(eta_router, prefix="/api/v1")


# =============================================================================
# LIFECYCLE EVENTS
# =============================================================================

@app.on_event("startup")
async def startup_event():
    """Verify DB connectivity at boot so failures are caught immediately."""
    ok = test_connection()
    if ok:
        print("  [FastAPI] Connected to PostgreSQL successfully.")
        if os.getenv("ENABLE_SIMULATOR", "false").lower() == "true":
            global simulator_thread
            simulator_thread = threading.Thread(
                target=run_embedded_simulator,
                name="eta-simulator",
                daemon=True,
            )
            simulator_thread.start()
            print("  [FastAPI] Embedded simulator started.")
    else:
        print("  [FastAPI] WARNING: Could not connect to PostgreSQL. Check .env DATABASE_URL.")


# =============================================================================
# UTILITY ENDPOINTS
# =============================================================================

@app.get("/health", tags=["Health"], summary="Liveness probe")
def health_check():
    """
    Liveness probe used by the Node.js API gateway to verify this service is up.
    Returns 200 OK when the FastAPI process is running (regardless of DB state).
    """
    return {
        "status":  "ok",
        "service": "backend-python",
        "version": "0.6.0",
        "phase":   "Phase 6 — ETA Inference + RAG Copilot Active",
        "simulator": {
            "enabled": os.getenv("ENABLE_SIMULATOR", "false").lower() == "true",
            "running": bool(simulator_thread and simulator_thread.is_alive()),
            "error": simulator_error,
        },
        "endpoints": {
            "baseline_eta":       "/api/v1/ml/baseline_eta?train_id=<int>",
            "dynamic_eta":        "/api/v1/ml/dynamic_eta?train_id=<int>",
            "all_trains_eta":     "/api/v1/ml/all_trains_eta",
            "congestion_snapshot":"/api/v1/ml/congestion_snapshot",
            "chat":               "/api/v1/chat  (POST)",
            "docs":               "/docs",
        },
    }


@app.get("/api/v1/trains", tags=["Data"], summary="List all trains (static)")
def list_trains():
    """
    Quick reference — returns the 12 seeded trains without live telemetry.
    Useful for populating dropdowns and search boxes in the frontend.
    """
    from app.core.database import SessionLocal
    from sqlalchemy import text

    with SessionLocal() as session:
        rows = session.execute(
            text("SELECT id, train_no, name, train_type FROM trains ORDER BY id")
        ).fetchall()

    return {
        "count": len(rows),
        "trains": [
            {
                "id":         r.id,
                "train_no":   r.train_no,
                "name":       r.name,
                "train_type": r.train_type,
            }
            for r in rows
        ],
    }


# =============================================================================
# PHASE 6 — AI COPILOT CHAT ENDPOINT
# =============================================================================

class ChatRequest(BaseModel):
    """Request body for the /chat endpoint."""
    query: str


@app.post("/api/v1/chat", tags=["AI Copilot"], summary="Text-to-SQL RAG chatbot")
def chat_endpoint(body: ChatRequest):
    """
    Accept a natural-language question from a station controller and return
    a human-readable answer generated by the LangChain SQL agent.

    Example request body:
        {"query": "Which trains are currently delayed more than 30 minutes?"}

    The agent translates the question into SQL, executes it against the
    read-only PostgreSQL database, and returns a formatted answer.
    """
    from app.rag.agent import ask_copilot

    result = ask_copilot(body.query)

    if result["error"]:
        return {
            "success": False,
            "query":    result["query"],
            "response": f"Sorry, I encountered an error: {result['error']}",
        }

    return {
        "success":  True,
        "query":    result["query"],
        "response": result["response"],
    }
