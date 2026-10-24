# SiteTwin: a living 3D twin for every Standort (Track 01)

The interrupted integration is now completed and checked against the real local backend. See [integration status and demo steps](docs/INTEGRATION.md) for verified features, commands, and the external services that still need live validation.

Quick start: `uv run uvicorn server.main:app --reload --port 8000`, then `cd web && npm run dev`. The application works without API keys using its labelled fallback paths.

Native iOS app (Flutter UI, SceneKit twin, same backend): lives on its own branch, `feat/flutter-ios` (`git switch feat/flutter-ios`). See `mobile/README.md` on that branch for the architecture, the backend ↔ app data flow and how to run it on an iPhone from Xcode.

## iOS app (Capacitor)

The web app also runs as a native iOS app: Capacitor packs the built frontend into a native shell (`web/ios/`).

The app is self-contained, with no server, tunnel, account or API keys. It bundles 66 buildings, routes in a web worker, and keeps bookings, closures, asset moves, equipment and deliveries (with photos or logged by hand) on the phone. It also shades the reachable area and has a local command assistant. Cloud AI, voice and automatic measurement need the online backend and are not included. Python runs only on the development machine, to export the buildings. In the browser, `npm run dev` still uses the backend. See [local implementation and limits](docs/LOCAL_FIRST_IOS_PLAN.md) and [TestFlight build steps](docs/TESTFLIGHT.md).

### Requirements

- A Mac with Xcode, with the command line tools pointing at it: `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
- Node.js 22 (22.12 or later) or 24 or later. The test runner (vitest) does not officially support Node 23.
- `uv`, because the build exports the buildings and routing graphs with the Python core.
- An Apple ID added in **Xcode → Settings → Accounts**. A free personal team is enough for your own iPhone.
- An iPhone with iOS 15 or later, and a USB cable for the first install.

These steps were checked with Xcode 27.1 and Node 23.11: a simulator build, and a Debug build installed and started on an iPhone with iOS 27.0.1, signed with a free personal team (terminal route below).

### 1. Build

```bash
cd web
npm ci
npm run build:local   # exports the buildings with uv, then builds the frontend in local mode
npx cap sync ios      # copies the build and capacitor.config.json into the Xcode project
npx cap open ios      # opens the project in Xcode
```

Repeat `npm run build:local` and `npx cap sync ios` after every frontend change. The files that `cap sync` copies are git-ignored, so a fresh checkout does not build in Xcode until you have run it.

To try the app in a browser first, without Xcode or a server, run `npm run dev:local`. `npm run test:local` checks the local routing against Python-generated cases and tests the local state.

### 2. Install on your iPhone

1. Connect the iPhone with the cable, unlock it and tap **Trust**.
2. In Xcode, select the **App** project, then the **App** target, then **Signing & Capabilities**.
3. Turn on **Automatically manage signing** and choose your team.
4. Unless you are in the project's team (`CV955K8T33`), change the bundle identifier from `com.sitetwin.app` to something unique, for example `com.yourname.sitetwin`; the original ID belongs to that team. Don't commit your team or bundle ID. TestFlight builds depend on the project's values.
5. On the iPhone, open **Settings → Privacy & Security → Developer Mode**, turn it on and restart the phone. The switch appears only after the phone has been connected to Xcode once.
6. Select your iPhone in Xcode's run-destination menu and press **⌘R**. The first build also downloads the Capacitor Swift packages.
7. If iOS reports an untrusted developer on first launch, open **Settings → General → VPN & Device Management**, trust your Apple ID and start the app again.

The app then starts from the home screen without Xcode. Installs signed with a free personal team expire after 7 days; press **⌘R** again to renew.

**From the terminal**, without changing the Xcode project: pass your team ID and your own bundle ID on the command line. Steps 1, 5 and 7 above still apply. Run this in `web/` after the build steps:

```bash
defaults read com.apple.dt.Xcode IDEProvisioningTeamByIdentifier | grep -E 'teamID|teamName'   # your team ID
xcrun devicectl list devices                                                                  # your iPhone's identifier
xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Debug \
  -destination 'id=<identifier>' -derivedDataPath ~/Library/Developer/Xcode/DerivedData/SiteTwin-device \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<team ID> PRODUCT_BUNDLE_IDENTIFIER=com.yourname.sitetwin build
xcrun devicectl device install app --device <identifier> \
  ~/Library/Developer/Xcode/DerivedData/SiteTwin-device/Build/Products/Debug-iphoneos/App.app
xcrun devicectl device process launch --device <identifier> com.yourname.sitetwin
```

Use a bundle ID that differs from the Flutter app's (`com.sitetwin.sitetwin`); otherwise installing one app replaces the other on the phone.

### 3. TestFlight (project team only)

Members of team `CV955K8T33` can share the app without a cable:

```bash
cd web
npm run ios:archive
```

The script builds local mode, checks that the bundle contains the buildings and loads no server, and writes a signed archive to `~/Library/Developer/Xcode/Archives/`. In Xcode, open **Window → Organizer**, select the archive and choose **Distribute App → TestFlight & App Store**. It uploads to the existing App Store Connect record `forklift_navi`. Build 2 has already been uploaded, so let Xcode raise the build number. Testers install the app from TestFlight.

### Troubleshooting

- **"Failed to register bundle identifier" or no signing certificate:** change the bundle identifier (step 4 above) and check the team.
- **The build cannot find `public` or `capacitor.config.json`:** run `npm run build:local` and `npx cap sync ios` first.
- **Code signing fails with "resource fork, Finder information, or similar detritus not allowed":** the build products ended up in a folder synced by iCloud (Desktop or Documents). Keep Xcode's DerivedData in its default location under `~/Library/Developer/Xcode/`.

## What is still missing

**Not yet verified**
- The iOS Release archive compiles and its signature verifies. A Debug build installs and starts on a physical iPhone (iOS 27.0.1, free personal team); the Release archive has not been run on a device yet.
- Live external services have never been tested with real keys: Anthropic chat and vision, fal.ai image-to-3D, ElevenLabs voice and Modal GPU reconstruction. Modal also needs its worker deployed and the optional client installed.
- Physical capture with a phone camera and the printed marker has only been tested with sample images.

**Missing for iOS**
- **Local feature boundary.** The native app supports offline workflows. General cloud AI, voice, automatic measurements, floor-plan interpretation and room reconstruction remain online backend features; the local UI explains these limits.
- **Device-local state.** Bookings and edits are not synchronized between phones. Export a backup before uninstalling or resetting the app.
- **No App Store assets.** The app icon and splash screen are still Capacitor's defaults. The privacy policy and App Store listing are also missing. Apple may reject an app that only loads a remote URL, so plan for TestFlight only.
- **No phone performance check.** Gaussian splats and post-processing have not been tested on iPhone GPUs.
- **Speech recognition may fail.** The browser speech-recognition fallback probably does not work in the iOS WebView. Voice depends on the server `/api/voice/stt` path, which needs `ELEVENLABS_API_KEY`.

**Fallbacks and limits**
- Without keys, image-to-3D produces a generic textured crate or pallet, and room reconstruction produces a labelled procedural scan. Neither reconstructs the actual object or room.
- One photo gives about ±8–10 cm measurement uncertainty, not ±3 cm.
- Parsing PNG, JPEG and PDF floor plans needs an Anthropic key. The PDF review shows only the extracted geometry, without the source PDF underneath.
- The hero site has no wider detour for oversized deliveries, so a "blocked" result there is correct.

**Quality**
- The team flagged 3D render quality as poor in commit `f4429c9`, along with one unfinished task that isn't named. Neither is resolved.
- The train benchmark scores 515/517. The two failures are ambiguous duplicate room names.
- Frontend lint passes, but warnings about graphics, hooks and style remain.
- Vite warns about large optional map/scan chunks. The local app opens a bundled catalog and lazy-loads buildings and 3D assets; remote map tiles are not required.

Details and verification results: [docs/INTEGRATION.md](docs/INTEGRATION.md).

---

The original project plan follows.

## First step (housekeeping)
- `git mv README.md outdated_organizer_info.md`, so the organizers' brief and the data format reference are kept.
- Save this plan as the new `README.md`.
- Update links that point to the old README, for example `starter_agent/README.md` → `../outdated_organizer_info.md`.

## Context

The repo is the Track 01 student kit (`industrial-agents-hackathon-2026`). It contains 280 buildings in a common `building.json` format, a starter agent (Claude with deterministic routing in `starter_agent/building_map.py`), and a scorer. The judging weights are: **55 pts for the benchmark** (unseen buildings and questions about areas, door widths, reachability, stacked rooms, shared walls, 3D distances and what-if doors), 25 for Interaction, 10 for Creativity and 10 for the demo video.

Your idea:
- A map of Standorte (sites). Each site has schematics that become a 3D layout.
- Phone video or photos become 3D: a room scan, or a new delivery dropped into the twin.
- Measured dimensions are cross-checked against the layout JSON.
- Inside a site: recent deliveries and changes, navigation, and meeting-room booking.

**Decisions made:**
1. **One shared Python core** powers both the benchmark answers and the app, so every visual is backed by tested logic.
2. **Hybrid, demo-safe capture.** A photo becomes a 3D model through a cloud API, scaled metrically by a printed marker. A room video becomes a Gaussian splat on a cloud GPU, with a pre-recorded scan as backup.
3. **3–4 people, about 24–36 h**, working in parallel workstreams.

Covering the README levels:
- Map, sites and multiple buildings → Level 3
- Schematics → building → Level 4
- Capture, deliveries and live changes → Level 5 ("Capture on site" plus "Make things move")
- Visuals and voice → Interaction and Presentation

---

## Product: what the jury sees (3-min demo script)

1. **Globe → fly-in.** A dark 3D globe spins, then the camera flies to Munich. Glowing site pins sit on 3D terrain and extruded city buildings, and animated deck.gl arcs show deliveries moving between sites.
2. **Enter a site.** Click "Fertigung Ost 27". The map building **rises out of the ground** and its floors separate into an isometric **exploded stack**, with bloom, soft shadows and assets as instanced 3D models.
3. **Talk to it (voice).** *"Where's the steel drum that came in yesterday?"* The agent answers and highlights the drum with a pulse ring. *"Take me there without stairs."* An **animated light-trail route** flows across floors through the lift, and the camera follows it.
4. **Live change.** Click the east lift → "closed". The route **re-plans in real time** and the closed lift glows red.
5. **New delivery from a phone.** Scan a QR code on screen, which opens the capture page on the phone. Photograph a pallet next to a printed A4 marker. About 30 s later the **3D model drops into Dock B** with its measured dimensions: *"1.32 × 1.05 × 1.4 m. Matches PO (1.30 × 1.00). ⚠ It won't pass door 0.14 (1.2 m) on the way to Assembly 0.21. Alternative via hall gate: 84 m."* The blocking door flashes red, then the alternative route appears.
6. **Room scan.** A walk-through video of a room becomes a **Gaussian splat** fitted inside the floor-plan walls. A deviation heatmap shows where reality differs from the plan, for example *"north wall 0.4 m off plan"*.
7. **Book a room.** *"Free room for 6 people at 14:00 near me?"* Capacity comes from the chair count in the room. Free rooms glow green and the booked room turns blue, with a navigation button.
8. **Timeline scrubber.** Drag back through the last 7 days: deliveries fade in and out and assets slide to their old positions.

---

## Architecture

```
Phone (/capture PWA) ──photos/video──┐
                                      ▼
Web app (Vite+React+R3F+MapLibre) ⇄ FastAPI server ──► core/ (BuildingMap+geometry+reachability)
   ▲ WebSocket live events            │  ├─ agent/ (Claude tool runner, vision parsers)
   └──────────────────────────────────┤  ├─ capture/ (ArUco scale, fal.ai image→3D, Modal splat job)
                                      │  └─ SQLite (sites, events, deliveries, bookings, captures)
benchmark CLI ── agent/answer.py ─────┘  (same core, no server)
```

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend shell | **Vite + React 19 + TypeScript**, Tailwind v4, **shadcn/ui**, framer-motion, zustand, TanStack Query | Fast to build, and Lovable credits can scaffold the panels in the same stack |
| Map | **MapLibre GL JS** with globe projection, OpenFreeMap/MapTiler vector tiles, terrain and 3D building extrusions. **deck.gl** for ArcLayer (delivery flows), ScatterplotLayer pulses and IconLayer pins | Free, no vendor lock-in, impressive globe-to-street transition |
| 3D building | **react-three-fiber + drei** (extruded polygons, `Instances` for assets, `CameraControls`, `Environment`, `ContactShadows`) and **@react-three/postprocessing** (Bloom, N8AO, ToneMapping, Vignette) | The "wow" layer |
| Routes | Custom shader on `TubeGeometry`: flowing dashes plus an emissive head, a moving avatar, and floor-hop arcs | Animated routes are explicitly valued in the brief |
| Splats | **Spark** (`@sparkjsdev/spark`), a three.js Gaussian splat renderer, loading `.spz`/`.ply` in the same R3F scene | The splat and the floor plan share one scene and one transform |
| Backend | **FastAPI** + uvicorn, Python 3.12, **SQLModel/SQLite**, WebSocket for live events, local `storage/` for files | Reuses the networkx/shapely core directly |
| Agent | **Anthropic SDK**: `claude-opus-5-5` for conversation and tools, `claude-haiku-5-5` for cheap parsing, vision for floor plans and delivery photos. Prompt caching for building context | The kit already uses the tool-runner pattern |
| Voice | **ElevenLabs** (Scribe STT plus streaming TTS, organizer credits), with the Web Speech API as fallback | Voice counts toward Interaction |
| Object 3D | **fal.ai** image-to-3D (Hunyuan3D-2 / TRELLIS) → GLB. **OpenCV ArUco** marker gives the metric scale. Claude vision returns the object bbox and a label | Takes about 30 s, and the result has real dimensions |
| Room splat | **Modal** GPU function: ffmpeg frames → COLMAP/GLOMAP + gsplat (splatfacto) → `.spz`. A pre-captured Scaniverse/Polycam `.spz` of the venue is the backup | Live where possible, safe for the demo |
| Geocoding | One-off script that resolves OSM way IDs to lat/lon through the Overpass API (cached to `data/sites.json`). Procedural buildings get plausible Munich industrial-area coordinates, marked as demo | Puts real sites on the map |

## Repo layout (new code; `starter_agent/` and `benchmark/` stay untouched)

```
core/        building_map.py (moved/extended from starter_agent), geometry.py, reachability.py, whatif.py
agent/       tools.py, prompts.py (chat agent), answer.py (benchmark agent, `agent.answer:answer`)
server/      main.py, routes/{sites,buildings,route,events,bookings,capture,chat}.py, db.py, ws.py
capture/     aruco.py, image_to_3d.py (fal), splat_job.py (Modal), dimension_check.py, align.py
scripts/     geocode_sites.py, seed_demo_events.py, print_marker.py
web/         Vite app: routes /, /site/:id, /capture; components Map/, Twin3D/, Chat/, Timeline/, Booking/
SUBMISSION/  BENCHMARK.md + answers.json (graded benchmark submission)
```

---

## Workstreams (4 people)

### A. Core and benchmark (Python), the 55-pt engine
- Extend `BuildingMap` (`starter_agent/building_map.py`: `graph()`, `route()`, `resolve_space()`, `add_door()`) in `core/` with:
  - `room_area`, `largest_room`, `floor_area_total`
  - `reachable_spaces(entry, min_width, step_free, closed)`: wide delivery and step-free counts
  - `room_above/below` (max polygon overlap on the adjacent floor)
  - `shared_walls(space, min_len=1.0, tol=0.35)` using a shapely buffer intersection
  - `centroid_3d` and its distance
  - `what_if_door` (door at the midpoint of the shared wall; recompute nearest-entrance distances on the target floor)
  - `errand` (nearest room containing an asset type, then a route to the target)
- `agent/answer.py`: Claude reads the question, calls these tools and ends with `Answer: …`. For speed and cost, a Haiku classifier maps each question kind to a deterministic solver, and Opus is the fallback.
- Use the dev set to verify route lengths to the centimetre against `questions_basic.jsonl` (the oracle mode already exists in `starter_agent/evaluate.py`), then reach >90% on dev `questions.jsonl`.
- Write `BENCHMARK.md` with a single command, then generate the test CSV.
- These same functions back the app features: wide-delivery fit check, booking capacity and the deviation checks.

### B. Map and 3D twin (frontend), the visual star
- Globe → site fly-to. On site click, crossfade from the MapLibre camera into the R3F scene with matching camera pose.
- `BuildingMesh` extrudes the floor polygons:
  - Walls are the outline polygons buffered inward by 0.15 m, and doors are gaps cut at opening positions.
  - Floors are glass-like slabs. Room types are colour-coded with a soft palette, and labels are drei `Html`.
- Exploded and stacked floor toggle with a spring animation. Floor focus mode dims all other floors.
- Assets: instanced boxes from the footprints, with a few hero GLBs (press, CNC, forklift, pallet).
- Route renderer, closure states (pulsing red), booking states (green/blue glow), delivery drop-in animation plus pulse ring.
- Timeline scrubber that replays the event log over the scene.

### C. Capture pipeline (phone → 3D → cross-check)
- `/capture` mobile page, opened by a QR code on the desktop:
  - Camera via `getUserMedia`, multi-photo or video upload.
  - Fields: delivery-note number, expected dimensions (optional), target room.
- **Object flow:**
  1. ArUco detection gives pixels per metre on the marker plane.
  2. Claude vision returns the object bbox and label ("pallet with steel drum").
  3. The marker scale gives estimated W×D×H, shown with a ±tolerance.
  4. fal image-to-3D produces a GLB, rescaled to the measured bbox.
  5. The delivery is saved and broadcast over the WebSocket.
- **Cross-check (`dimension_check.py`):**
  1. Measured dimensions vs the PO/declared dimensions, or vs an `equipment.csv` asset of the same type.
  2. Route fit: run `reachable_spaces` with `min_width = item width` from the entrance or dock to the target. Doors that block it are returned.
  3. Floor fit: target room polygon minus the existing asset footprints, then a shapely check that the footprint fits in some orientation.
- **Room flow:**
  1. Video → Modal splat job → `.spz`.
  2. `align.py`: the user clicks 2 room corners in the splat, which gives a similarity transform to the plan polygon.
  3. Deviation check: the splat's floor-level extent vs the polygon gives per-wall offsets and a heatmap.
- Have the backup `.spz` ready from H6.

### D. Agent, voice and app features (full stack)
- FastAPI routes plus the WebSocket event bus. SQLite tables:
  - `sites`: id, name, lat/lon, building_path
  - `events`: ts, site, type, payload. Types: delivery, asset_moved, closure, booking, door_added
  - `deliveries`
  - `bookings`: space_id, start, end, who
  - `captures`
- Chat panel: streaming responses, plus "what I understood" chips before edits. This is the README's Interaction rubric: ask back when the request is vague, show the interpretation before changing the plan.
- Agent tools, on top of A's tools:
  - `locate`, `route` (the frontend animates it)
  - `set_closed`, `move_asset`, `add_door`
  - `recent_changes(since)`, `find_delivery(desc)`
  - `free_rooms(time, people)` (capacity = chairs in the room, or area/2.5 m²) and `book_room`
  - Landmark directions ("turn left at the press": nearest asset to each turn)
- **Add a site:**
  1. Click on the map and name the site.
  2. Upload a floor-plan PNG/PDF.
  3. Claude vision returns `spaces` + `openings` JSON.
  4. A review overlay shows the result on top of the image, and the user confirms.
  5. A reachability sanity check runs, then the building is saved.
  This covers Level 4 (also accepts `building.json` directly).
- Voice: push-to-talk → ElevenLabs STT → agent → TTS.
- `scripts/seed_demo_events.py` adds a week of plausible deliveries and changes so the timeline looks alive.

## Execution: agent team

1. **Lead (me)** does the housekeeping step, then scaffolds the repo:
   - `pyproject.toml` deps (fastapi, uvicorn, sqlmodel, opencv-contrib-python, httpx, pytest) and the `web/` Vite app with its deps.
   - `docs/CONTRACT.md` with the REST/WebSocket endpoints, the event schema and the route payload.
   - Committed so all agents start from the same base.
2. **Spawn 4 agents in parallel** in the same checkout. Each owns disjoint directories, so they don't conflict:
   - **A, Core and benchmark:** `core/`, `agent/answer.py`, `BENCHMARK.md`, `tests/`. Must report its dev score per kind.
   - **B, Map and 3D twin:** `web/` (Map, Twin3D, Timeline, Booking UI).
   - **C, Capture:** `capture/`, `web/src/capture/` (mobile page only), `scripts/print_marker.py`.
   - **D, Server, agent and voice:** `server/`, `agent/tools.py`, `agent/prompts.py`, `scripts/geocode_sites.py`, `scripts/seed_demo_events.py`, `web/src/chat/`.
3. External APIs (fal.ai, Modal, ElevenLabs, Overpass) are wired to read keys from `.env` and degrade gracefully when keys are missing: backup models, the backup splat, Web Speech. Nothing is blocked on keys.
4. The lead integrates: runs the server and web app, the dev benchmark and the e2e checks, fixes the seams, and reports the results. Nothing is pushed until you say so.

## Milestones and cut lines

| Hour | Milestone |
|---|---|
| 0–2 | Agree on the data model and API contract (event schema, route payload `{floors:[{floor_id, points}]}`). Scaffold repo, web app, server. Geocode the sites. |
| 8 | One factory floor end to end: 3D extruded floor, chat → animated route. Benchmark solvers working for 4 of 9 kinds. |
| 16 | Map → site transition, multi-floor exploded view, closures, bookings, timeline. Photo → GLB → drop-in works. All 9 benchmark kinds. |
| 24 | **Feature freeze.** Splat live or backup, voice, add-site flow. Dev benchmark >90%, test CSV generated. |
| 24–30 | Polish visuals (post-processing, camera choreography), record the demo video, write the technical explanation and `BENCHMARK.md`. |

**Cut in this order if behind:**
1. Live splat training (use the backup scan)
2. Room deviation heatmap
3. PDF floor-plan parsing (keep PNG)
4. Timeline replay (keep a list)
5. Voice TTS (keep STT)

**Never cut:** the benchmark core, animated routes, the delivery fit check.

## Risks

- **Image-to-3D quality or latency.** Pre-generate hero models for the demo items. The live run is a bonus.
- **Splat training time on stage.** Show a pre-trained scan and say how long the live pipeline takes.
- **Scale accuracy.** Show the measured tolerance returned by the pipeline and keep the marker in every shot. A single photo is typically ±8–10 cm; tighter estimates need several views.
- **OSM licence.** Keep the ODbL attribution in the map footer and the 3D view (`ATTRIBUTION.md`).
- **Swiss Dwellings floors are not aligned.** Stack them by centroid in the viewer only. The core and benchmark keep the raw coordinates.

## Verification

- `uv run python -m starter_agent.evaluate data/dev --oracle` still passes, then the same oracle check is run against `core/` (route lengths to the cm).
- `uv run --env-file .env python -m benchmark.evaluate data/dev --agent agent.answer:answer` reports the score per kind, with a >90% target. Then generate `team_<name>.csv` on test and validate it with `benchmark/score.py` formatting.
- pytest for the geometry helpers on 2–3 dev buildings: areas, shared walls, room above, what-if.
- Manual end-to-end in the browser:
  1. Globe → site → 3D.
  2. A voice question gives an animated multi-floor route, and closing a lift re-plans it.
  3. Phone capture with the marker → model in the dock, with dimensions, a correct pass/fail on door width, and a correct alternative route.
  4. Booking shows up for a second browser tab over the WebSocket.
  5. Splat loads aligned inside the walls.
- Run the 3-min demo script twice on a clean DB seeded with `seed_demo_events.py` before recording.
