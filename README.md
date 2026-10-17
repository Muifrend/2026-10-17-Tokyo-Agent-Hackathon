# Goal Coach

A minimal Mac app for brainstorming goals and staying on track. Goals and Brainstorms are always visible in the sidebar. Goals appear automatically as you chat. Use the composer’s + button to select an existing goal; subsequent messages extend its graph in the same chat. Select a ready goal to open its interactive graph and start screen and webcam checks every 20 seconds. A physical phone visible in one webcam still immediately produces “Stop using your phone.” Other distractions require two confident off-track checks. Reminders share a two-minute cooldown.

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

Open `out/Goal Coach-darwin-arm64/Goal Coach.app`. Packaging seals the finished macOS bundle with a local ad-hoc signature for native notification support. Developer ID signing, public distribution, and notarization are deferred. Rebuilding can prompt macOS to request access again because the local signature changes.

## Focus

Goals can start focus once their outcome and relevant work are known. Distraction examples are optional; analysis uses the goal and its graph to judge visibly unrelated activity.

The first focus session asks for Screen Recording and Camera permission. Allow Goal Coach in **System Settings → Privacy & Security** and restart the app if Screen Recording requires it. Multiple displays get a small picker. Screen and camera images are sent to ai& only during active focus; images are discarded after analysis and never saved to disk or Neo4j. There is no audio capture.

The green dot means capture is active. Pause releases the camera; Resume is explicit. Minimized sessions keep running. Locking the screen, sleep, capture loss, or repeated analysis failures pause monitoring. Closing the app stops it. Allow Goal Coach notifications in System Settings and choose a visible notification style. Native delivery failures show a concise notice; saved reminders remain in the brainstorm chat.

Neo4j stores chats, goals, session status, and short findings under app-specific `TGC` labels. Interview facts become native `TGCGoalDetail` nodes: subgoals, actions, motivations, obstacles, success criteria, and distractions. Typed relationships connect them to their goal or subgoal, with `SUPPORTS_DETAIL` links from source messages. A chat selected through + has a `REFINES_GOAL` relationship to the existing goal UUID. Existing goals are backfilled from their saved criteria. Interview and focus analysis both receive the relevant goal graph; adding an action changes the context used to judge focus. It does not modify unrelated data. No graph plugin or hosted backend is required.

## Checks

```sh
npm run typecheck
npm test
npm run smoke
npm run desktop:check
node scripts/graph-ui-check.mjs
node scripts/focus-check.mjs
```

`smoke` verifies real Neo4j writes and ai& interview/vision calls, then removes its temporary records. `desktop:check` launches the packaged app and verifies its connections and UI. `focus-check` exercises a real interview and a five-minute minimized screen/webcam session; it needs permission approval and creates temporary demo records. Remove only those records afterward with `node --import tsx scripts/cleanup-check.ts`.

Core boundaries: the Electron main process owns credentials, Neo4j, AI requests, notifications, and scheduling. The sandboxed React renderer has a typed, restricted bridge. A separate sandboxed capture renderer handles webcam frames. Implementation tasks are delegated using `aiand run` as described in AGENTS.md.
