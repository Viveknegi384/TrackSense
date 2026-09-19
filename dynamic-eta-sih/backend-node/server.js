/**
 * backend-node/server.js
 * ========================
 * Phase 4 — Client API & WebSocket Gateway
 *
 * ROLE IN ARCHITECTURE:
 *   This Node.js service sits between the data layer and the React frontend.
 *   It does three jobs:
 *     1. REST API  — Express endpoints that the frontend fetches on initial load.
 *     2. Poller    — Every POLL_INTERVAL_MS it reads live_telemetry from PostgreSQL
 *                    AND calls the Python FastAPI for dynamic ETA on each train.
 *     3. Pusher    — Broadcasts the combined payload via Socket.io to all
 *                    connected React clients ("train_updates" event).
 *
 * ENDPOINTS:
 *   GET  /health                → liveness probe
 *   GET  /api/trains            → all 12 trains with latest live telemetry (from DB)
 *   GET  /api/trains/:id/eta    → dynamic ETA for one train (proxies to FastAPI)
 *   GET  /api/stations          → all 11 stations (static, from DB)
 *   GET  /api/congestion        → current H3 congestion cells (proxies to FastAPI)
 *
 * WEBSOCKET EVENTS EMITTED (server → client):
 *   "train_updates"    → array of 12 train payloads (location + dynamic ETA)
 *   "server_error"     → emitted when polling encounters a recoverable error
 *
 * HOW TO RUN:
 *   cd backend-node
 *   npm install
 *   npm run dev   (nodemon, auto-restart on change)
 *   npm start     (plain node, for demo)
 */

"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const axios = require("axios");
const { Pool } = require("pg");
require("dotenv").config();

// =============================================================================
// CONFIG
// =============================================================================

const PORT = parseInt(process.env.PORT || "5000", 10);
const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "5000", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// =============================================================================
// POSTGRESQL CONNECTION POOL
// Uses the same DB as the Python services — read-only queries only here.
// pool_max=5 keeps connection count low since we're just polling.
// =============================================================================

const pool = new Pool({
  ...(process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.PG_HOST || "localhost",
        port: parseInt(process.env.PG_PORT || "5432", 10),
        database: process.env.PG_DATABASE || "eta_sih_db",
        user: process.env.PG_USER || "postgres",
        password: process.env.PG_PASSWORD || "",
      }),
  max: 5,
  ssl: {
    rejectUnauthorized: false,
  },
  // If a query takes >10s something is seriously wrong — fail fast.
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
});

// Prevent transient idle-client disconnects from crashing the gateway.
pool.on("error", (err) => {
  console.error("[DB] PostgreSQL pool error:", err.message);
});

// Test DB connectivity on startup
pool.connect()
  .then(client => {
    console.log("[DB] Connected to PostgreSQL successfully.");
    client.release();
  })
  .catch(err => {
    console.error("[DB] WARNING: Could not connect to PostgreSQL:", err.message);
    console.error("     Check PG_HOST / PG_PASSWORD in .env");
  });

// =============================================================================
// EXPRESS + SOCKET.IO SETUP
// =============================================================================

const app = express();
const server = http.createServer(app);

// Socket.io — attach to the same HTTP server so we don't need a separate port.
const io = new Server(server, {
  cors: {
    origin: CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
  // Reconnection is handled client-side; server just sets ping timeout.
  pingTimeout: 60_000,
  pingInterval: 25_000,
});

// CORS for REST endpoints
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

// =============================================================================
// DB QUERY HELPERS
// =============================================================================

/**
 * Fetch all trains joined with their latest live_telemetry row.
 * Returns the raw location data — ETA fields come from FastAPI.
 */
async function dbFetchAllTrainsWithTelemetry() {
  const { rows } = await pool.query(`
    SELECT
      t.id                                  AS train_id,
      t.train_no,
      t.name                                AS train_name,
      t.train_type,
      lt.current_lat,
      lt.current_lng,
      lt.current_speed,
      lt.delay_minutes,
      lt.h3_index,
      lt.recorded_at
    FROM trains t
    LEFT JOIN live_telemetry lt ON lt.train_id = t.id
    ORDER BY t.id
  `);
  return rows;
}

/**
 * Fetch all stations — purely static, rarely changes.
 */
async function dbFetchAllStations() {
  const { rows } = await pool.query(
    "SELECT id, name, code, lat, lng FROM stations ORDER BY id"
  );
  return rows;
}

// =============================================================================
// PYTHON FASTAPI PROXY HELPERS
// =============================================================================

/**
 * Fetch dynamic ETA for a single train from the Python FastAPI service.
 * Returns the FastAPI JSON payload, or a stub error object on failure so
 * the polling loop can continue gracefully (never crash on a single-train fail).
 */
async function fetchDynamicETA(trainId) {
  try {
    const res = await axios.get(`${PYTHON_API_URL}/api/v1/ml/dynamic_eta`, {
      params: { train_id: trainId },
      timeout: 4000,  // 4s timeout — must be < POLL_INTERVAL_MS
    });
    return res.data;
  } catch (err) {
    // Return a stub so the frontend still gets location data even if ETA fails
    return {
      error: true,
      trip_id: `TRAIN-${trainId}`,
      status: "UNKNOWN",
      total_eta_min: null,
      expected_arrival: null,
      delay_seconds: null,
    };
  }
}

/**
 * Fetch the full congestion snapshot from FastAPI.
 * Used by both the REST endpoint and the WebSocket poller.
 */
async function fetchCongestionSnapshot() {
  try {
    const res = await axios.get(`${PYTHON_API_URL}/api/v1/ml/congestion_snapshot`, {
      timeout: 4000,
    });
    return res.data;
  } catch (err) {
    return { error: true, congested_cells: 0, cells: [] };
  }
}

async function fetchAllDynamicETAs() {
  try {
    const res = await axios.get(`${PYTHON_API_URL}/api/v1/ml/all_trains_eta`, {
      timeout: 30_000,
    });
    return new Map(
      (res.data.trains || []).map(eta => [String(eta.train_no), eta])
    );
  } catch (err) {
    console.error("[ETA] Batch request failed:", err.message);
    return new Map();
  }
}

// =============================================================================
// CORE POLLER — runs every POLL_INTERVAL_MS
// This is the heart of Phase 4: reads DB, fetches ETAs, broadcasts to clients.
// =============================================================================

/**
 * pollAndBroadcast()
 *
 * Steps:
 *   1. Read all 12 trains + their live positions from PostgreSQL.
 *   2. For each train, call FastAPI /dynamic_eta in parallel (Promise.all).
 *   3. Merge the DB row (location) with the FastAPI row (ETA / penalties).
 *   4. Emit "train_updates" via Socket.io to every connected React client.
 *
 * Error handling: any single-train failure is caught inside fetchDynamicETA().
 * If the DB itself is down we catch it here and emit "server_error" instead
 * of crashing the process.
 */
async function pollAndBroadcast() {
  // Skip if no clients are connected — saves DB + API calls
  if (io.engine.clientsCount === 0) return;
  if (pollInFlight) return;
  pollInFlight = true;

  try {
    // Step 1 — Fetch fresh positions from PostgreSQL
    const trains = await dbFetchAllTrainsWithTelemetry();

    // Step 2 — Fetch all dynamic ETAs in one request to avoid free-tier overload
    const etaResults = await fetchAllDynamicETAs();

    // Step 3 — Merge location + ETA into one payload per train
    const payload = trains.map((train) => {
      const eta = etaResults.get(String(train.train_no)) || {
        error: true,
        status: "UNKNOWN",
      };
      return {
        // Identity
        train_id: train.train_id,
        train_no: train.train_no,
        train_name: train.train_name,
        train_type: train.train_type,
        // Live location (from PostgreSQL)
        current_lat: parseFloat(train.current_lat),
        current_lng: parseFloat(train.current_lng),
        current_speed: parseFloat(train.current_speed || 0),
        delay_minutes: parseInt(train.delay_minutes || 0, 10),
        h3_index: train.h3_index,
        recorded_at: train.recorded_at,
        // Dynamic ETA (from FastAPI — may be null if FastAPI is down)
        total_eta_min: eta.total_eta_min ?? null,
        expected_arrival: eta.expected_arrival ?? null,
        delay_seconds: eta.delay_seconds ?? null,
        status: eta.status ?? "UNKNOWN",
        remaining_km: eta.remaining_km ?? null,
        congestion_count: eta.congestion_count ?? null,
        congestion_penalty_min: eta.congestion_penalty_min ?? null,
        anomaly_event: eta.anomaly_event ?? null,
        anomaly_penalty_min: eta.anomaly_penalty_min ?? null,
        model_used: eta.model_used ?? null,
        // Handy flag for the frontend to show a warning badge
        eta_available: !eta.error,
      };
    });

    // Step 4 — Broadcast to all connected React clients
    io.emit("train_updates", {
      timestamp: new Date().toISOString(),
      train_count: payload.length,
      trains: payload,
    });

  } catch (err) {
    // DB or network failure — tell clients something went wrong but don't crash
    console.error("[Poller] Error during poll cycle:", err.message);
    io.emit("server_error", {
      timestamp: new Date().toISOString(),
      message: "Node.js gateway poll failed — retrying next interval.",
    });
  } finally {
    pollInFlight = false;
  }
}

// Start the polling loop after a short delay (let DB pool warm up)
let pollerHandle = null;
let pollInFlight = false;

function startPoller() {
  if (pollerHandle) return;  // already running
  console.log(`[Poller] Starting — interval: ${POLL_INTERVAL_MS}ms`);
  pollerHandle = setInterval(pollAndBroadcast, POLL_INTERVAL_MS);
}

// =============================================================================
// SOCKET.IO EVENT HANDLERS
// =============================================================================

io.on("connection", (socket) => {
  console.log(`[WS] Client connected: ${socket.id} (total: ${io.engine.clientsCount})`);

  // Send a single immediate update on connect so the map isn't blank
  // while waiting for the first poll interval to fire.
  pollAndBroadcast().catch(err =>
    console.error("[WS] Initial push failed:", err.message)
  );

  socket.on("disconnect", (reason) => {
    console.log(`[WS] Client disconnected: ${socket.id} (reason: ${reason})`);
  });

  // Allow the frontend to request a fresh snapshot on demand
  // (e.g., after the user manually triggers an anomaly injection)
  socket.on("request_refresh", async () => {
    console.log(`[WS] Manual refresh requested by ${socket.id}`);
    await pollAndBroadcast();
  });
});

// =============================================================================
// REST ENDPOINTS
// =============================================================================

/** Liveness probe — used by Docker healthchecks or the Python service itself. */
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "backend-node",
    version: "1.0.0",
    phase: "Phase 4 — WebSocket Gateway Active",
    port: PORT,
    python_api: PYTHON_API_URL,
    poll_interval_ms: POLL_INTERVAL_MS,
  });
});

/**
 * GET /api/trains
 * Returns all trains with their live telemetry from PostgreSQL.
 * The React frontend calls this once on mount to initialise its state;
 * subsequent updates come via the "train_updates" WebSocket event.
 */
app.get("/api/trains", async (req, res) => {
  try {
    const trains = await dbFetchAllTrainsWithTelemetry();
    res.json({ count: trains.length, trains });
  } catch (err) {
    console.error("[REST] GET /api/trains failed:", err.message);
    res.status(500).json({ error: "Failed to fetch train data from database." });
  }
});

/**
 * GET /api/trains/:id/eta
 * Returns dynamic ETA for a single train by its database ID.
 * Proxies to the Python FastAPI /api/v1/ml/dynamic_eta endpoint.
 * Used by the Passenger App search flow (Phase 5).
 */
app.get("/api/trains/:id/eta", async (req, res) => {
  const trainId = parseInt(req.params.id, 10);
  if (isNaN(trainId) || trainId < 1) {
    return res.status(400).json({ error: "train id must be a positive integer." });
  }
  try {
    const eta = await fetchDynamicETA(trainId);
    if (eta.error) {
      return res.status(503).json({
        error: "Python ETA service unavailable — is FastAPI running on port 8000?",
      });
    }
    res.json(eta);
  } catch (err) {
    console.error(`[REST] GET /api/trains/${trainId}/eta failed:`, err.message);
    res.status(500).json({ error: "Internal server error fetching ETA." });
  }
});

/**
 * GET /api/stations
 * Returns all 11 stations.  Purely static — used for map markers and dropdowns.
 */
app.get("/api/stations", async (req, res) => {
  try {
    const stations = await dbFetchAllStations();
    res.json({ count: stations.length, stations });
  } catch (err) {
    console.error("[REST] GET /api/stations failed:", err.message);
    res.status(500).json({ error: "Failed to fetch station data from database." });
  }
});

/**
 * GET /api/congestion
 * Returns the current H3 congestion snapshot from FastAPI.
 * Used by the Controller Map to colour the Deck.gl H3HexagonLayer.
 */
app.get("/api/congestion", async (req, res) => {
  try {
    const snapshot = await fetchCongestionSnapshot();
    res.json(snapshot);
  } catch (err) {
    console.error("[REST] GET /api/congestion failed:", err.message);
    res.status(500).json({ error: "Failed to fetch congestion snapshot." });
  }
});

/**
 * GET /api/routes/corridors
 * Returns the ordered station waypoints for each of the 3 rail corridors,
 * read directly from the routes + stations tables.
 *
 * This is the ground-truth geometry the Python simulator uses to move trains.
 * The frontend PathLayer consumes this so tracks are ALWAYS perfectly aligned
 * with train positions — no hardcoded coordinates that can drift.
 *
 * One representative train per corridor is used (all trains on the same
 * corridor share identical station sequences):
 *   train_id = 1  →  North Corridor  (NDLS → GZB → ALJN → TDL → CNB)
 *   train_id = 5  →  SW Corridor     (CSTM → JHS → BAND → CNB)
 *   train_id = 9  →  East Corridor   (HWH  → PRYJ → FTP → CNB)
 */
app.get("/api/routes/corridors", async (req, res) => {
  try {
    const sql = `
      SELECT
        r.train_id,
        r.station_sequence,
        s.code,
        s.name,
        CAST(s.lat AS FLOAT) AS lat,
        CAST(s.lng AS FLOAT) AS lng
      FROM routes r
      JOIN stations s ON s.id = r.station_id
      WHERE r.train_id IN (1, 6, 11, 16, 21)
      ORDER BY r.train_id, r.station_sequence
    `;
    const { rows } = await pool.query(sql);

    // corridor metadata (colour is consumed by the frontend)
    const meta = {
      1: { name: "North Corridor (NDLS → CNB)", color: [30, 64, 175, 220] },
      6: { name: "West Corridor (CSTM → JHS)", color: [126, 34, 206, 220] },
      11: { name: "East Corridor (HWH → PRYJ)", color: [5, 150, 105, 220] },
      16: { name: "South Corridor (NGP → CNB)", color: [220, 38, 38, 220] },
      21: { name: "Central Corridor (LKO → PRYJ)", color: [217, 119, 6, 220] },
    };

    // Group rows by train_id (= one corridor per train_id)
    const grouped = {};
    rows.forEach(row => {
      if (!grouped[row.train_id]) {
        grouped[row.train_id] = {
          ...meta[row.train_id],
          corridor_id: Number(row.train_id),
          stations: [],
        };
      }
      grouped[row.train_id].stations.push({
        code: row.code,
        name: row.name,
        lat: row.lat,
        lng: row.lng,
        sequence: row.station_sequence,
      });
    });

    const corridors = Object.values(grouped).sort((a, b) => a.corridor_id - b.corridor_id);
    res.json({ count: corridors.length, corridors });

  } catch (err) {
    console.error("[REST] GET /api/routes/corridors failed:", err.message);
    res.status(500).json({ error: "Failed to fetch route corridor data." });
  }
});


// =============================================================================
// DEMO RESET ENDPOINT
// Truncates live_telemetry + events_log and re-seeds starting positions.
// Called by the frontend "Refresh" / "Reset Demo" button.
// =============================================================================

app.post("/api/reset-demo", async (req, res) => {
  console.log("[Reset] Demo reset requested — re-seeding telemetry…");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Clear live data
    await client.query("TRUNCATE TABLE events_log RESTART IDENTITY CASCADE");
    await client.query("TRUNCATE TABLE live_telemetry RESTART IDENTITY CASCADE");

    // Re-insert seed positions (matches seed_telemetry.sql exactly)
    const seeds = [
      // Route 1 (NDLS -> CNB)
      [1, 28.6418, 77.2171, 130.00, 0, '873da1ab2ffffff'],
      [2, 28.6685, 77.4372, 95.00, 18, '873dae123ffffff'],
      [3, 27.8805, 78.0799, 90.00, 42, '873db87c5ffffff'],
      [4, 27.2091, 78.2567, 115.00, 10, '873db9ac1ffffff'],
      [5, 26.5000, 80.3000, 130.00, 0, '873d8c39effffff'],

      // Route 2 (CSTM -> JHS)
      [6, 18.9403, 72.8355, 110.00, 15, '873da1ab2ffffff'],
      [7, 21.0455, 75.8011, 105.00, 10, '873dae123ffffff'],
      [8, 22.6184, 77.7712, 95.00, 0, '873db87c5ffffff'],
      [9, 23.2599, 77.4126, 90.00, 20, '873db9ac1ffffff'],
      [10, 24.1683, 78.1884, 110.00, 5, '873d8c39effffff'],

      // Route 3 (HWH -> PRYJ)
      [11, 22.5832, 88.3427, 100.00, 0, '873da1ab2ffffff'],
      [12, 23.7925, 86.4320, 95.00, 15, '873dae123ffffff'],
      [13, 24.7955, 85.0000, 90.00, 30, '873db87c5ffffff'],
      [14, 25.2818, 83.1189, 80.00, 55, '873db9ac1ffffff'],
      [15, 25.4000, 82.0000, 120.00, 5, '873d8c39effffff'],

      // Route 4 (NGP -> CNB)
      [16, 21.1500, 79.0833, 115.00, 0, '873da1ab2ffffff'],
      [17, 22.6184, 77.7712, 100.00, 20, '873dae123ffffff'],
      [18, 25.4489, 78.5690, 110.00, 0, '873db87c5ffffff'],
      [19, 25.9928, 79.4674, 115.00, 12, '873db9ac1ffffff'],
      [20, 26.4000, 80.2000, 90.00, 35, '873d8c39effffff'],

      // Route 5 (LKO -> PRYJ)
      [21, 26.8306, 80.9238, 95.00, 0, '873da1ab2ffffff'],
      [22, 26.2307, 81.2407, 90.00, 10, '873dae123ffffff'],
      [23, 25.9189, 81.9839, 85.00, 25, '873db87c5ffffff'],
      [24, 25.5000, 81.8500, 110.00, 5, '873db9ac1ffffff'],
      [25, 25.4467, 81.8407, 90.00, 0, '873d8c39effffff'],
    ];

    for (const [tid, lat, lng, spd, dly, h3] of seeds) {
      await client.query(
        `INSERT INTO live_telemetry
           (train_id, current_lat, current_lng, current_speed, delay_minutes, h3_index, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [tid, lat, lng, spd, dly, h3]
      );
    }

    await client.query("COMMIT");
    console.log("[Reset] Telemetry re-seeded. Broadcasting fresh state…");

    // Trigger an immediate broadcast so all clients see the reset
    await pollAndBroadcast();

    res.json({ success: true, message: "Demo reset complete. Trains repositioned." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Reset] Error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 404 fallback for unmatched routes
app.use((req, res) => {
  res.status(404).json({ error: `No route found for ${req.method} ${req.path}` });
});

// =============================================================================
// SERVER STARTUP
// =============================================================================

server.listen(PORT, () => {
  console.log("=".repeat(60));
  console.log("  Node.js API Gateway & WebSocket Server");
  console.log(`  Port          : ${PORT}`);
  console.log(`  Python API    : ${PYTHON_API_URL}`);
  console.log(`  Poll Interval : ${POLL_INTERVAL_MS}ms`);
  console.log(`  CORS Origin   : ${CORS_ORIGIN}`);
  console.log("=".repeat(60));

  // Start the polling loop only after the server is listening
  startPoller();
});

// Graceful shutdown — release DB pool and stop poller cleanly
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

function gracefulShutdown(signal) {
  console.log(`\n[Server] ${signal} received — shutting down gracefully.`);
  clearInterval(pollerHandle);
  server.close(() => {
    pool.end(() => {
      console.log("[Server] PostgreSQL pool closed. Goodbye!");
      process.exit(0);
    });
  });
}
