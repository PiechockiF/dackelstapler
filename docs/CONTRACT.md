# SiteTwin integration contract

Single source of truth for how the four workstreams talk to each other. Change it only together with the code on both sides, and note the change at the bottom.

Coordinates are always the building's local metres (x right, y up) from `building.json`. Floors stack by `elevation_m`. IDs are the dataset IDs (`space_id`, `opening_id`, `connector_id`, `asset_id`).

## Ownership

| Area | Owner | Directories |
|---|---|---|
| Core geometry, routing, benchmark | A | `core/`, `agent/answer.py`, `tests/`, `SUBMISSION/BENCHMARK.md` |
| Map + 3D twin | B | `web/src/map/`, `web/src/twin/`, `web/src/pages/` |
| Capture (phone → 3D → checks) | C | `capture/`, `web/src/capture/`, `scripts/print_marker.py` |
| Server, chat agent, voice, seed data | D | `server/`, `agent/tools.py`, `agent/prompts.py`, `agent/chat.py`, `scripts/geocode_sites.py`, `scripts/seed_demo_events.py`, `web/src/chat/`, `web/src/sites/` |
| Shared (lead; ask before changing) | lead | `docs/CONTRACT.md`, `web/src/lib/`, `web/src/App.tsx`, `web/src/main.tsx`, `pyproject.toml`, `web/package.json` |

Dependencies: if you need a new package, add it with `uv add` / `npm install` and mention it in your final report.

## Core Python API (A implements, C and D call)

`core/building_map.py` exports `BuildingMap`, subclassing `starter_agent.building_map.BuildingMap` (keep the starter's route cost model exactly). Additional methods / module functions:

```python
# core/building_map.py
class BuildingMap(starter_agent.building_map.BuildingMap):
    def room_area(self, space_id: str) -> float                        # m², shapely polygon area
    def route_payload(self, route: RouteResult) -> dict                # Route JSON (below)
    def find_route(self, start: str, destination: str, *, step_free=False,
                   min_width_m: float | None = None, via: list[str] | None = None) -> RouteResult
        # min_width_m drops openings narrower than it (and stairs, i.e. step_free implied for loads)
        # raises MapError when unreachable

# core/reachability.py
def reachable_spaces(bm, entry_space_id: str, *, min_width_m: float | None = None,
                     step_free: bool = False, closed: set[str] = frozenset()) -> set[str]
def blocking_openings(bm, start: str, destination: str, min_width_m: float) -> list[dict]
    # openings on the unconstrained shortest route that are narrower than min_width_m:
    # [{"id", "width_m", "position", "floor_id"}]

# core/geometry.py
def centroid(bm, space_id) -> tuple[float, float]
def room_above(bm, space_id) -> str | None ; def room_below(bm, space_id) -> str | None
def shared_walls(bm, space_id, min_len_m=1.0, tol_m=0.35) -> list[str]
def footprint_fits(bm, space_id, width_m, depth_m) -> dict  # {"ok": bool, "reason": str, "position": [x,y] | None, "rotation_deg": float}
def capacity(bm, space_id) -> int  # chairs in the room, else floor(area / 2.5)
```

`agent/answer.py` is the benchmark agent (Claude tool use over `core/`). It exports `answer(building_directory: Path, question_text: str) -> str` for `benchmark.evaluate --agent agent.answer:answer` and `answer_entry(...)` for `run_benchmark`.

## JSON shapes

```ts
Site = { id, name, lat, lon, source, building_id, data_path, floors: number, demo_location: boolean, kind: 'factory'|'campus'|'office'|'airport'|'mall'|'other', address?: string|null }

Route = {
  reachable: boolean, length_m: number, step_free: boolean, min_width_m: number | null,
  space_path: string[], steps: string[],                       // human directions
  floors: { floor_id: string, level: number, elevation_m: number, points: [number, number][] }[],  // polyline per floor segment, in order
  connectors: { id: string, kind: 'stairs'|'lift', from_floor_id: string, to_floor_id: string, position: [number, number] }[],
  blocking_openings?: { id, width_m, position: [number, number], floor_id }[]
}

Event = { id: string, ts: string /* ISO */, site_id: string,
          type: 'delivery'|'asset_moved'|'closure'|'booking'|'door_added'|'capture',
          title: string,                                       // "Steel drum delivered to Dock B"
          payload: object }                                    // type-specific, e.g. Delivery for 'delivery'

SiteState = { closed: string[],                                // closed element ids
              asset_overrides: Record<string, { position: [number, number], floor_id: string, space_id: string }>,
              deliveries: Delivery[], added_openings: object[] }

Delivery = { id, site_id, ts, label, note?: string,
             dims_m: { w, d, h }, tolerance_m: number, declared_dims_m?: { w, d, h },
             floor_id, space_id, position: [number, number], rotation_deg: number,
             target_space_id?: string, photo_url?: string, model_url?: string,   // GLB, metres, origin at base centre
             status: 'ok'|'mismatch'|'blocked', check: DimensionCheck }

DimensionCheck = {
  declared: { ok: boolean, deviation_m: { w, d, h } } | null,
  route_fit: { ok: boolean, route?: Route, blocking_openings: Route['blocking_openings'], alternative?: Route } | null,
  floor_fit: { ok: boolean, reason: string } | null,
  summary: string                                              // one line for the UI / agent
}

BookableRoom = { space_id, name, floor_id, level, capacity, area_m2, free: boolean, bookings: Booking[] }
Booking = { id, site_id, space_id, start: string, end: string, who: string, title: string }

CaptureJob = { id, kind: 'delivery'|'room', site_id, status: 'queued'|'measuring'|'modeling'|'aligning'|'done'|'failed',
               progress: number /* 0..1 */, message: string, result?: Delivery | RoomScan }
RoomScan = { id, site_id, space_id, splat_url: string, transform: number[] /* 4x4 column-major, splat → building metres */,
             deviations: { wall_index: number, offset_m: number, segment: [[x,y],[x,y]] }[], summary: string }
```

## REST (D mounts everything in `server/main.py`; C ships `capture/router.py` with `router = APIRouter(prefix="/api/capture")`)

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/api/sites` | | `Site[]` |
| POST | `/api/sites` | multipart: `lat, lon`, optional `name` (falls back to `address`, then coordinates), `address`, `kind`, `width_m` (longest building side), `file` (building.json or one plan) and/or repeated `files` (floor-plan / escape-plan photos, PNG/JPG/WebP/PDF), `preview=true`, `site_id` (confirm: reuse the preview's id) | `Site` (+ `warnings`); preview returns `SiteDraft {site_id, building, warnings, extractions, matches}` without saving. Plans of one storey are stitched, storeys stacked and linked by stair/lift connectors; `building.building.plans[]` lists each image's storey and its `transform` (SVG matrix, normalised 0..1000 image coords → metres). On confirm, building.json + images are sent together and the images are kept in `storage/sites/<id>/plans/` |
| POST | `/api/sites/restitch` | `{extractions, matches?, level_overrides: {image_index: level}, site_id?, name?, address?, lat?, lon?, width_m?}` | `SiteDraft` (no Claude call) |
| POST | `/api/sites/{id}/rebuild` | | re-stitch a saved floor-plan site from `plans/extractions.json` (no Claude call); `Site` + `warnings`, old file kept as `building.prev.json` |
| GET | `/api/geocode` | `?q=&lat=&lon=` (lat/lon bias) | `{label, lat, lon}[]` (Photon, Nominatim fallback) |
| GET | `/api/geocode/reverse` | `?lat=&lon=` | `{label, lat, lon}` |
| GET | `/api/sites/{id}/building` | | raw `building.json` (with added doors) |
| GET | `/api/sites/{id}/state` | | `SiteState` |
| POST | `/api/sites/{id}/route` | `{from, to, step_free?, min_width_m?, via?}` (ids, refs or names) | `Route` |
| GET | `/api/sites/{id}/reachable` | `?from=&step_free=&min_width_m=` (same rules and live closures as `/route`) | `{from_space_id, step_free, min_width_m, space_ids}` |
| POST | `/api/sites/{id}/closures` | `{element_id, closed}` | `SiteState` (+ `closure` event) |
| POST | `/api/sites/{id}/assets/{asset_id}/move` | `{space_id, position?}` | `SiteState` (+ `asset_moved` event) |
| GET | `/api/sites/{id}/events` | `?since=ISO&limit=` | `Event[]` newest first |
| GET | `/api/sites/{id}/rooms/bookable` | `?start=ISO&end=ISO&people=` | `BookableRoom[]` |
| GET/POST | `/api/sites/{id}/bookings` | POST `{space_id, start, end, who, title}` | `Booking[]` / `Booking` (+ `booking` event) |
| POST | `/api/sites/{id}/chat` | `{session_id, message, here?: space_id}` | `text/event-stream`, see below |
| POST | `/api/voice/stt` | multipart `audio` | `{text}`; **501** without `ELEVENLABS_API_KEY` |
| POST | `/api/voice/tts` | `{text}` | `audio/mpeg`; **501** without key (frontend falls back to Web Speech) |
| POST | `/api/capture/delivery` | multipart: `site_id, photos[]`, optional `declared_w, declared_d, declared_h, target_space, label, note` | `CaptureJob` |
| POST | `/api/capture/room` | multipart: `site_id, space_id, video` (or `splat` file upload) | `CaptureJob` |
| GET | `/api/capture/jobs/{job_id}` | | `CaptureJob` |
| GET | `/api/capture/marker.pdf` | | printable A4 ArUco marker |
| GET | `/storage/...` | | static files (photos, GLBs, splats) from `storage/` |

Errors: `{"detail": "human readable"}` with 4xx.

### Chat stream (`text/event-stream`)

```
event: action    data: {"type": "set_location", "space_id": "..."} // sync the viewer after each turn
event: delta     data: {"text": "partial reply text"}
event: action    data: {"type": "show_route", "route": Route}
event: action    data: {"type": "highlight", "ids": ["...asset/space ids"], "label"?: string}
event: action    data: {"type": "focus_floor", "floor_id": "..."}
event: action    data: {"type": "understood", "chips": ["from: Lobby 0.01", "to: CNC mill", "step-free"]}
event: action    data: {"type": "state_changed"}          // re-fetch /state
event: done      data: {"reply": "full reply text"}
```

## WebSocket `/ws`

Server → client only, JSON messages. Clients filter by `site_id`.

```
{"type": "event", "event": Event}
{"type": "capture_progress", "job": CaptureJob}
```

C publishes through `server.ws.broadcast(message: dict)` (async), which D provides. Until D lands it, C calls it behind a try/except import.

## Storage

- SQLite: `storage/sitetwin.db` (SQLModel; D owns the schema, C may add a `capture_jobs` table in `capture/`).
- Files: `storage/sites/<site_id>/…`, `storage/captures/<job_id>/…`, served at `/storage/`.
- Sites list: `data/sites.json`, generated by `scripts/geocode_sites.py` (OSM + procedural buildings from all splits; OSM via Overpass `way(id);out center;`, procedural get plausible Munich industrial-area coordinates with `demo_location: true`).

## Env (`.env`, all optional except Anthropic)

`ANTHROPIC_API_KEY`, `FAL_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `MAPTILER_KEY` (frontend: `VITE_MAPTILER_KEY`). Every integration must degrade gracefully when its key is missing.

## Run

```bash
uv run uvicorn server.main:app --reload --port 8000
cd web && npm run dev        # http://localhost:5173, proxies /api, /ws, /storage to :8000
```

## Changelog
- v1: initial contract (lead).
- v1.1 (A, additive only): `find_route(..., closed=set())` adds per-call closures on top of `bm.closed` and returns `SiteRoute` (a `RouteResult` plus `nodes`, `min_width_m`). `route_payload(route, *, blocking=None, raw=False)`: `route=None` gives an unreachable Route, `blocking` fills `blocking_openings`, and `raw=True` keeps every anchor point (by default, pass-through corridors are drawn door to door). Each connector entry also has a `name`. `blocking_openings` lists doors only, not stairs. Extra helpers: `bm.distances_from`, `bm.entrance_distances`, `bm.element_path`, `bm.spaces_on_floor`, and in geometry `centroid_3d`, `distance_3d`, `stacked_candidates`, `shared_wall_midpoint`, `asset_footprint`. `footprint_fits` takes optional `clearance_m` and `ignore_asset_ids`. `shared_walls` also leaves out `outdoor` spaces (balconies), which matches every labelled question. Benchmark solvers are in `core/solvers.py`.

## Cross-owned React components (props are fixed; owners fill in the bodies)

| Component | Owner | Props | Rendered by |
|---|---|---|---|
| `web/src/chat/ChatPanel.tsx` | D | `{ siteId: string }`; dispatches chat actions into `useTwin` | SitePage (B) |
| `web/src/sites/AddSiteDialog.tsx` | D | `{ lat?, lon?, pickSeq?, picking?, onPickOnMap?(current), onCancelPick?, onClose, onCreated(site) }` (stays mounted while `picking`; MapPage forwards map picks) | MapPage (B) |
| `web/src/capture/CaptureQR.tsx` | C | `{ siteId: string }` | SitePage (B) |
| `web/src/capture/DeliveryCard.tsx` | C | `{ delivery: Delivery }` | SitePage (B) |

### v1.2 — integration completion

- Chat accepts optional `here` (validated before streaming). A `set_location` action returns the session's current space after each turn, including spoken location changes. The viewer and chat share the same default origin.
- Route responses retain `from_space_id`, `to_space_id`, and resolved `via` on both success and failure. Replanning after live changes preserves constraints and waypoints and retries previously blocked routes.
- Site upload supports `preview=true`. The UI reviews the returned geometry and warnings, then submits the reviewed building JSON to create the site. Image plans can be overlaid using `building.scale`; PDF plans show the extracted layout.
- Room scans use the existing optional `ts` to respect the timeline. GPU resources are created and disposed within effects, including StrictMode remounts.
- Booking search refreshes on live booking events. Added-door events refresh the building geometry.
- `SITETWIN_API_URL` optionally overrides the Vite development/preview proxy target (default `http://localhost:8000`).
