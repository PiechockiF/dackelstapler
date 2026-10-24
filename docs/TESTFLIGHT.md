# SiteTwin local iOS build and TestFlight

Branch: `ios_build_local`. Bundle ID: `com.sitetwin.app`. App Store Connect record:
[`forklift_navi`](https://appstoreconnect.apple.com/apps/6826578119/testflight).
Developer team: `CV955K8T33` (FRANCISZEK PIECHOCKI). Version: `1.0`; build: `2`.

## Build and verify

```sh
cd web
npm ci
npm run test:local
npm run build:local
npm run preview
npm run ios:archive
```

Python/uv is needed on the development machine to export the 66 mobile buildings
and exact routing graphs. It is not needed on the phone. `test:local` regenerates
2,178 Python routing cases and checks TypeScript costs/reachability, plus storage,
transaction failures, booking conflicts, assistant commands, and route races.
The Python suite is still run from the repo root with `uv run pytest -q`.

The archive command builds local mode, syncs Capacitor and verifies that the native
bundle contains the catalog and has no remote `server.url`. It does not require
`CAP_SERVER_URL`; it clears live-reload overrides. Archives and derived data live
under `~/Library/Developer/Xcode/`, outside Desktop/iCloud, avoiding signing failures
from Finder metadata. The native Filesystem plugin and privacy manifest are included.

## Upload

Open the new `.xcarchive` in Xcode Organizer and choose **Distribute App → TestFlight
& App Store**. Use automatic signing; Xcode can manage the next available build
number. Then check processing in the existing App Store Connect record and enable
the build for the existing internal testing group. No USB connection is needed.

Build `1.0 (2)` uploaded successfully on 24 October 2026. Its archive is
`~/Library/Developer/Xcode/Archives/2026-10-24/SiteTwin-release-15-41-46.xcarchive`.
Apple processing/compliance and the internal group's **Testing** status have not
yet been confirmed for build 2. Upload success alone is not that confirmation.
Build `1.0 (1)` is the earlier disconnected shell. Install build 2 to get the offline implementation. The generated
archive is development-signed; Xcode handles distribution signing during upload.

## Local behavior and limits

- The first screen is a bundled, searchable catalog. Buildings load individually.
- Routing runs in a worker using exported Python anchors/parallel edges. Closures,
  waypoints, accessibility and load widths affect actual route computation.
- Local bookings, edits, events and delivery metadata use versioned IndexedDB.
  iOS photos/thumbnails use the app's native Library directory; preview mode uses
  IndexedDB blobs. No server or account is involved in these workflows.
- **Export backup** includes structured records and photos. On iOS it saves JSON
  under Files → On My iPhone → SiteTwin. Reset/uninstall removes local app data.
  Updates retain the same origin/database; verify retention on the actual device.
- The assistant executes supported building commands locally. It is not an LLM.
- Deliveries use entered dimensions and simple box geometry. Only route/doorway
  width is checked. Turning clearance, height and floor fit are **not assessed**.
  A width-blocked delivery stays at the entrance in the twin.
- Cloud AI, voice services, automated measurement, generated models, room
  reconstruction, new building/door imports and cross-device sync are not included.
  The example scan is bundled and explicitly labelled; loading it is optional.

## Verification status

- Production build, TypeScript, native simulator build and signed Release archive
  succeed. Python tests and local TypeScript tests pass.
- Browser production checks exercised local routing, closure/replanning, persistence
  across reload, and a saved photo/manual delivery without backend calls.
- Native simulator opens the packaged catalog and 3D viewer with no server URL.
- Native simulator worker routing succeeded (124.9 m test route). Booking writes
  updated the viewer, and the booking/event survived replacing and relaunching
  the app with the same bundle ID.
- Physical iPhone frame rate, first launch in airplane mode, native photo capture,
  export through Files, and retention across a TestFlight update still require the
  actual phone. They are not claimed from desktop/simulator results.

The intended phone check: update in TestFlight, enable airplane mode, open the demo
factory, route between rooms, close/reopen a lift, book a room, save a photo delivery,
force-quit, and verify the edits/photo remain after reopening. Repeat after the
next build update. The AI assistant calls Claude directly from the phone. `npm run build:local` builds the team's `ANTHROPIC_API_KEY` from the repo-root `.env` into the iOS bundle (never into the server-mode web build, never into git), so anyone with the build can extract it: use a key with a spending limit and rotate it if a build leaks. A key pasted in the assistant's settings overrides it on that phone.
