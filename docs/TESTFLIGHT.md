# SiteTwin iOS build and TestFlight

The native Release archive was built and its signature verified with Xcode 26.0.1
on 24 October 2026. Bundle ID: `com.sitetwin.app`; version/build: `1.0 (1)`;
developer team: `CV955K8T33` (FRANCISZEK PIECHOCKI).

The deployment Docker image also builds locally. Container smoke checks passed
for frontend deep links, health, sites/building data, WebSocket connections, and
streaming chat. All 50 frontend-routing, server, and capture tests passed.

## Build before deployment

```sh
cd web
npm ci
npm run ios:preflight
```

This verifies native compilation and signing. It does not configure a server or
produce a working online beta. Archives are written to
`~/Library/Developer/Xcode/Archives/` and derived data to
`~/Library/Developer/Xcode/DerivedData/SiteTwin/`. Keeping build products outside
Desktop/iCloud avoids the `resource fork, Finder information, or similar detritus
not allowed` signing error observed in this checkout.

## Deploy the server, then archive

Deployment files are included for one Railway service using the root `Dockerfile`
and `railway.toml`:

1. Create a [Railway account](https://railway.com) and connect your GitHub account.
2. Create a project from this repository. Choose the `ios_build_capacitor` branch
   after these local deployment changes have been committed and pushed. Keep the
   service root at the repository root; Railway detects the Dockerfile.
3. Attach a persistent volume at `/data`. `SITETWIN_STORAGE=/data` is set in the
   image. Use one replica and one worker for the SQLite database and in-memory
   WebSocket/chat state.
4. Add optional API keys from the backend `.env` as service variables. The app
   also works with its labelled fallbacks when keys are absent.
5. Under Settings → Networking, generate a public domain. Use that HTTPS origin
   for `CAP_SERVER_URL` below.

This is a shared hackathon demo without user authentication. Anyone with the
address can use its editing and upload endpoints; use demo data for testing.
Hosting has not been provisioned by these files.

The shell loads the frontend from `CAP_SERVER_URL`. The same HTTPS origin must
serve the built `web/dist` frontend with SPA fallback, forward `/api` and `/ws`
to the FastAPI backend, and serve its `/storage` routes. WebSockets and streaming
chat responses must pass through the host/proxy. Store uploads and the SQLite
database on a persistent volume via `SITETWIN_STORAGE`. Keep `.env` and API keys
on the backend; never bundle them in the app or expose them as `VITE_` variables.

Before building the beta, open the deployed site on a phone and verify that
`/api/health`, sites, capture uploads, and chat work. Then run:

```sh
cd web
CAP_SERVER_URL=https://YOUR-DEPLOYED-HOST npm run ios:archive
```

The release command requires an HTTPS origin. It builds the frontend, syncs
Capacitor, archives the app, and verifies its signature. The server address is
embedded during sync, so changing it requires a new archive.

## Upload to TestFlight

1. Open the resulting `.xcarchive` in Xcode's Organizer.
2. Choose **Distribute App → TestFlight & App Store**. Use automatic signing
   and allow Xcode to manage build numbers. The archive is development-signed;
   Xcode handles distribution signing during upload.
3. If prompted, create the SiteTwin app record using bundle ID `com.sitetwin.app`.
   App Store Connect sign-in may be required.
4. After Apple finishes processing, open the app's **TestFlight** tab in App Store
   Connect and enable the build for the intended testing group. Complete any
   export-compliance questions based on the app's actual encryption use.
5. External testers require beta review and beta app information. Internal
   testers must be eligible App Store Connect users.

Version `1.0 (1)` was uploaded on 24 October 2026 and is now **Testing** in the
existing internal group. The App Store Connect record is named `forklift_navi`
([TestFlight](https://appstoreconnect.apple.com/apps/6826578119/testflight)).
The uploaded archive has no server URL configured, so online backend features
still need a follow-up build using a laptop HTTPS tunnel or deployed host.
Default Capacitor icon/splash assets are still used.

Apple references: [upload builds](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
and [distribution through Xcode](https://developer.apple.com/documentation/Xcode/distributing-your-app-for-beta-testing-and-releases).
