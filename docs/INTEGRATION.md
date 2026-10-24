# Integration status

Verified 24 October 2026 against an isolated SQLite/files directory, with the real FastAPI server and Vite frontend. API-dependent paths used the application's explicit no-key fallback. Existing saved demo data was not reset.

## Evaluation of the interrupted work

The core, server, capture pipeline, map and most 3D features were already implemented. The frontend compiled and the original 54 Python tests passed. The unfinished scan viewer was a real runtime defect: StrictMode disposed a memoized SplatMesh and reused it with zero splats. Chat and the viewer also used different locations, blocked routes never recovered automatically, and open booking lists did not refresh after another client booked a room.

## Completed

- Correct Gaussian-splat lifecycle: the bundled scan now loads all 25,048 splats; new captures refresh the open scene, follow animated floor heights, and respect timeline timestamps. Failed scan downloads show a message while retaining the wall measurements.
- Delivery capture produces a measured, textured fallback GLB and appears in the open twin via WebSocket. GLB placement was already implemented and is now verified.
- Bidirectional location synchronization: a location selected in the twin is sent with chat; “I'm in Office 0.30” updates the viewer's route origin. Both start in Office 1.04 for the hero demo.
- Chat routes reveal all traversed floors. Route refresh retains endpoints, waypoints, accessibility and width requirements, including after a route becomes unreachable. Reopening the lift restores the route.
- Booking availability refreshes across open tabs, with stale search results hidden when the search window changes.
- Site uploads now show room/door geometry, scale and inferred-connectivity warnings before saving. Image plans have an overlay; PDFs show the extracted layout. Confirming saves the reviewed JSON without another vision request.
- Live added doors refresh geometry; late responses cannot overwrite another site's route or chat state. Site-load errors remain visible.
- Plain `uv run pytest` now resolves the project packages. Vite preview proxies the backend, so the production bundle can be tested locally.

## Verification

| Check | Result |
|---|---|
| Python suite | 58 passed; includes location synchronization, invalid locations, reopening with waypoints, and preview-before-save regressions |
| Frontend production build | Passed |
| Frontend lint | No errors; graphics/hooks/style warnings remain |
| Scored dev benchmark | 138 / 138 |
| Scored train benchmark | 515 / 517; unchanged ambiguous duplicate-room names |
| Warm-up dev oracle | 369 / 369 |
| Test submission generation | 145 answers; written separately during verification |
| Browser: map → site | Passed |
| Browser: scan loading + room-capture refresh | Passed |
| Browser: chat/viewer location, multi-floor route, lift closure/reopening | Passed |
| Browser: booking in two tabs | Passed |
| Browser: phone sample → measured delivery → GLB → live twin | Passed |
| Browser: layout review → confirm → new site | Passed |
| Browser: unknown site error screen | Passed |
| Production browser: twin + streamed route | Passed, no page errors |

## Run and demonstrate

```sh
uv sync
uv run uvicorn server.main:app --reload --port 8000
# In another terminal:
cd web
npm install
npm run dev
```

Open the URL printed by Vite. For a phone, use Vite's network URL on the same Wi-Fi (the capture QR panel provides it).

1. Search the map for **Fertigung Ost 27** and enter it.
2. Ask “Take me to Quality lab 0.21 without stairs.” The default origin is upstairs in Office 1.04, so the route uses the office lift.
3. Ask “Close the office lift,” then “Reopen the office lift.” The step-free route becomes blocked, then returns.
4. Select **Rooms**, search availability and book a room while a second tab displays the same search.
5. Open the capture page, choose **Use a sample photo**, then **Measure & check**. The textured fallback model appears in the twin; the UI reports the actual measured tolerance.
6. In **Room scan**, choose Meeting room 0.20 and submit without a file. The labelled demo scan deliberately differs from the north wall by about 0.4 m. The capture event focuses the room when selected in Changes.
7. Use **Add Standort**, upload a building JSON, review the floor layout, then confirm. PNG/JPEG/PDF parsing needs an Anthropic key.

For a week of demo events, `uv run python scripts/seed_demo_events.py` seeds sites without events. The `--reset` option replaces existing hero-site event history, so use it only when intentionally resetting the demo. Bookings use dates relative to the machine's current date.

Validation commands:

```sh
uv run pytest -q
uv run --env-file .env python -m benchmark.evaluate data/dev --agent agent.answer:answer
uv run python -m starter_agent.evaluate data/dev --oracle
cd web
npm run build
npm run lint
npm run preview
```

Set `SITETWIN_STORAGE` to an alternate directory before starting the backend for an isolated demo. Set `SITETWIN_API_URL=http://localhost:8011` before starting Vite to target a server on another port.

## Remaining service-dependent work and limits

- Anthropic chat/vision, fal.ai image-to-3D, ElevenLabs and Modal GPU reconstruction have not been exercised against live services in this integration pass. They require keys; Modal also requires deploying its worker and installing its optional client. No claim of live phone-video reconstruction is made here.
- No-key image-to-3D produces a textured crate/pallet, and no-key room reconstruction uses a labelled procedural scan. These are usable demonstration paths, not a reconstruction of the uploaded physical object/room.
- One photo generally has ±8–10 cm measurement uncertainty; use the returned tolerance rather than promising ±3 cm. Physical phone-camera/printed-marker measurements still need an on-site check.
- The hero site's office wing has no wider detour for oversized deliveries: a blocked result is correct. Alternative-route logic is covered in the capture tests; do not promise a detour for every destination.
- The production map/3D bundles are large (Vite emits a size warning). This is a local hackathon build; preload the site before presenting. Map tiles need network access.
- PDF review currently displays the extracted geometry rather than rasterizing the source PDF underneath it.
