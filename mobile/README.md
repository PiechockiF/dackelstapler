# SiteTwin iOS

Native iOS companion for SiteTwin. The UI is built with Flutter, the 3D twin is rendered natively with SceneKit, and the site map uses MapLibre Native. It talks to the existing FastAPI backend (REST, chat over SSE, live updates over WebSocket). It does not embed a WebView.

## What works

- **Sites:** a dark MapLibre map with site pins, search, and a site list.
- **Twin:** a native SceneKit building. You can show floors exploded or stacked, focus a single floor, frame the whole building, and orbit, pan and zoom.
  - Lifts are violet glass shafts and staircases are cyan ones, each spanning the floors it connects. A closed one turns red and pulses.
  - Tapping a room, asset, delivery, lift, staircase or closed door selects it. Lifts, staircases and doors can then be closed or reopened from the details card.
- **Activity:** live changes, deliveries with their dimension checks, room booking, and step-free or minimum-width routing. Routes are drawn as animated light trails, and lift and door closures re-plan the route live.
- **Ask:** the building assistant streams its answers. It shows "understood" chips, and its routes, highlights and floor focus appear on the twin.
  - The conversation is kept per site for the whole app session. It survives closing the panel, switching to the twin and leaving and re-entering the site.
  - Voice uses the server's ElevenLabs speech when it is configured; otherwise it falls back to on-device recognition and speech.
- **Panels:** Activity, Capture and Ask open as a bottom panel above the twin. Scrolling inside a panel only scrolls its content. Drag or tap the handle to switch between the normal and the tall size. While the keyboard is open the panel uses almost the full height.
- **Capture:** photograph a delivery (camera, library or the server's demo photo), follow the measurement progress live, and the measured crate drops into the twin. You can also fit a room scan from a video or from the labelled demo scan and read the wall deviations.
- **Timeline:** scrub through the last seven days or replay them; deliveries appear and disappear accordingly.

**Not included yet:**

- Gaussian-splat rendering of room scans. The app shows the deviation summary; the splat preview stays on the web twin.
- Photoreal captured GLB models. Deliveries are drawn as dimension-accurate crates.
- The add-site floor-plan review, which stays on the web.

## How the app and the backend work together

The app contains no business logic of its own. Routing, room capacity, closures, dimension checks and the assistant all run in the Python backend (`server/`, `core/`, `capture/`, `agent/`), exactly as they do for the web twin. The app only loads data, shows it, sends user actions to the backend and reacts to the backend's live events. Because the web twin and the iPhone share one backend, a change made in either one appears in both.

### Layers

```text
FastAPI backend  (server/main.py, server/voice.py, capture/router.py)
   ▲ REST: JSON and multipart      ▲ SSE: chat replies       ▲ WebSocket /ws: server pushes
   │                               │                         │
ApiClient (dio)  ──────────────────┘                   LiveClient (web_socket_channel)
lib/core/api_client.dart, lib/core/sse.dart            lib/core/live_client.dart
   ▲                                                         ▲
   └──────────── Riverpod providers (lib/app/providers.dart) ┘
                    ▲                         ▲
   SiteSessionController (one per open site)  ChatController + VoiceService
   lib/features/site/site_session.dart        lib/features/assistant/
                    ▲
   Screens and panels (lib/features/...)  ──  TwinSurface (lib/features/twin/twin_surface.dart)
                                                  ⇅ MethodChannel "sitetwin/twin/<viewId>"
                                              TwinPlatformView, SceneKit (ios/Runner/TwinPlatformView.swift)
```

- **`lib/core/`** holds the transport layer and the data types. `models.dart` mirrors `docs/CONTRACT.md`. `Building`, `SiteState` and `RouteModel` also keep the original JSON (`raw`), which is passed unchanged to the native twin.
- **`SiteSessionController`** is the single source of truth for one open site: building, live state, event feed, current route, starting point, selection, highlights, timeline position and the running capture job. Widgets read from it and call its methods; they never call the backend directly.
- **`TwinSurface` and `TwinPlatformView`** only render. Swift parses the same JSON and computes the same floor layout as the web viewer (`web/src/twin/layout.ts`).

### Configuration

The backend address is fixed when the app is built: `--dart-define=SITETWIN_API_URL=http://<mac>.local:8000`. `AppConfig` (`lib/core/config.dart`) derives everything else from it:

- REST and SSE use `<base>/api/...`.
- The WebSocket uses `ws://<host>/ws`, or `wss://` when the base URL is `https`.
- File paths such as `/storage/...` are resolved against the same host.

On iOS, `NSAllowsLocalNetworking` permits plain HTTP to local-network hosts only.

### Startup

1. `main.dart` starts `ProviderScope` and `SiteTwinApp`.
2. `sitesProvider` calls **`GET /api/sites`**. The sites appear as MapLibre pins and as the "Standorte" list.
3. `liveClientProvider` opens **`/ws`** straight away. The header badge switches between `CONNECTING`, `LIVE` and `OFFLINE`, following `LiveClient.connectionStates`.

### Opening a site

`SiteSessionController.load()` runs when you open a site:

1. **`GET /api/sites/{id}/building`** returns the raw `building.json`.
2. The controller picks the starting point the same way the web app does: *Office 1.04* in the demo factory, otherwise a ground-floor lobby or entrance.
3. **`GET /api/sites/{id}/state`** (closures, moved assets, deliveries, added doors) and **`GET /api/sites/{id}/events?limit=200`** run in parallel.
4. `TwinSurface` creates the native view with `creationParams = {building, state, route, exploded, focusFloorId, highlightIds, selectedId, timelineVisibleIds}`. SceneKit builds the scene once and caches it.

Leaving the site disposes the controller, the WebSocket subscription, the timers and the native scene.

### Flutter ⇄ native twin

The two sides exchange only semantic messages, never one message per frame. The camera, animations and hit testing run entirely in Swift.

| Direction | Method | Payload | Effect |
|---|---|---|---|
| Flutter → Swift | `sync` | Same map as `creationParams`; `building` only when it changed | Swift compares the payload with the previous one and rebuilds only what changed (state, route, markers, floors, delivery visibility) |
| Flutter → Swift | `frameAll` | – | Frames the whole building |
| Flutter → Swift | `setRenderingActive` | `{active: bool}` | Pauses rendering while the app is in the background |
| Flutter → Swift | `dispose` | – | Removes the scene, actions and gestures |
| Swift → Flutter | `entityTapped` | Room, asset, delivery or closure id; `""` when nothing was hit | Selects the item and opens its details card |
| Swift → Flutter | `rendererError` | Message | Shown above the twin |

### Live updates (WebSocket `/ws`)

The server sends two kinds of message to every client. The app filters them by `site_id`.

- **`{"type": "event", "event": {...}}`**
  1. The event is added to the top of the feed, skipping duplicates.
  2. After a 150 ms debounce the app calls `GET /state` and re-plans the current route.
  3. `door_added` also reloads the building geometry.
  4. `delivery` highlights the new crate and shows a notice.
- **`{"type": "capture_progress", "job": {...}}`** updates the running capture job.

`LiveClient` reconnects with exponential backoff: 0.5 s, doubling up to 30 s, with ±20 % jitter. When the app returns to the foreground it reconnects immediately and fetches state and events again.

### What each user action does

| Action in the app | Backend call | What follows |
|---|---|---|
| Plan a route (Activity → Route, "Navigate here" in the details card, "Navigate" on a room) | **`POST /api/sites/{id}/route`** with `{from, to, step_free, min_width_m, via}`; `from` defaults to the current starting point | The route is drawn in SceneKit and the floors not on the route are dimmed |
| Set your position ("I'm here" on a room) | – (client only) | Becomes the starting point for routes and the `here` sent with chat messages. The room gets a "You are here" marker |
| Close or reopen a lift or door | **`POST /api/sites/{id}/closures`** with `{element_id, closed}` | Returns the new state and the route is re-planned. The server also broadcasts a `closure` event to every other client |
| Re-plan after any live change | `POST …/route` again with the stored `from_space_id`, `to_space_id`, `step_free`, `min_width_m` and `via`, even when the route was unreachable | A generation counter discards answers that arrive after a newer request |
| Find free rooms | **`GET /api/sites/{id}/rooms/bookable?start&end&people&near`**, where `near` is the starting point | Free rooms are listed with their distance |
| Book a room | **`POST /api/sites/{id}/bookings`** with `{space_id, start, end, who, title}` | The room is highlighted. The resulting `booking` event refreshes any open search, on this phone and in the web app |
| Ask the building | **`POST /api/sites/{id}/chat`** with `{session_id, message, here}` and `Accept: text/event-stream` | See *Chat* below |
| Delivery capture | **`POST /api/capture/delivery`** (multipart: `site_id`, `photos[]`, optional `declared_w/d/h`, `target_space`, `label`, `note`); demo photo from **`GET /api/capture/sample.jpg`** | Returns a `CaptureJob`. See *Capture* below |
| Room scan | **`POST /api/capture/room`** (multipart: `site_id`, `space_id`, optional `video`) | Without a video the server fits its labelled demo scan. The app shows the wall deviations |
| Scrub the timeline | – (client only) | Events become timeline ticks. The chosen time sets `timelineVisibleIds`, and SceneKit hides deliveries that arrived after it |

### Chat (Server-Sent Events)

`ApiClient.streamChat` reads the HTTP response as a stream. `SseParser` (`lib/core/sse.dart`) splits it into events however the bytes arrive: lines split across chunks, `\r\n` line endings, comments, multi-line `data` and a final event without a blank line are all handled.

| SSE event | Effect in the app |
|---|---|
| `delta` `{text}` | The reply text grows live |
| `action` `set_location` | Moves the starting point, the same "you are here" the web app uses |
| `action` `show_route` | Draws the route on the twin |
| `action` `highlight` `{ids, label}` | Shows an amber marker (ring and light beam) for those ids, sized by camera distance as in the web twin, with the label as a chip |
| `action` `focus_floor` | Isolates a floor |
| `action` `understood` `{chips}` | Shows the "understood" chips above the reply |
| `action` `state_changed` | Calls `GET /state` and re-plans the route |
| `done` `{reply}` | Final text, then spoken unless muted |

Each open site screen uses its own `session_id`, so the backend keeps the conversation context.

### Voice

`GET /api/health` reports whether server speech is configured (`"voice": true` when an ElevenLabs key is set).

- **When it is:** the app records AAC (`record`), sends it to **`POST /api/voice/stt`** (multipart `audio`), receives `{text}` and sends that to the chat. Replies come back as MP3 from **`POST /api/voice/tts`** and are played with `just_audio`.
- **When it is not, or the server returns `501`:** the app switches to on-device recognition (`speech_to_text`) and on-device speech (AVSpeechSynthesizer through the native `sitetwin/speech` channel).

### Capture

1. During the upload, the app shows progress from Dio's `onSendProgress`.
2. The server returns a `CaptureJob`.
3. Progress then arrives in two ways: WebSocket `capture_progress` messages, and **`GET /api/capture/jobs/{id}`** polled every 1.5 s as a fallback. Progress never moves backwards when a late poll overtakes a push.
4. When the job finishes, the app fetches the state again. The measured crate appears in the twin and is highlighted.

### Errors

- Backend errors (`{"detail": "..."}`, string or list) become an `ApiException` with a readable message.
- When the server cannot be reached, the message names the configured URL.
- `501` means a feature is not configured on the server (speech, plan parsing).
- A failed state refresh keeps the last good state, so the twin never goes blank.

## Requirements

- macOS with Xcode (verified with Xcode 27.1) and an iPhone running iOS 15 or later.
- Flutter stable (verified with 3.47.8). Install it from <https://docs.flutter.dev/get-started/install>, then make sure `flutter doctor -v` reports no iOS problems.
- The SiteTwin backend from the repository root, running with `uv`.

## Run on your iPhone from Xcode

### 1. Start the backend so the phone can reach it

```bash
cd /path/to/industrial-agents-hackathon-2026
uv run uvicorn server.main:app --host 0.0.0.0 --port 8000
```

`--host 0.0.0.0` is required. The default `127.0.0.1` only accepts connections from the Mac itself. When macOS asks whether Python may accept incoming connections, choose **Allow**.

### 2. Point the app at your Mac and generate the Xcode configuration

In a second terminal:

```bash
cd /path/to/industrial-agents-hackathon-2026/mobile
flutter pub get

API_HOST="$(scutil --get LocalHostName).local"
flutter build ios --debug --config-only --no-codesign \
  --dart-define="SITETWIN_API_URL=http://${API_HOST}:8000"

open ios/Runner.xcworkspace
```

Open **`Runner.xcworkspace`**, not `Runner.xcodeproj`. The backend address is compiled into the app, so run the `flutter build ios --config-only …` command again whenever the address changes. If `.local` names do not resolve on your network, use the Mac's IP address from `ipconfig getifaddr en0` instead.

### 3. Sign and run

1. Connect the iPhone with a cable, unlock it and tap **Trust**.
2. On the iPhone, open **Settings → Privacy & Security → Developer Mode**, turn it on, and restart the phone.
3. In Xcode, select the **Runner** project, then the **Runner** target, then **Signing & Capabilities**.
4. Enable **Automatically manage signing** and choose your team. A free personal Apple ID team works.
5. If Xcode reports that the bundle identifier is unavailable, change `com.sitetwin.sitetwin` to something unique, for example `com.yourname.sitetwin`.
6. **To open the app from the home screen later, build it in Release.** Choose **Product → Scheme → Edit Scheme… → Run → Info → Build Configuration → Release**. A Debug build runs only while Xcode or `flutter run` is attached. Opened from the home screen, it stops with *"In iOS 14+, debug mode Flutter apps can only be launched from Flutter tooling…"*.
7. Select your iPhone in the run-destination menu and press **⌘R**.
8. The first time, the iPhone may block the app. Open **Settings → General → VPN & Device Management**, trust your developer certificate, and launch SiteTwin again.
9. When the app asks for **Local Network** access, choose **Allow**. Camera, photo, microphone and speech permissions are requested only when you first use those features.

Without Xcode, the same standalone Release build can be installed from the terminal. The phone must be unlocked:

```bash
flutter build ios --release --dart-define="SITETWIN_API_URL=http://${API_HOST}:8000"
xcrun devicectl list devices                     # copy your iPhone's identifier
xcrun devicectl device install app --device <identifier> build/ios/iphoneos/Runner.app
```

Running `integration_test` or `flutter run` installs a Debug build again. Reinstall the Release build afterwards if you want to open the app from the home screen.

### 4. Check connectivity if sites do not load

In Safari on the iPhone, open `http://YOUR-MAC.local:8000/api/health`. It must return JSON containing `"ok": true`. If it does not, check that:

- the Mac and the iPhone are on the same Wi-Fi network;
- the backend was started with `--host 0.0.0.0`;
- the macOS firewall allows Python;
- the URL passed to `--config-only` is correct.

The app's live badge shows **LIVE** once the WebSocket connection is up.

## Demo walkthrough

1. Search for **Fertigung Ost 27** and open it.
2. Use **Exploded**, **All**, **L0** and **L1** in the floor bar. Tap a room or a machine to see its details.
3. In **Ask**, send "Take me to Quality lab 0.21 without stairs". The route animates across both floors through the office lift.
4. Send "Close the office lift", or tap the violet lift shaft in the twin and choose **Close**. The route becomes blocked and the shaft turns red. Then reopen the lift, by asking or with **Reopen**, and the route comes back.
5. In **Activity → Rooms**, find a room and book it. The booking arrives as a live event.
6. In **Capture → Delivery**, tap **Demo photo** and then **Measure & check**. Follow the progress, then tap **Show on twin**.
7. Drag the timeline back a few days, then tap **LIVE**.

## Simulator

`flutter run --dart-define=SITETWIN_API_URL=http://127.0.0.1:8000` works against a backend on the same Mac. On Xcode 27 the Simulator app is called Device Hub. The camera, microphone and speech recognition need a real iPhone; the demo photo and demo scan work everywhere.

## Measuring performance

Debug builds are slow by design. To measure frame times, choose **Product → Scheme → Edit Scheme → Run → Build Configuration → Profile** and run on a real iPhone. Then use Flutter DevTools for UI and raster times and Xcode Instruments (Metal System Trace, Allocations) for the native twin.

## Development

### Project layout

```text
mobile/
  lib/app/          theme, shared widgets, router, Riverpod providers
  lib/core/         config, typed models, REST/SSE client, WebSocket client
  lib/features/
    sites/          map and site list
    site/           site screen, session controller, details card, room picker
    twin/           native twin bridge (TwinSurface), timeline
    activity/       changes, deliveries, rooms, route
    capture/        delivery capture and room scans
    assistant/      chat controller, voice, Ask panel
  ios/Runner/       TwinPlatformView.swift (SceneKit), TwinGeometry.swift, NativeSpeech.swift
  ios/RunnerTests/  geometry tests for the native twin
  test/             unit and widget tests
  integration_test/ end-to-end flow against a running backend
```

### Checks

```bash
flutter analyze
flutter test                                    # unit and widget tests, no backend needed
flutter build ios --release --no-codesign       # compiles Dart, the Swift twin and every plugin
```

The end-to-end test opens the demo factory, plans a step-free route, then closes and reopens the office lift through the API, checking that the app re-plans live. It changes site state, so run it only against a demo backend:

```bash
SITETWIN_STORAGE=$PWD/../.tooling/ios-demo-storage uv run uvicorn server.main:app --host :: --port 8011   # from the repo root
flutter test integration_test/app_flow_test.dart -d <simulator-or-device> \
  --dart-define=SITETWIN_API_URL=http://localhost:8011
```

On a real iPhone, replace `localhost` with your Mac's `.local` name. Afterwards, reinstall the Release build (see "Sign and run").

### Native bridge

Flutter talks to the native twin through the `sitetwin/twin/<viewId>` method channel and sends semantic updates only, never one message per frame. See "Flutter ⇄ native twin" above.

### Dependencies

- iOS plugins are integrated through Swift Package Manager; CocoaPods is not needed.
- Flutter packages are pinned in `pubspec.lock`.
- The Inter font is bundled under the SIL Open Font License; see `assets/fonts/OFL.txt`.

### Signing for other developers

`ios/Runner.xcodeproj` contains the development team that first built the app. Anyone else selects their own team under **Signing & Capabilities** and, if necessary, changes the bundle identifier. No signing certificates or provisioning profiles are stored in the repository.

## Secrets and configuration

The app contains no API keys or credentials. The only build-time value is `SITETWIN_API_URL`, a plain server address.

- All service keys (Anthropic, ElevenLabs, fal.ai, Modal, MapTiler) live only in the backend's `.env` at the repository root. That file is git-ignored; `.env.example` lists the variable names.
- `.tooling/` is git-ignored. It holds a local Flutter SDK, the package cache and the isolated demo storage.

## Security

Local development relies on `NSAllowsLocalNetworking`, so plain HTTP is allowed only to local-network hosts. The app never enables `NSAllowsArbitraryLoads`. A deployed backend must use HTTPS.

The backend has no authentication. While it runs with `--host 0.0.0.0` or `--host ::`, anyone on the same network can use it, including the chat and speech endpoints that spend your API credits. Use such a backend only on networks you trust, and stop it when you are done.
