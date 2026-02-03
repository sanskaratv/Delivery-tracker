## Delivery Tracker – React + Vite + MapLibre

A small web app that visualises a **live delivery-style rider** moving from a **pickup** point to a **drop** point over a **real road route**.

Tech stack:
- **React + Vite (JavaScript)**
- **MapLibre GL JS** for the map and markers
- **OSRM public routing API** for road routes (with graceful fallback)

Pickup, drop and duration are hard-coded to:
- Pickup: `26.1548, 91.7889`
- Drop: `26.1445, 91.7362`
- Trip duration: **45 seconds**

---

## Setup & Run

### Prerequisites
- Node.js 18+ recommended
- npm (comes with Node)

### Install dependencies

```bash
npm install
```

### Start dev server

```bash
npm run dev
```

Then open the URL printed in the terminal, typically:

- Local: `http://localhost:5173/`

### Production build

```bash
npm run build
npm run preview
```

`npm run preview` will start a static server so you can test the built app.

---

## App Behavior

### Map & Markers
- Renders a **MapLibre** map centered near the **pickup** location.
- Adds three markers:
  - **Pickup** – green
  - **Drop** – red
  - **Rider** – blue (moving)
- Draws a polyline between pickup and drop:
  - Uses a **real road route** from OSRM when available.
  - Falls back to a straight line if routing fails.

### Animation
- Clicking **Start** moves the rider from pickup to drop in **45 seconds**.
- Animation uses **`requestAnimationFrame`** for smooth motion.
- **Pause / Resume / Reset**:
  - **Start**
    - Starts animation if stopped.
    - Resumes if paused.
    - Ignores extra clicks while already running.
  - **Pause**
    - Freezes the rider in place.
    - Remembers elapsed time so resume continues smoothly.
  - **Reset**
    - Cancels animation.
    - Returns rider to pickup.
    - Recenters the camera on pickup.

### Camera Follow
- **Follow Rider** checkbox:
  - When enabled, the camera **pans with the rider** using `map.easeTo`.
  - When disabled, the camera stays wherever the user left it.

### Right-hand UI Panel
- **Controls**
  - Start / Pause / Reset buttons
  - Follow Rider toggle
- **Live stats**
  - Current **rider latitude / longitude**
  - **Progress percentage** (0–100%) with a small progress bar
  - **Distance remaining** (approx, in km) based on current position along the route
  - **Trip distance** (approx total km)
- **Legend**
  - Shows colors and labels for Pickup / Rider / Drop.

### Robustness & Edge Cases
- **Start button**
  - No-op if the animation is already running.
  - When resuming from pause, continues from the correct position (no jump back).
- **Pause / Resume**
  - Uses a combination of `requestAnimationFrame` and timestamp refs to maintain smooth motion.
- **Reset**
  - Cancels any outstanding animation frame.
  - Clears internal timing state.
- **React StrictMode**
  - The map effect cleans up and **resets refs** so that on dev re-mount, the map is re-created properly.

---

## Architecture & Code Structure

### Files
- `src/main.jsx`
  - Standard Vite/React entry that mounts `App`.
- `src/App.jsx`
  - Contains all **map setup**, **routing**, **animation**, and **UI logic**.
- `src/App.css`
  - Layout and styling for map + control panel.

### High-Level Flow (`App.jsx`)

1. **Constants & Utilities**
   - `PICKUP`, `DROP`, `TRIP_DURATION`.
   - `calculateDistanceKm(point1, point2)` – haversine distance in km.
   - `lerp(a, b, t)` – linear interpolation helper.
   - `buildRouteModel(coordinates)` – converts a coordinate array into:
     - `coordinates`: raw `[lng, lat][]`
     - `cumulativeKm`: distance from start at each vertex
     - `totalKm`: total route length
   - `positionAtProgress(routeModel, t)` – returns a `{ lng, lat }` along the route for a normalized progress `t` in \[0, 1\].

2. **Refs**
   - `map`, `mapContainer`, `riderMarker` – MapLibre objects and container.
   - `animationFrameId` – current RAF id for cancellation.
   - `isRunningRef`, `startTimestampRef`, `elapsedBeforeStartRef` – timing and state for animation.
   - `routeModelRef` – preprocessed route geometry (coordinates + cumulative distances).
   - `routeAbortRef` – `AbortController` for cancelling OSRM fetch on unmount.

3. **State**
   - `mapLoaded`, `mapError` – map lifecycle / failure handling.
   - `routeLoading`, `routeError` – route fetch status.
   - `isAnimating`, `isPaused`, `followRider`.
   - `riderPosition`, `progress`.
   - `routeDistanceKm` – total distance for route.

4. **Routing Logic**
   - `fetchRoute()`:
     - Calls `https://router.project-osrm.org/route/v1/driving/{pickupLng},{pickupLat};{dropLng},{dropLat}?geometries=geojson&overview=full`.
     - Builds a route model from the returned coordinates.
     - Updates the existing `route` GeoJSON source with the new geometry.
     - Fits the map bounds to the route.
     - On failure, sets `routeError` and falls back to a simple two-point straight line model.

5. **Map Initialization (`useEffect`)**
   - Creates the MapLibre map once, centered on pickup.
   - Adds base tiles (CARTO light basemap).
   - On `load`:
     - Adds pickup, drop and rider markers.
     - Adds a basic `route` GeoJSON source and line layer (initially straight line).
     - Calls `fetchRoute()` to replace the geometry with a real road route.
   - Adds an `error` listener:
     - Sets a friendly `mapError` message if MapLibre fails internally.
   - Includes a **timeout** (~12s) to surface a clear message if the map never finishes loading (e.g. blocked tiles).
   - Cleanup:
     - Cancels RAF.
     - Removes the map instance.
     - Aborts any in-flight route fetch.
     - Clears map/marker refs so StrictMode re-mounts can re-initialize correctly.

6. **Animation (`tick`)**
   - Called via `requestAnimationFrame`.
   - Computes elapsed time using `startTimestampRef` and `elapsedBeforeStartRef`.
   - Normalizes to `t = elapsed / TRIP_DURATION`, clamped to \[0, 1\].
   - Uses `positionAtProgress(routeModelRef.current, t)` to get the rider’s coordinate.
   - Updates React state (`riderPosition`, `progress`) and the MapLibre marker.
   - If **Follow Rider** is enabled, calls `map.easeTo` to keep the camera centered on the rider.
   - Stops when `t >= 1` (trip complete), cleaning up timing refs and RAF.

7. **Controls**
   - `handleStart`
     - No-op if map isn’t ready or in error.
     - Ignores if already running.
     - When starting from reset, ensures the rider marker is at pickup.
     - Starts the RAF loop.
   - `handlePause`
     - Stops RAF and sets `isPaused`.
     - Stores elapsed time so a subsequent Start can resume smoothly.
   - `handleReset`
     - Cancels RAF, clears timing refs, resets progress and position, recenters map.

8. **Derived Values**
   - `distanceRemainingKm`:
     - Usually `routeDistanceKm * (1 - progress / 100)`.
     - Falls back to haversine between current rider position and drop if anything is off.

---

## Assumptions & Tradeoffs

### Assumptions
- **Single hard-coded trip**:
  - Only one pickup/drop pair and fixed 45s duration.
- **Public OSRM instance**:
  - Uses the free `router.project-osrm.org` server (subject to rate limits and availability).
- **Simple straight-line fallback**:
  - If OSRM fails, the app still works using a straight line between pickup and drop.
- **Desktop-focused layout**:
  - Layout is optimized for a desktop viewport (map + right-side panel).

### Tradeoffs / Design Decisions
- **MapLibre vs Leaflet**
  - Chosen **MapLibre GL JS** (vector/WebGL) over Leaflet to align with modern GL-based map stacks and provide smoother camera animations.
  - Leaflet would be lighter but would require a different plugin ecosystem and tile config.
- **Client-side routing calls**
  - Routing is done directly from the browser to OSRM for simplicity:
    - No backend required.
    - Easier to reason about for a sample app.
  - Tradeoff: tight coupling to a specific public routing endpoint and potential CORS/network issues.
- **Single `App` component**
  - All logic lives in `App.jsx` for clarity in a small demo.
  - In a larger app, you’d likely split out:
    - A dedicated `Map` component
    - A `ControlPanel`/`Stats` component
    - A small routing/geometry utility module.
- **Approximate distances**
  - Uses haversine formula in km; this is “good enough” for visualization, not for billing or precise navigation.
- **Fixed trip duration (45s)**
  - Ignores the route API’s ETA and simply normalizes the animation over 45 seconds for consistent demo behavior.
  - A production app might:
    - Scale duration based on distance, or
    - Derive ETA from routing response.
- **Error handling UX**
  - Map and route failures show **simple text banners** instead of complex retry UIs.
  - This keeps the demo code compact while still surfacing useful information.

---

## Extending This Project

Ideas if you want to take it further:
- Allow selecting **different pickup/drop** points on the map.
- Show a **trail** of the rider’s past positions.
- Display **ETA countdown** instead of just percentage.
- Add **mobile layout** and bottom sheet controls.
- Switch to a **self-hosted OSRM** or another routing provider for more reliability.
