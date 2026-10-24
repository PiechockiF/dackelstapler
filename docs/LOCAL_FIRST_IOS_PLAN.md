# Local-first iOS implementation plan

Status: proposed only. Implement after the user says **go**.

## Outcome and architecture

Ship the next TestFlight build as a self-contained Capacitor app. The normal
demo must work on first launch in airplane mode, with the laptop switched off.
Keep the React/Three.js UI. Execute application logic in TypeScript, persist
changes on the device, and bundle the building data and required assets.

Use Python only on the development machine to prepare data and verify results.
No embedded Python runtime, local HTTP server, hosting account, or tunnel is
required for the offline feature set.

The browser development experience retains its existing Python backend through
a separate remote provider. An explicit local browser preview exercises the
same provider used by iOS. Neither provider silently falls back to the other.

## Findings that inform this plan

- The current native release contains the frontend but no configured backend.
- `web/src/dev/mockApi.ts` is not a production local backend: state is in memory,
  room availability includes fabricated busy slots, and some operations are
  absent. It must not simply be enabled for release.
- `mockRouter.ts` already implements graph traversal, but it uses different
  anchors/resolution rules and misses some production route metadata and checks.
- The Python implementation uses representative points and parallel graph edges.
  A width constraint also implies step-free routing. Preserve these semantics.
- There are 66 catalogued sites. Their building JSON is about 17.2 MB when
  minified, versus roughly 209 MB for the complete data directory. Package the
  necessary JSON, not all benchmark inputs, images, or source files.
- The hero factory has 79 spaces and 505 assets. A larger campus has 1,623 spaces
  and 5,250 assets; both need performance checks.
- The viewer already instances assets. Current continuous animation, ambient
  occlusion, bloom, and repeatedly rendered contact shadows are larger immediate
  GPU concerns than adding another instancing system.
- Several components bypass `lib/api.ts` with raw fetches or XMLHttpRequest.
  Updating that one file alone will leave broken features.

## First release scope

| Feature | Local implementation |
| --- | --- |
| Sites and 3D buildings | Bundle all 66 catalog entries and their building JSON; load only the selected building. |
| Building search, area, capacity | Indexed local data, with static values prepared from Python where appropriate. |
| Routes | Actual shortest paths, floors, waypoints, step-free and door-width constraints, closures, unreachable explanations, and rerouting. |
| Asset moves, closures, feed, timeline | Real local mutations and events that survive restart. |
| Room availability and bookings | Actual local bookings, overlap checks, capacity/time validation; no invented occupied slots. |
| Text assistant | A clearly identified local command assistant for supported navigation, search, area/capacity, closures, bookings, and recent changes. Ask for clarification on ambiguous places. |
| Deliveries | Take/import a photo, enter dimensions and destination, save the delivery, show a simple dimensioned box, and calculate supported doorway/route-width checks. |
| Map | Bundled site list always works. Online street tiles are optional enhancement; offline view uses a lightweight local overview without claiming detailed street coverage. |
| Existing demo scan | Optional, explicitly labelled bundled example; load only when requested. |

Not included in this release: general LLM conversation, ElevenLabs services,
automatic photo measurement, image-to-3D generation, video-to-room reconstruction,
floor-plan image/PDF interpretation, new building imports, adding doors, full
collision/turning-clearance or floor-packing solvers, cross-device synchronization,
and a complete offline street-map download. Disable unsupported actions with an
explanation instead of submitting requests that cannot succeed. Where a delivery
check is not implemented, show **not assessed**, never a fabricated pass.

The supported local assistant is rule-based, not an offline copy of Claude.
Photo dimensions in this release are entered by the user, not measured by AI.
Shared availability across several people's phones is outside local-only scope.

## Implementation sequence

### 1. Export authoritative mobile data

- Add `scripts/export_mobile_data.py`, using the existing Python core and catalog.
- Export a small catalog plus separate minified building/graph files under a
  generated mobile asset directory. Preserve IDs, units, licenses, and attribution.
- Export exact Python anchors, room areas/capacities, and the unconstrained
  multigraph with edge provenance, step-free flags, widths, floor/connector data.
  Do not flatten away parallel stair/lift edges.
- Generate test vectors from Python for representative and adversarial route
  cases. The generated data format gets a version and source-content hash.
- Fail the build for missing or inconsistent exports. Do not ship `.env`, API
  keys, backend uploads, the local database, or the entire Python project.

This avoids recreating Shapely's anchor behavior in JavaScript while preserving
the backend's route costs for bundled buildings.

### 2. Introduce a typed data provider and persistent local state

- Add a `SiteTwinDataProvider` interface and explicit local/remote implementations.
  Keep existing domain types and most React Query consumers.
- Select the provider once at startup. Initialize storage before queries run.
  Native defaults to local; remote behavior is deliberate browser/development use.
- Use IndexedDB through a small typed wrapper for versioned structured state:
  closures, asset overrides, bookings, deliveries, and events. Seeds are immutable
  bundled assets; persist only user state and small labelled demo seeds.
- Make a mutation and its event one transaction. Publish UI updates only after a
  successful commit; surface storage errors without reporting a successful save.
- Seed once with stable IDs. App updates migrate state without resetting edits.
  Add a deliberate local-data reset and a portable state export for recovery.
- Use Capacitor Filesystem for persistent photos/thumbnails. Persist file IDs,
  not temporary blob URLs; resolve native URLs when displaying media. Handle
  failed writes and dangling references. Keep media outside the structured DB.
- Replace WebSocket delivery in local mode with in-process typed notifications,
  using the existing React Query invalidation paths. No reconnect or polling loops.
- Route every raw API call through the provider, including room searches, health/
  capability checks, scans, capture jobs, sample media, and upload helpers. Avoid
  a production-wide `window.fetch` monkey patch.

Expected new dependencies: a small IndexedDB wrapper such as `idb`, and the
Capacitor Filesystem plugin matching Capacitor 8. Add other plugins only if an
actual device limitation requires them; no SQLite/native speech/ML stack in v1.

### 3. Execute real routing and local workflows

- Move useful router code into a production `local/` module. Use a binary-heap
  Dijkstra implementation over cached adjacency lists in one Web Worker.
- Load each graph once into the worker. Apply closures and constraints as filters,
  rather than rebuilding every graph for every request.
- Match Python resolution behavior: exact IDs/names/refs and ambiguity reporting.
  Preserve endpoints and waypoints on both success and failure, parallel edges,
  width tolerance, and `min_width_m` implying step-free routing.
- Return route geometry and meaningful steps. Cost/reachability must match Python;
  exact prose and equal-cost path tie-breaking need not be identical. Safe raw
  anchor polylines are acceptable before cosmetic corridor smoothing.
- Tag worker requests with a building/state revision. Discard late responses and
  reroute after changes, including retrying routes that were previously blocked.
- Implement booking conflicts and other mutations against persistent local state.
  Ensure list, feed, timeline, route, and viewer all see the committed state.
- Connect the local assistant to these same real functions. Unsupported language
  gets a clear limitation and suggested supported actions, not a fake answer.

### 4. Finish offline capture and remove network-dependent dead ends

- Reuse camera/photo input; resize large photos and generate thumbnails before
  storage. Keep full-resolution video processing outside this release.
- Save deliveries locally with explicit entered dimensions and simple procedural
  box geometry. Derive state and events from the actual saved delivery.
- Preserve the difference between a width check and a complete physical fit test.
  Update result types/UI to represent **not assessed** where necessary.
- Replace phone-to-laptop QR flows with direct in-app capture navigation in local
  mode. Package any remaining example media and required marker/help assets.
- Keep text input available. Cloud voice is unavailable locally; don't promise
  that browser speech recognition works offline inside the iOS WebView.
- Make offline startup independent of map tiles, fonts, models, health endpoints,
  backend URLs, and capability discovery over the network.

### 5. Tune the existing renderer for iPhone

- Lazy-load heavy routes and scan rendering. Parse/cache only the active building
  and a small bounded set of recently used buildings; cancel stale loads.
- Default native to a mobile graphics profile: capped DPR (start at 1–1.5), no
  continuous contact-shadow rendering, reduced/disabled AO and bloom. Keep the
  existing instanced assets and shared geometry/materials.
- Make decorative pulses static or time-limited in that profile. Convert to
  demand rendering only after camera motion, intro/explode springs, floor anchors,
  route highlights, and async model loads correctly request frames until settled.
- Pause rendering when inactive/backgrounded. Bound model/texture sizes, show
  scan previews before full splats, and release GPU resources on navigation.
- Measure before making further structural optimizations; keep desktop visuals
  available. Local execution alone does not guarantee a faster 3D scene.

### 6. Verify and ship through TestFlight

- Update native build scripts so offline releases generate mobile assets and use
  bundled `webDir` content. Remove the HTTPS-server prerequisite for this mode;
  ensure release Capacitor config does not contain `server.url`.
- Keep bundle ID `com.sitetwin.app` and App Store Connect record `forklift_navi`.
  Use the next unused build number (build 2 if still available).
- Run routing parity, persistence, and integration checks, then production build,
  lint, native archive, signing verification, and upload.
- Test the release bundle in an iOS simulator and instrument local timings. Actual
  iPhone performance and storage behavior are verified through TestFlight, without
  requiring a USB connection. User interaction on the phone is needed for that
  final device check; simulator results are not proof of physical-device performance.
- Publish only after the offline release gates pass. Capture any device-only
  failures and fix them in the next TestFlight build.

## Release gates

1. Fresh install/first launch works in airplane mode with the laptop shut down:
   choose a site, open 3D, search, route, close a door/lift, reroute, and book a room.
2. A manually entered delivery and photo, booking, closure, and asset move survive
   force-quit/relaunch. They also survive an app update/migration without reseeding
   over edits. Uninstall remains an intentional loss of local app data.
3. Bundled-site routing matches Python reachability and costs within 0.01 m for
   golden cases: same-room, outside, parallel stairs/lift, width boundaries,
   disconnected/closed endpoints, waypoints, and ambiguous names. Include a
   randomized sample across the packaged catalog; reproduce every mismatch.
4. Booking conflicts reject atomically. UI state, route updates, and timeline
   remain consistent when requests finish out of order or storage writes fail.
5. No required workflow issues remote `/api`, `/ws`, `/storage`, or asset calls.
   Unsupported features say why they are unavailable rather than hanging.
6. Performance targets on the user's iPhone 13 Pro: usable catalog within 2 s;
   hero scene usable within 3 s; warm local routing p95 under 100 ms; at least
   30 FPS during normal hero-scene interaction (60 FPS is the goal). These are
   targets to measure, not guarantees. Test the large campus separately and
   degrade effects/detail if needed.
7. A ten-minute navigation/editing session has no crash, runaway retry loop, or
   steadily increasing retained GPU resources. Static scenes settle rather than
   animate indefinitely. Background/foreground recovery works.

## Delivery boundaries

Implement in that dependency order: data/provider → routing/persistence → local
workflows → graphics tuning → TestFlight. Each phase must produce a working
increment. If the scope needs reducing, preserve offline startup, truthful results,
route correctness, and persistence before adding more assistant intents or visuals.

This is a local application implementation, not permission to provision hosting,
purchase services, embed provider API keys, replace the Python benchmark engine,
or silently substitute generated results for measurements. Full cloud features
can be a later explicitly configured mode; they are not dependencies of v1.

## References

- [Capacitor configuration](https://capacitorjs.com/docs/config)
- [Capacitor Filesystem](https://capacitorjs.com/docs/apis/filesystem)
- [IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [React Three Fiber performance guidance](https://r3f.docs.pmnd.rs/advanced/scaling-performance)
