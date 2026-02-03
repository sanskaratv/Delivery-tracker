import { useMemo, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './App.css';

const PICKUP = { lng: 91.7889, lat: 26.1548 };
const DROP = { lng: 91.7362, lat: 26.1445 };
const TRIP_DURATION = 45000;

const calculateDistanceKm = (point1, point2) => {
  const R = 6371;
  const dLat = (point2.lat - point1.lat) * Math.PI / 180;
  const dLng = (point2.lng - point1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

const lerp = (a, b, t) => a + (b - a) * t;

const buildRouteModel = (coordinates) => {
  // coordinates: Array<[lng, lat]>
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return {
      coordinates: [
        [PICKUP.lng, PICKUP.lat],
        [DROP.lng, DROP.lat],
      ],
      cumulativeKm: [0, calculateDistanceKm(PICKUP, DROP)],
      totalKm: calculateDistanceKm(PICKUP, DROP),
    };
  }

  const cumulativeKm = [0];
  let totalKm = 0;
  for (let i = 0; i < coordinates.length - 1; i++) {
    const a = { lng: coordinates[i][0], lat: coordinates[i][1] };
    const b = { lng: coordinates[i + 1][0], lat: coordinates[i + 1][1] };
    totalKm += calculateDistanceKm(a, b);
    cumulativeKm.push(totalKm);
  }

  return { coordinates, cumulativeKm, totalKm };
};

const positionAtProgress = (routeModel, t) => {
  if (!routeModel) return { ...PICKUP };
  if (t <= 0) return { lng: routeModel.coordinates[0][0], lat: routeModel.coordinates[0][1] };
  if (t >= 1) {
    const last = routeModel.coordinates[routeModel.coordinates.length - 1];
    return { lng: last[0], lat: last[1] };
  }

  const targetKm = routeModel.totalKm * t;
  const cum = routeModel.cumulativeKm;

  // Linear scan is fine for typical OSRM geometries; could binary search if needed.
  let segIdx = 0;
  while (segIdx < cum.length - 1 && cum[segIdx + 1] < targetKm) segIdx++;

  const segStartKm = cum[segIdx];
  const segEndKm = cum[segIdx + 1];
  const segT = segEndKm === segStartKm ? 0 : (targetKm - segStartKm) / (segEndKm - segStartKm);

  const a = routeModel.coordinates[segIdx];
  const b = routeModel.coordinates[segIdx + 1];

  return {
    lng: lerp(a[0], b[0], segT),
    lat: lerp(a[1], b[1], segT),
  };
};

function App() {
  const mapContainer = useRef(null);
  const map = useRef(null);
  const riderMarker = useRef(null);
  const animationFrameId = useRef(null);
  const isRunningRef = useRef(false);
  const startTimestampRef = useRef(null);
  const elapsedBeforeStartRef = useRef(0);
  const routeModelRef = useRef(buildRouteModel([
    [PICKUP.lng, PICKUP.lat],
    [DROP.lng, DROP.lat],
  ]));
  const routeAbortRef = useRef(null);
  
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapError, setMapError] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [followRider, setFollowRider] = useState(false);
  const [riderPosition, setRiderPosition] = useState(PICKUP);
  const [progress, setProgress] = useState(0);

  const [routeDistanceKm, setRouteDistanceKm] = useState(() => routeModelRef.current.totalKm);

  const fetchRoute = async () => {
    // OSRM public demo server. If it rate-limits/fails, we gracefully fall back to straight line.
    const url = `https://router.project-osrm.org/route/v1/driving/${PICKUP.lng},${PICKUP.lat};${DROP.lng},${DROP.lat}?geometries=geojson&overview=full`;

    try {
      setRouteError(null);
      setRouteLoading(true);

      if (routeAbortRef.current) routeAbortRef.current.abort();
      const controller = new AbortController();
      routeAbortRef.current = controller;

      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`Routing failed: HTTP ${res.status}`);
      const data = await res.json();
      if (data?.code !== 'Ok' || !data?.routes?.[0]?.geometry?.coordinates) {
        throw new Error('Routing failed: unexpected response');
      }

      const coords = data.routes[0].geometry.coordinates;
      const model = buildRouteModel(coords);
      routeModelRef.current = model;
      setRouteDistanceKm(model.totalKm);

      if (map.current?.getSource?.('route')) {
        map.current.getSource('route').setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: coords },
          properties: {},
        });
      }

      // Fit to bounds of the route.
      if (map.current) {
        const bounds = new maplibregl.LngLatBounds();
        for (const c of coords) bounds.extend(c);
        map.current.fitBounds(bounds, { padding: 60, duration: 800 });
      }
    } catch (err) {
      // Abort is expected on unmount or re-fetch.
      if (err?.name === 'AbortError') return;
      setRouteError('Could not fetch a real route. Using a straight line fallback.');
      routeModelRef.current = buildRouteModel([
        [PICKUP.lng, PICKUP.lat],
        [DROP.lng, DROP.lat],
      ]);
      setRouteDistanceKm(routeModelRef.current.totalKm);
    } finally {
      setRouteLoading(false);
    }
  };

  useEffect(() => {
    if (map.current) return;

    try {
      const loadTimeout = setTimeout(() => {
        // If load never fires (style/tiles blocked), surface a clear message.
        const isLoaded =
          !!map.current &&
          // MapLibre provides loaded(); if unavailable, treat as not loaded.
          typeof map.current.loaded === 'function' &&
          map.current.loaded();

        if (!isLoaded) {
          setMapError((prev) => prev ?? 'Map failed to load (timeout). Check your network or tile access.');
        }
      }, 12000);

      map.current = new maplibregl.Map({
        container: mapContainer.current,
        style: {
          version: 8,
          sources: {
            'carto-tiles': {
              type: 'raster',
              tiles: [
                'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'
              ],
              tileSize: 256,
              attribution: '© CARTO, © OpenStreetMap contributors'
            }
          },
          layers: [{
            id: 'carto-layer',
            type: 'raster',
            source: 'carto-tiles',
            minzoom: 0,
            maxzoom: 20
          }]
        },
        center: [PICKUP.lng, PICKUP.lat],
        zoom: 13
      });

      map.current.on('load', () => {
        clearTimeout(loadTimeout);
        setMapError(null);
        setMapLoaded(true);

        new maplibregl.Marker({ color: '#10b981' })
          .setLngLat([PICKUP.lng, PICKUP.lat])
          .addTo(map.current);

        new maplibregl.Marker({ color: '#ef4444' })
          .setLngLat([DROP.lng, DROP.lat])
          .addTo(map.current);

        riderMarker.current = new maplibregl.Marker({ color: '#3b82f6' })
          .setLngLat([PICKUP.lng, PICKUP.lat])
          .addTo(map.current);

        map.current.addSource('route', {
          type: 'geojson',
          data: {
            type: 'Feature',
            geometry: {
              type: 'LineString',
              coordinates: [
                [PICKUP.lng, PICKUP.lat],
                [DROP.lng, DROP.lat]
              ]
            }
          }
        });

        map.current.addLayer({
          id: 'route',
          type: 'line',
          source: 'route',
          paint: {
            'line-color': '#6366f1',
            'line-width': 4,
            'line-opacity': 0.6
          }
        });

        // Replace straight line with a real road route.
        fetchRoute();
      });

      map.current.on('error', () => {
        setMapError('Failed to load map');
      });

    } catch {
      // Avoid synchronous setState inside effect body (lint rule).
      setTimeout(() => {
        setMapError('Map initialization failed');
      }, 0);
    }

    return () => {
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      if (map.current) map.current.remove();
      if (routeAbortRef.current) routeAbortRef.current.abort();
      // React StrictMode mounts/unmounts effects in dev; clear refs so map can re-init.
      map.current = null;
      riderMarker.current = null;
    };
  }, []);

  const tick = (timestamp) => {
    if (!isRunningRef.current) return;

    if (startTimestampRef.current == null) startTimestampRef.current = timestamp;
    const elapsedMs = timestamp - startTimestampRef.current + elapsedBeforeStartRef.current;
    const t = Math.min(elapsedMs / TRIP_DURATION, 1);

    const currentPosition = positionAtProgress(routeModelRef.current, t);

    setRiderPosition(currentPosition);
    setProgress(t * 100);

    if (riderMarker.current) riderMarker.current.setLngLat([currentPosition.lng, currentPosition.lat]);
    if (followRider && map.current) {
      map.current.easeTo({ center: [currentPosition.lng, currentPosition.lat], duration: 120 });
    }

    if (t >= 1) {
      isRunningRef.current = false;
      setIsAnimating(false);
      setIsPaused(false);
      startTimestampRef.current = null;
      elapsedBeforeStartRef.current = 0;
      if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
      animationFrameId.current = null;
      return;
    }

    animationFrameId.current = requestAnimationFrame(tick);
  };

  const handleStart = () => {
    if (!mapLoaded || mapError) return;

    // Ignore repeated Start when already running.
    if (isRunningRef.current) return;

    // If starting from a fully reset state, ensure marker is at pickup.
    if (!isPaused && progress === 0) {
      setRiderPosition(PICKUP);
      if (riderMarker.current) riderMarker.current.setLngLat([PICKUP.lng, PICKUP.lat]);
    }

    isRunningRef.current = true;
    setIsAnimating(true);
    setIsPaused(false);
    startTimestampRef.current = null;

    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    animationFrameId.current = requestAnimationFrame(tick);
  };

  const handlePause = () => {
    if (!isAnimating) return;

    setIsPaused(true);
    setIsAnimating(false);

    isRunningRef.current = false;
    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    animationFrameId.current = null;

    if (startTimestampRef.current != null) {
      elapsedBeforeStartRef.current += performance.now() - startTimestampRef.current;
      startTimestampRef.current = null;
    }
  };

  const handleReset = () => {
    setIsAnimating(false);
    setIsPaused(false);
    setProgress(0);
    setRiderPosition(PICKUP);

    isRunningRef.current = false;
    startTimestampRef.current = null;
    elapsedBeforeStartRef.current = 0;

    if (animationFrameId.current) cancelAnimationFrame(animationFrameId.current);
    if (riderMarker.current) riderMarker.current.setLngLat([PICKUP.lng, PICKUP.lat]);
    if (map.current) map.current.easeTo({ center: [PICKUP.lng, PICKUP.lat], zoom: 13 });
  };

  const distanceRemainingKm = useMemo(() => {
    const remaining = routeDistanceKm * (1 - progress / 100);
    return Number.isFinite(remaining) ? Math.max(0, remaining) : calculateDistanceKm(riderPosition, DROP);
  }, [progress, routeDistanceKm, riderPosition]);

  return (
    <div className="app-container">
      <div className="map-wrapper">
        {routeLoading && <div className="loading-box">Loading real route…</div>}
        {mapError && (
          <div className="error-box">
            {mapError}
            <div className="error-subtext">
              Try reloading, or check if map tile URLs are reachable.
            </div>
          </div>
        )}
        <div ref={mapContainer} className="map-container" />
      </div>

      <div className="control-panel">
        <h2>Delivery Tracker</h2>

        <div className="buttons">
          <button 
            onClick={handleStart} 
            disabled={!!mapError || !mapLoaded || (isAnimating && !isPaused)}
            className="btn btn-start"
          >
            {isPaused ? 'Resume' : 'Start'}
          </button>
          <button 
            onClick={handlePause} 
            disabled={!isAnimating}
            className="btn btn-pause"
          >
            Pause
          </button>
          <button onClick={handleReset} className="btn btn-reset">
            Reset
          </button>
        </div>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={followRider}
            onChange={(e) => setFollowRider(e.target.checked)}
          />
          <span>Follow Rider</span>
        </label>

        <div className="stats-box">
          {routeError && (
            <div className="stat-item" style={{ color: '#b45309', fontWeight: 700 }}>
              {routeError}
            </div>
          )}
          <div className="stat-item">
            <div className="stat-label">Rider Position</div>
            <div className="stat-value">Lat: {riderPosition.lat.toFixed(6)}</div>
            <div className="stat-value">Lng: {riderPosition.lng.toFixed(6)}</div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Progress</div>
            <div className="stat-progress">{progress.toFixed(1)}%</div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Distance Remaining</div>
            <div className="stat-distance">{distanceRemainingKm.toFixed(2)} km</div>
          </div>

          <div className="stat-item">
            <div className="stat-label">Trip Distance (approx)</div>
            <div className="stat-value">{routeDistanceKm.toFixed(2)} km</div>
          </div>
        </div>

        <div className="legend">
          <div className="legend-title">Markers</div>
          <div className="legend-item">
            <div className="marker-dot" style={{ background: '#10b981' }} />
            <span>Pickup Location</span>
          </div>
          <div className="legend-item">
            <div className="marker-dot" style={{ background: '#3b82f6' }} />
            <span>Rider (Moving)</span>
          </div>
          <div className="legend-item">
            <div className="marker-dot" style={{ background: '#ef4444' }} />
            <span>Drop Location</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;

 





