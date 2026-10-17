# Goal Coach

A minimal Mac app for brainstorming goals and staying on track. Goals appear automatically as you chat. Select a ready goal to start screen and webcam checks every 20 seconds. Two confident off-track checks produce a native reminder, with a two-minute cooldown.

## Run

Requires Node.js 22.12+ and macOS on Apple Silicon.

```sh
npm install
cp .env.example .env
# Fill in your Neo4j connection settings in .env.
aiand login
npm run setup
npm start
```

The current machine is already configured. `npm run setup` copies the ignored `.env` into `~/Library/Application Support/Goal Coach/.env` for Finder launches. The app uses `AIAND_API_KEY` when supplied; otherwise it reads your signed-in ai& CLI session into memory. Credentials are excluded from packaged apps. After changing database settings, run setup again and restart the app.

## Build

```sh
npm run package -- --arch=arm64
npm run make -- --arch=arm64
```

Open `out/Goal Coach-darwin-arm64/Goal Coach.app`. This local build is unsigned; public distribution and notarization are deferred.

## Focus

The first focus session asks for Screen Recording and Camera permission. Allow Goal Coach in **System Settings → Privacy & Security** and restart the app if Screen Recording requires it. Multiple displays get a small picker. Screen and camera images are sent to ai& only during active focus; images are discarded after analysis and never saved to disk or Neo4j. There is no audio capture.

The green dot means capture is active. Pause releases the camera; Resume is explicit. Minimized sessions keep running. Locking the screen, sleep, capture loss, or repeated analysis failures pause monitoring. Closing the app stops it. Native reminders also depend on macOS notification settings.

Neo4j stores chats, goals, session status, and short findings under app-specific `TGC` labels. It does not modify unrelated data. No graph plugin or hosted backend is required.

## Checks

```sh
npm run typecheck
npm test
npm run smoke
npm run desktop:check
node scripts/focus-check.mjs
```

`smoke` verifies real Neo4j writes and ai& interview/vision calls, then removes its temporary records. `desktop:check` launches the packaged app and verifies its connections and UI. `focus-check` exercises a real interview and a five-minute minimized screen/webcam session; it needs permission approval and creates temporary demo records. Remove only those records afterward with `node --import tsx scripts/cleanup-check.ts`.

Core boundaries: the Electron main process owns credentials, Neo4j, AI requests, notifications, and scheduling. The sandboxed React renderer has a typed, restricted bridge. A separate sandboxed capture renderer handles webcam frames. Implementation tasks are delegated using `aiand run` as described in AGENTS.md.
