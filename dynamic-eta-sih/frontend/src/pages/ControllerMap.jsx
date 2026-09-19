// frontend/src/pages/ControllerMap.jsx
// ======================================
// Phase 5 (v6) — Light-theme professional railway tracking UI
//                + Snap-to-Track (map matching) logic.
//
// NEW in this version:
//   snapToTrack(lng, lat, path) — projects a GPS point onto its corridor's
//   polyline using the perpendicular foot formula on each segment. The nearest
//   projected point across ALL segments of the corridor is the snapped position.
//   This guarantees trains always appear on the drawn track lines regardless
//   of floating-point drift in the telemetry data.
//
//   snappedTrains — a useMemo that runs the snap on every socket push and
//   produces a new array where current_lng/current_lat have been replaced with
//   the on-track coordinates. ScatterplotLayer and TextLayer both use this
//   array; the popup still shows the raw train data (real values).

import { useEffect, useRef, useState, useMemo } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay }                          from "@deck.gl/mapbox";
import { ScatterplotLayer, TextLayer, PathLayer } from "@deck.gl/layers";
import { H3HexagonLayer }                         from "@deck.gl/geo-layers";
import axios                                      from "axios";
import {
  AlertTriangle, RefreshCw, Layers, X,
  Wifi, WifiOff, ChevronRight, Loader2,
} from "lucide-react";
import { statusLabel, formatDelay, formatTime } from "../utils/statusHelpers";

const NODE_URL  = import.meta.env.VITE_NODE_URL || "http://localhost:5000";
const MAP_STYLE = {
  version: 8,
  sources: {
    openstreetmap: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [
    {
      id: "openstreetmap-tiles",
      type: "raster",
      source: "openstreetmap",
      minzoom: 0,
      maxzoom: 19,
    },
  ],
};

const INIT_VIEW = {
  longitude: 79.5, latitude: 25.5,
  zoom: 5.4, pitch: 0, bearing: 0,
  transitionDuration: 0,
};

// =============================================================================
// SNAP-TO-TRACK UTILITIES
// =============================================================================

/**
 * getCorridorId(trainId)
 * Maps a train's database ID to the corridor_id returned by the API.
 * Corridors in our seed:
 *   train_id  1-4  → North  (corridor_id = 1, representative = train 1)
 *   train_id  5-8  → SW     (corridor_id = 5, representative = train 5)
 *   train_id  9-12 → East   (corridor_id = 9, representative = train 9)
 */
function getCorridorId(trainId) {
  if (trainId <= 5)  return 1;
  if (trainId <= 10) return 6;
  if (trainId <= 15) return 11;
  if (trainId <= 20) return 16;
  return 21;
}

/**
 * projectOntoSegment(P, A, B)
 * Returns the closest point on segment AB to point P.
 * All coordinates are [lng, lat] arrays.
 * Uses the scalar projection formula:
 *   t = clamp( dot(P-A, B-A) / |B-A|², 0, 1 )
 *   closest = A + t * (B - A)
 */
function projectOntoSegment(P, A, B) {
  const dx = B[0] - A[0];
  const dy = B[1] - A[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return A;                          // degenerate segment (A === B)
  const t = Math.max(0, Math.min(1,
    ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / lenSq
  ));
  return [A[0] + t * dx, A[1] + t * dy];
}

/**
 * snapToTrack(lng, lat, path)
 * Projects the point [lng, lat] onto the nearest segment of the polyline
 * defined by `path` (array of [lng, lat] waypoints).
 * Returns the snapped [lng, lat] on the polyline.
 *
 * Squared Euclidean distance is used for comparison (no sqrt needed — we only
 * care about which projection is nearest, not the actual distance).
 */
function snapToTrack(lng, lat, path) {
  if (!path || path.length < 2) return [lng, lat];

  const P = [lng, lat];
  let bestDist = Infinity;
  let snapped  = P;

  for (let i = 0; i < path.length - 1; i++) {
    const proj = projectOntoSegment(P, path[i], path[i + 1]);
    const dx = proj[0] - P[0];
    const dy = proj[1] - P[1];
    const d2 = dx * dx + dy * dy;
    if (d2 < bestDist) {
      bestDist = d2;
      snapped  = proj;
    }
  }

  return snapped;
}

// =============================================================================
// COLOUR TABLES — tuned for high contrast on the Positron (light) basemap
// =============================================================================
const STATUS_RGBA = {
  ON_TIME:        [22,  163,  74, 240],   // green-600
  MINOR_DELAY:    [234,  88,  12, 240],   // orange-600
  MODERATE_DELAY: [220,  38,  38, 240],   // red-600
  MAJOR_DELAY:    [136,  19,  55, 255],   // rose-900
  Arrived:        [59,  130, 246, 240],   // blue-500 — clean terminus state
  UNKNOWN:        [100, 116, 139, 200],   // slate-500
};

function trainRGBA(train) {
  return STATUS_RGBA[train?.status] ?? STATUS_RGBA.UNKNOWN;
}

function hexFill(severity) {
  return severity === "HIGH"
    ? [220, 38, 38, 170]
    : [245, 158, 11, 140];
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function ControlPanel({ trains, connected, lastUpdate, refreshNow, resetDemo, resetting, showHex, onToggleHex, corridors }) {
  const onTime  = trains.filter(t => t.status === "ON_TIME").length;
  const delayed = trains.filter(t => t.status !== "ON_TIME" && t.status !== "UNKNOWN").length;

  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 overflow-hidden w-[260px]">
      <div className="bg-slate-50 px-4 py-3 flex items-center justify-between border-b border-slate-200">
        <div>
          <p className="text-slate-800 font-black text-sm tracking-wide">TrackSense Live</p>
          <p className="text-slate-500 font-bold text-[10px] mt-0.5 uppercase tracking-wider">Network Operations Centre</p>
        </div>
        <div className="flex items-center gap-1.5">
          {connected ? <Wifi size={13} className="text-emerald-500" /> : <WifiOff size={13} className="text-rose-500" />}
          <span className={`text-[10px] font-bold tracking-wider ${connected ? "text-emerald-600" : "text-rose-600"}`}>
            {connected ? "LIVE" : "OFFLINE"}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-3 divide-x divide-slate-100 border-b border-slate-100">
        <StatCell label="Total"   value={trains.length} color="text-blue-700"    />
        <StatCell label="On Time" value={onTime}        color="text-emerald-600" />
        <StatCell label="Delayed" value={delayed}       color="text-rose-600"    />
      </div>

      {corridors.length > 0 && (
        <div className="px-4 py-3 border-b border-slate-100">
          <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Active Corridors</p>
          <div className="space-y-1.5">
            {corridors.map(c => (
              <div key={c.name} className="flex items-center gap-2">
                <span className="w-6 h-1.5 rounded-full shrink-0"
                  style={{ background: `rgb(${c.color[0]},${c.color[1]},${c.color[2]})` }} />
                <span className="text-xs text-slate-600 truncate">{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-b border-slate-100">
        <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2">Train Status</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {Object.entries(STATUS_RGBA).filter(([k]) => k !== "UNKNOWN").map(([key, rgba]) => (
            <div key={key} className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ background: `rgb(${rgba[0]},${rgba[1]},${rgba[2]})` }} />
              <span className="text-[11px] text-slate-600">
                {key.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="px-4 py-3 flex items-center justify-between gap-2">
        <button onClick={onToggleHex}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all ${
            showHex ? "bg-amber-50 border-amber-300 text-amber-700" : "bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100"
          }`}>
          <Layers size={12} /> Heatmap {showHex ? "ON" : "OFF"}
        </button>
        <button
          onClick={resetDemo}
          disabled={resetting}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-wait text-white transition-colors"
        >
          {resetting
            ? <><Loader2 size={12} className="animate-spin" /> Resetting…</>
            : <><RefreshCw size={12} /> Reset Demo</>
          }
        </button>
      </div>

      {lastUpdate && (
        <p className="text-center text-[10px] text-slate-400 pb-2">Updated {formatTime(lastUpdate)}</p>
      )}
    </div>
  );
}

function StatCell({ label, value, color }) {
  return (
    <div className="text-center py-2.5">
      <p className={`text-lg font-bold font-mono leading-none ${color}`}>{value}</p>
      <p className="text-[10px] text-slate-400 mt-1 uppercase tracking-wide">{label}</p>
    </div>
  );
}

function TrainPopup({ train, onClose }) {
  if (!train) return null;
  const [r, g, b] = trainRGBA(train);
  const css = `rgb(${r},${g},${b})`;
  return (
    <div className="bg-white rounded-xl shadow-xl border border-slate-200 p-4 w-[240px] fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: css }} />
          <span className="font-mono font-bold text-sm text-slate-800">{train.train_no}</span>
          <span className="text-[10px] text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded-full">{train.train_type}</span>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-700 transition-colors"><X size={15} /></button>
      </div>
      <p className="text-sm font-semibold text-slate-700 mb-3 leading-snug">{train.train_name}</p>
      <div className="text-center py-1.5 rounded-lg mb-3 text-xs font-bold"
        style={{ background: `${css}18`, color: css, border: `1px solid ${css}40` }}>
        {statusLabel(train.status)}{(train.delay_minutes ?? 0) > 0 && ` · +${train.delay_minutes} min`}
      </div>
      <div className="space-y-1.5 text-xs">
        <LightRow label="Speed"   value={`${(train.current_speed ?? 0).toFixed(0)} km/h`} />
        <LightRow label="ETA"     value={train.total_eta_min != null ? `${Math.round(train.total_eta_min)} min` : "—"} />
        <LightRow label="Arrival" value={formatTime(train.expected_arrival)} mono />
        {train.anomaly_event && train.anomaly_event !== "none" && (
          <LightRow label="Event" value={train.anomaly_event.replace(/_/g, " ")} highlight="text-rose-600" />
        )}
        {(train.congestion_count ?? 1) > 1 && (
          <LightRow label="Congestion" value={`${train.congestion_count} trains in zone`} highlight="text-amber-600" />
        )}
      </div>
    </div>
  );
}

function LightRow({ label, value, mono, highlight }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-400">{label}</span>
      <span className={`font-medium text-right ${mono ? "font-mono" : ""} ${highlight ?? "text-slate-700"}`}>{value}</span>
    </div>
  );
}

function TrainList({ trains, onSelect }) {
  const sorted = [...trains].sort((a, b) => (b.delay_minutes ?? 0) - (a.delay_minutes ?? 0));
  return (
    <div className="bg-white rounded-xl shadow-lg border border-slate-200 w-[260px] max-h-[260px] overflow-hidden flex flex-col">
      <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between shrink-0">
        <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Live Trains</p>
        <span className="text-[10px] text-slate-400">{trains.length} active</span>
      </div>
      <div className="overflow-y-auto">
        {sorted.map(train => {
          const [r, g, b] = trainRGBA(train);
          return (
            <button key={train.train_id} onClick={() => onSelect(train)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50 transition-colors border-b border-slate-50 last:border-0 text-left">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: `rgb(${r},${g},${b})` }} />
              <span className="font-mono text-xs font-bold text-blue-700 w-12 shrink-0">{train.train_no}</span>
              <span className="text-xs text-slate-500 flex-1 truncate">{train.train_name}</span>
              <span className="text-xs font-medium shrink-0" style={{ color: `rgb(${r},${g},${b})` }}>
                {(train.delay_minutes ?? 0) > 0 ? `+${train.delay_minutes}m` : "On time"}
              </span>
              <ChevronRight size={11} className="text-slate-300 shrink-0" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function ControllerMap({ trains, connected, lastUpdate, refreshNow }) {
  const wrapRef    = useRef(null);
  const mapContRef = useRef(null);
  const mapRef     = useRef(null);
  const overlayRef = useRef(null);

  const [viewState,  setViewState]  = useState(INIT_VIEW);
  const [congestion, setCongestion] = useState([]);
  const [selected,   setSelected]   = useState(null);    // raw train (popup shows real data)
  const [showHex,    setShowHex]    = useState(true);
  const [corridors,  setCorridors]  = useState([]);
  const [stationPts, setStationPts] = useState([]);
  const [resetting,  setResetting]  = useState(false);

  // ── MapLibre boot + DeckGL overlay (renders into the SAME canvas) ─────────
  useEffect(() => {
    if (mapRef.current || !mapContRef.current) return;
    const map = new maplibregl.Map({
      container:   mapContRef.current,
      style:       MAP_STYLE,
      center:      [INIT_VIEW.longitude, INIT_VIEW.latitude],
      zoom:        INIT_VIEW.zoom,
      pitch:       INIT_VIEW.pitch,
      bearing:     INIT_VIEW.bearing,
      interactive: true,
      antialias:   true,
    });

    // Create deck.gl overlay that renders INTO the MapLibre canvas
    const overlay = new MapboxOverlay({ interleaved: false });

    map.on("style.load", () => {
      map.resize();
      map.addControl(overlay);
    });

    // Sync viewState from MapLibre → React (for zoom-based layer visibility)
    map.on("move", () => {
      setViewState({
        longitude: map.getCenter().lng,
        latitude:  map.getCenter().lat,
        zoom:      map.getZoom(),
        pitch:     map.getPitch(),
        bearing:   map.getBearing(),
      });
    });

    mapRef.current   = map;
    overlayRef.current = overlay;

    const ro = new ResizeObserver(() => map.resize());
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => {
      ro.disconnect();
      map.remove();
      mapRef.current   = null;
      overlayRef.current = null;
    };
  }, []);

  // ── Fetch DB-sourced route geometry ───────────────────────────────────────
  useEffect(() => {
    axios.get(`${NODE_URL}/api/routes/corridors`)
      .then(({ data }) => {
        const built = data.corridors.map(c => ({
          name:        c.name,
          color:       c.color,
          corridor_id: c.corridor_id,
          path:        c.stations.map(s => [s.lng, s.lat]),
        }));
        setCorridors(built);

        const seen = new Set();
        const pts  = [];
        data.corridors.forEach(c =>
          c.stations.forEach(s => {
            if (!seen.has(s.code)) {
              seen.add(s.code);
              pts.push({ code: s.code, name: s.name, pos: [s.lng, s.lat] });
            }
          })
        );
        setStationPts(pts);
      })
      .catch(err => console.warn("[Routes] Fetch failed:", err.message));
  }, []);

  // ── Push layers + click handler into the MapboxOverlay each render ────────
  useEffect(() => {
    overlayRef.current?.setProps({
      layers,
      onClick: handleClick,
    });
  });

  // ── Keep popup in sync with live socket data ───────────────────────────────
  useEffect(() => {
    if (!selected) return;
    const updated = trains.find(t => t.train_id === selected.train_id);
    if (updated) setSelected(updated);
  }, [trains]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Poll congestion ────────────────────────────────────────────────────────
  useEffect(() => {
    async function load() {
      try {
        const { data } = await axios.get(`${NODE_URL}/api/congestion`);
        setCongestion(data.cells || []);
      } catch (_) {}
    }
    load();
    const id = setInterval(load, 6_000);
    return () => clearInterval(id);
  }, []);

  // ==========================================================================
  // SNAP-TO-TRACK
  // Build a lookup table { corridor_id → path } once corridors are loaded,
  // then compute snapped positions on every socket push (trains changes).
  //
  // snappedTrains is used by ScatterplotLayer + TextLayer.
  // The raw `trains` array is kept for the popup so it shows real values.
  // ==========================================================================

  /** Fast lookup: corridor_id → [lng,lat][] path */
  const corridorPathMap = useMemo(() => {
    const map = {};
    corridors.forEach(c => { map[c.corridor_id] = c.path; });
    return map;
  }, [corridors]);

  /**
   * snappedTrains — runs snapToTrack() on every train position.
   * Re-computed only when `trains` or `corridorPathMap` changes (i.e. each
   * WebSocket push or on first corridor load), not on every render.
   */
  const snappedTrains = useMemo(() => {
    if (!Object.keys(corridorPathMap).length || !trains.length) return trains;

    return trains.map(train => {
      const cid  = getCorridorId(train.train_id);
      const path = corridorPathMap[cid];

      if (!path || !train.current_lng || !train.current_lat) return train;

      const [snappedLng, snappedLat] = snapToTrack(
        parseFloat(train.current_lng),
        parseFloat(train.current_lat),
        path
      );

      // Return a new object with snapped coords; everything else is unchanged.
      return { ...train, current_lng: snappedLng, current_lat: snappedLat };
    });
  }, [trains, corridorPathMap]);

  // ==========================================================================
  // DECK.GL LAYERS
  // ==========================================================================

  const trackLayer = new PathLayer({
    id:             "rail-tracks",
    data:           corridors,
    getPath:        d => d.path,
    getColor:       d => d.color,
    getWidth:       3,
    widthMinPixels: 2,
    widthMaxPixels: 6,
    capRounded:     true,
    jointRounded:   true,
    pickable:       false,
    updateTriggers: { data: corridors },
  });

  const stationLayer = new ScatterplotLayer({
    id:               "stations",
    data:             stationPts,
    getPosition:      d => d.pos,
    getRadius:        900,
    radiusUnits:      "meters",
    radiusMinPixels:  4,
    radiusMaxPixels:  10,
    getFillColor:     [255, 255, 255, 255],
    getLineColor:     [71, 85, 105, 255],
    lineWidthMinPixels: 1.5,
    stroked:          true,
    pickable:         false,
    updateTriggers:   { data: stationPts },
  });

  const stationLabelLayer = new TextLayer({
    id:             "station-labels",
    data:           viewState.zoom >= 6 ? stationPts : [],
    getPosition:    d => d.pos,
    getText:        d => d.code,
    getSize:        10,
    getColor:       [30, 41, 59, 220],
    getPixelOffset: [0, 15],
    fontFamily:     "'Inter', sans-serif",
    fontWeight:     700,
    background:     false,
    pickable:       false,
    updateTriggers: { data: stationPts },
  });

  const hexLayer = showHex && congestion.length > 0
    ? new H3HexagonLayer({
        id:            "h3-congestion",
        data:          congestion,
        getHexagon:    d => d.h3_index,
        getFillColor:  d => hexFill(d.severity),
        getElevation:  d => d.train_count * 3_000,
        extruded:      true,
        elevationScale: 1,
        opacity:       0.6,
        pickable:      false,
        updateTriggers: { data: congestion },
      })
    : null;

  // ── Train dots (uses SNAPPED positions) ───────────────────────────────────
  const trainLayer = new ScatterplotLayer({
    id:               "trains",
    data:             snappedTrains,           // ← snapped coordinates
    getPosition:      d => [d.current_lng, d.current_lat],
    getRadius:        4_000,
    radiusUnits:      "meters",
    radiusMinPixels:  7,
    radiusMaxPixels:  20,
    getFillColor:     d => trainRGBA(d),
    getLineColor:     [255, 255, 255, 220],
    lineWidthMinPixels: 1.5,
    stroked:          true,
    pickable:         true,
    autoHighlight:    true,
    highlightColor:   [255, 255, 255, 80],
    updateTriggers:   { getPosition: snappedTrains, getFillColor: snappedTrains },
  });

  // ── Train number labels (uses SNAPPED positions) ──────────────────────────
  const trainLabelLayer = new TextLayer({
    id:              "train-labels",
    data:            viewState.zoom >= 7 ? snappedTrains : [],  // ← snapped
    getPosition:     d => [d.current_lng, d.current_lat],
    getText:         d => d.train_no ?? "",
    getSize:         11,
    getColor:        [255, 255, 255, 240],
    getPixelOffset:  [0, -20],
    fontFamily:      "'JetBrains Mono', monospace",
    fontWeight:      700,
    background:      true,
    getBackgroundColor: d => [...trainRGBA(d).slice(0, 3), 210],
    backgroundPadding:  [3, 2, 3, 2],
    pickable:        false,
    updateTriggers:  { data: snappedTrains, getPosition: snappedTrains },
  });

  const layers = [
    trackLayer,
    stationLayer,
    stationLabelLayer,
    hexLayer,
    trainLayer,
    trainLabelLayer,
  ].filter(Boolean);

  // onClick uses snappedTrains index to retrieve the ORIGINAL raw train for
  // the popup (so delay, speed, etc. are the real unmodified values).
  function handleClick(info) {
    if (info.object && info.layer?.id === "trains") {
      // info.object is the snapped version; find matching raw train for popup
      const rawTrain = trains.find(t => t.train_id === info.object.train_id);
      setSelected(rawTrain ?? info.object);
    } else {
      setSelected(null);
    }
  }

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%", height: "100vh", overflow: "hidden" }}
    >
      <div ref={mapContRef} style={{ position: "absolute", inset: 0 }} />

      <div className="absolute top-4 left-4 z-10 flex flex-col gap-3">
        <ControlPanel
          trains={trains}
          connected={connected}
          lastUpdate={lastUpdate}
          refreshNow={refreshNow}
          resetDemo={async () => {
            setResetting(true);
            try {
              await axios.post(`${NODE_URL}/api/reset-demo`);
              refreshNow();  // also trigger a socket refresh
            } catch (err) {
              console.error("[Reset] Failed:", err.message);
            } finally {
              setResetting(false);
            }
          }}
          resetting={resetting}
          showHex={showHex}
          onToggleHex={() => setShowHex(v => !v)}
          corridors={corridors}
        />
        {selected && <TrainPopup train={selected} onClose={() => setSelected(null)} />}
      </div>

      <div className="absolute top-4 right-12 z-10">
        <TrainList trains={trains} onSelect={setSelected} />
      </div>

      {!connected && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2 bg-rose-50 border border-rose-200 text-rose-700 px-5 py-2.5 rounded-full text-xs font-bold shadow-lg pointer-events-none">
          <AlertTriangle size={14} />
          WebSocket disconnected — showing last known data
        </div>
      )}
    </div>
  );
}
