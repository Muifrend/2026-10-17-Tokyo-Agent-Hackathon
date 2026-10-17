# Connect your agent-built coach to the shared leaderboard

Guide for coding agents integrating a personalized goal/focus app into the shared points ecosystem.

## 1. Product intent and honest state

**Intent:** each person's own agent personalizes their own coach. Independent apps stay compatible by reporting **verified focus time** to one shared points service, which computes a common leaderboard. Goals, chats, graphs, and evidence belong to each app's coaching system; the points service receives only identity, source, and interval IDs/times (plus an optional public goal title).

**Current reality (hackathon prototype):** distributed clients (e.g. North Star on Windows, Goal Coach on macOS) talk to **one shared hosted service** (Express + Neo4j). There are no user accounts, no ownership protection, and the API **trusts clients** — it does not independently verify focus evidence. Production identity, auth, and server-side verification are future work (see §13).

### Minimum responsibilities of a connected goal app

| Local responsibility | What your agent must implement |
|---|---|
| Goal context | Know the user's intended outcome and what relevant work looks like. Keep this context local to the coaching system. |
| Verification | Produce timestamped, uniquely identified findings from actual work evidence; document how your app decides time is focused. A running timer alone does not verify focus. |
| Session lifecycle | Track active, paused, and stopped sessions. Invalidate unfinished checks on switching, stopping, or losing evidence. |
| Interval adapter | Translate saved findings into eligible time ranges without changing the underlying coach. |
| Identity and delivery | Register the player, persist their server ID, keep a durable retry queue, and send immutable intervals. |
| Shared feedback | Read the real leaderboard and show server scores with an honest offline state. |

Your agent can personalize the interview, goal model, interface, reminder style, and evidence collection to the user's preferences. Acquire explicit permission for any capture. These choices remain in your app; the shared scoring contract remains the same. No direct access to Goal Coach's database is needed. A leaderboard-only viewer needs configuration and read access, but cannot earn points without verified intervals.

## 2. Prime directive: preserve your app's core

The points integration is a **passive, additive scoring adapter**. It must never change coaching behavior:

- Focus monitoring, reminders, capture, and persistence are unchanged. The adapter only observes **already-saved** observations.
- An unavailable, slow, or misconfigured points service must never pause, block, or degrade coaching, suppress reminders, or delay analysis.
- Never fabricate or score synthetic time. Only verified real intervals are submitted.
- Scoring logic lives on the server. **The client never calculates its authoritative score.** Display server-returned stats only.
- Points can go *down* when a streak expires (streak counts consecutive days with ≥1 verified minute, ending today or yesterday). That is correct behavior — do not smooth it client-side.

## 3. Identity and configuration

Choose **one consistent player name** used by every app for the same person. Identity is a **case-insensitive upsert by name** (`POST /v1/players`): the same name from two apps is the same player. Because there are no accounts, anyone with the key and name can report for that name — this is a known shipped limitation.

Use a **stable `source`** string for your app (1–24 chars: `a-z`, `0-9`, `-`), e.g. `my-coach`. Forks may retain their app family identifier; independent apps should choose their own. Interval IDs must still be globally unique across every installation.

Configuration (placeholders — never invent or commit real values):

```dotenv
POINTS_URL=https://your-points-host.example
POINTS_KEY=REPLACE_WITH_HOST_PROVIDED_KEY
POINTS_PLAYER_NAME=YourName
```

- `POINTS_KEY` is a **real secret from the service host**. It is *not* `AIAND_API_KEY` and not the app's AI credential. Do not generate a mismatching key; do not paste the actual secret into code, docs, logs, or commits.
- Current hackathon demo URL (may be a temporary Cloudflare tunnel): `https://measured-carries-established-half.trycloudflare.com` — **ephemeral**. If dead, ask the host for the current URL. Do not guess.
- Keep the key in the backend/main process only (never renderer, bundled frontend, or logs). Use HTTPS and `redirect: 'error'` so credentials are never sent to a different host after a redirect. Plain `http:` only for loopback hosts.

## 4. Wire protocol (the only contract)

**Implementation choices — Neo4j, Electron, ai&, camera and screen capture, graph storage, UI framework — are properties of the Goal Coach reference implementation, NOT protocol requirements.** Any stack may connect. The contract is the HTTP API below (full detail in `POINTS.md`, see §10):

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/v1/health` | — | `{ ok: true }` (no key) |
| POST | `/v1/players` | `{ name, color?, goalTitle? }` | `{ player }` |
| PATCH | `/v1/players/:id` | `{ goalTitle?: string \| null, color?: string }` | `{ player }` |
| GET | `/v1/players/:id` | — | `{ row }` |
| POST | `/v1/focus` | `{ id, playerId, source, start, end, goalTitle? }` | `{ row }` |
| GET | `/v1/leaderboard` | — | `{ rows, mode }` |

- All non-health requests need header `x-points-key: <shared key>`.
- Responses are `{ player }`, `{ row }`, or `{ rows, mode }`. Errors are `{ error: string }` with 4xx/5xx. Validate response shape before trusting it.
- **Note:** `POST /v1/focus` takes `playerId` in the request, but the returned row exposes the id as `row.id` (not `row.playerId`). `GET /v1/players/:id` returns `{ row }`.
- Constraints: `source` 1–24 chars `[a-z0-9-]`; interval `id` 1–128; `playerId` 1–64; `name` 1–32; `goalTitle` ≤ 80 or null; `color` `#RRGGBB`. Times are ISO 8601 UTC.
- Use the **real leaderboard**: `GET /v1/leaderboard` (or `?mode=real`). Never use demo mode or fabricate rows.

```ts
type Player = { id: string; name: string; color: string; goalTitle: string | null; createdAt: string };
type Row = Player & {
  rank: number; points: number; focusedMinutes: number; todayMinutes: number;
  streak: number; lastActiveAt: string | null; live: boolean; sources: string[];
};
```

Omit `goalTitle` unless the user wants that short line public. Goal Coach omits it. Sending it in registration, a player update, or a focus report updates the public player profile.

## 5. Focus interval rules (server-enforced)

- Interval duration: **5 s – 15 min** (`end - start`).
- `end` may be at most **60 s in the future**; `start` may be at most **48 h old**.
- Overlapping intervals are **merged server-side**; each real minute counts once. Points = `focusedMinutes + 25 × streak` where `focusedMinutes` is the floored union of all verified intervals across all of a player's apps.
- Streak: consecutive local days (server timezone) with ≥ 1 verified minute, ending today or yesterday.
- `live` means an interval ended within the last 2 minutes. Live presence is a **recent interval**, not a stream.
- Ranks: points desc, ties share the lower rank.

### Idempotency

- `id` is client-generated, **globally unique and immutable**. Re-sending the same `id` is a server-side no-op; retries are safe.
- **Collision silently no-ops** (even if another player owns the id). Therefore **never reuse an id**. Namespace ids with your source, e.g. `goal-coach:<observationUUID>` (reference: `intervalId(observationId) => 'goal-coach:' + observationId`).

## 6. Evidence-to-interval translator (Goal Coach reference policy)

Adapt this policy to your app, keep it honest and document your own verification policy for users.

A sample is creditable when:
- verdict is `on_track` with a finite `confidence` in 0..1. There is **no ≥0.8 confidence points gate** — confidence is a shape-validity check only. (The ≥0.8 threshold applies only to the separate *reminder* policy. Do not add arbitrary confidence filters for scoring.)
- No phone detected (`phoneDetected === true` samples are never creditable).
- IDs and timestamps must be valid; a sample more than one second ahead of the local clock is invalid.

An interval `[prev, cur]` is creditable when both ends are creditable samples, **same active uninterrupted session**, same session id, distinct ids, strictly increasing timestamps, and the gap is **5–30 s inclusive** (with a 20 s cadence this is natural). Specifically:
- The **first sample of a session gets no credit** — no time before the first check is ever scored.
- Any of these **breaks the chain**: `off_track`, `uncertain`, analysis error, invalid output, pause, stop, goal/session switch, sleep, screen lock, capture loss, app restart. Reset the baseline whenever you change the capture source.
- Only **saved observations** count; late-generation responses from superseded session states are ignored (stale generations never rewind the baseline).
- **Reminder policy stays separate:** a phone in one webcam frame qualifies immediately; other distractions use two consecutive off-track results with confidence ≥0.8. Both respect the same two-minute reminder cooldown. Points logic must not alter reminder behavior.

Simplified sequence (accurate about baseline/order/gaps/restart):

```text
prev = null
on session start/resume/restart/pause/switch: prev = null   # baseline reset
for each saved observation (in order, same active session):
  if duplicate id or timestamp <= prev.timestamp: skip without changing prev
  if not creditable(sample):          # off_track / uncertain / invalid / phone
      prev = null; continue
  if prev exists and 5s <= (cur - prev) <= 30s:
      enqueue interval { id: 'goal-coach:' + cur.id, start: prev.createdAt, end: cur.createdAt }
  prev = sample                        # first sample only establishes baseline
```

Real implementations also handle generation invalidation (queued samples from an old generation are dropped, never used to rewind the baseline) and duplicate-id protection in the outbox.

## 7. Reliable idempotent outbox

Never POST from the focus loop directly. Use a durable outbox:

- **Persist before send**: write the interval to disk (atomic write: temp file + rename, mode `0600`) *before* any network attempt. Never queue a record that did not persist.
- **Stable replay id**: the queued record's id is immutable across retries.
- **Bounded timeouts** on every request (reference: 4 s). Validate JSON success including `row.id` matching your player before acknowledging.
- **Remove only after a durable ack**: delete from the outbox (and persist the removal) only after a validated success. On crash between server write and local removal, the retry is a no-op thanks to idempotency.
- **Serial, coalesced flushes**: one flush at a time; first failure stops the batch; a periodic timer (reference: 20 s) plus flush-on-enqueue.
- **Retry offline within 48 h**: records older than 48 h by `start` expire (the server would reject them anyway). Cap queue size (reference: 10 000) by dropping oldest.
- **Never cross identity**: bind queued records to the configured service and normalized player name. If either changes, keep the old queue separate or explicitly discard it; never submit it as the new player. Goal Coach starts fresh on an identity change.
- If the state file is unreadable/corrupt, disable syncing (surface a clear message); never overwrite it blindly.

## 8. Leaderboard display

- Poll `GET /v1/leaderboard` every **20 s while the panel is open** (reference behavior). Validate `{ rows }` shape.
- Show `status: 'ready' | 'setup' | 'offline'`. On errors or offline, show setup/offline/stale indicators with the last-known data clearly marked — **never invent data or demo rows**.
- Show server-computed fields only: `rank, id, name, color, points, focusedMinutes, todayMinutes, streak, lastActiveAt, live, sources, goalTitle`.

## 9. Minimal runnable example (Node 22+, no third-party deps)

Save as `points-client.mjs` and run `node --env-file=.env points-client.mjs`. This reads the board and registers your name; it does not submit focus time. The exported submission helper must only receive an already-persisted, verified interval from your outbox. The snippet is an HTTP example, not a complete queue or evidence verifier.

```js
// points-client.mjs — Node 22+
const POINTS_URL = process.env.POINTS_URL;         // e.g. https://your-points-host.example
const POINTS_KEY = process.env.POINTS_KEY;         // real secret, provided privately by the host
const POINTS_PLAYER_NAME = process.env.POINTS_PLAYER_NAME?.trim();
const SOURCE = 'my-coach'; // choose your app's stable source

if (!POINTS_URL || !POINTS_KEY || !POINTS_PLAYER_NAME) {
  console.error('Set POINTS_URL, POINTS_KEY, POINTS_PLAYER_NAME in the environment.');
  process.exit(1);
}
const url = new URL(POINTS_URL);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.search || url.hash) {
  throw new Error('Use an HTTPS service URL, or HTTP on loopback, without credentials/query/fragment.');
}
const base = url.origin + url.pathname.replace(/\/+$/, '');

async function points(path, { method = 'GET', body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'x-points-key': POINTS_KEY,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',        // never follow redirects with credentials
    cache: 'no-store',
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`points service HTTP ${res.status}`);
  return json;
}

function validPlayer(player) {
  return player && typeof player.id === 'string' && player.id.length > 0 &&
    typeof player.name === 'string';
}

function validRow(row) {
  return validPlayer(row) && Number.isInteger(row.rank) && row.rank >= 1 &&
    Number.isFinite(row.points) && row.points >= 0;
}

export async function readLeaderboard() {
  const { rows, mode } = await points('/v1/leaderboard');
  if (mode !== undefined && mode !== 'real') throw new Error('unexpected leaderboard mode');
  if (!Array.isArray(rows) || !rows.every(validRow)) throw new Error('bad leaderboard shape');
  return rows;
}

export async function registerPlayer() {
  const { player } = await points('/v1/players', {
    method: 'POST',
    body: { name: POINTS_PLAYER_NAME },
  });
  if (!validPlayer(player) || player.name.trim().toLowerCase() !== POINTS_PLAYER_NAME.toLowerCase()) {
    throw new Error('player registration mismatch');
  }
  return player;
}

/**
 * Submit ONLY an existing, durably verified focus record (already persisted
 * with an immutable unique id). Never fabricates timestamps.
 * record = { id: 'my-coach:<globally unique UUID>', start: ISO, end: ISO }
 */
export async function submitVerifiedInterval(playerId, record) {
  const { row } = await points('/v1/focus', {
    method: 'POST',
    body: { id: record.id, start: record.start, end: record.end, playerId, source: SOURCE },
  });
  if (!validRow(row) || row.id !== playerId) throw new Error('unexpected row for player');
  return row; // caller removes the record from its outbox only now
}

if (process.argv[1]?.endsWith('points-client.mjs')) {
  const rows = await readLeaderboard();
  console.log(rows.map(r => `#${r.rank} ${r.name} ${r.points}pts ${r.streak}d`));
  const player = await registerPlayer();
  console.log('registered:', player.id, player.name);
}
```

Placeholder focus body (illustrative only — **not sendable**; do not POST fake intervals):

```jsonc
{
  "id": "goal-coach:<real observation UUID>",
  "playerId": "<id from POST /v1/players>",
  "source": "goal-coach",
  "start": "<ISO UTC of a real verified on-track sample>",
  "end": "<ISO UTC, 5s–15min after start, ≤60s in future>"
}
```

## 10. Reference sources

Pinned North Star commit `b88d8f3c35a08a1a6edab404fc362199e544c82b`:

- [POINTS.md](https://github.com/novruzgurbanov/north-star/blob/b88d8f3c35a08a1a6edab404fc362199e544c82b/POINTS.md) — API overview. Its suggested single-check snippet is simpler than Goal Coach's two-sample policy; use this guide's continuity and durable-retry rules.
- [points/src/index.ts](https://github.com/novruzgurbanov/north-star/blob/b88d8f3c35a08a1a6edab404fc362199e544c82b/points/src/index.ts) — routes, validation, idempotency, and key check.
- [points/src/stats.ts](https://github.com/novruzgurbanov/north-star/blob/b88d8f3c35a08a1a6edab404fc362199e544c82b/points/src/stats.ts) — union/merge, minutes, streaks, points, ranking.

Goal Coach reference (relative links, current repo):
- [`src/shared/points.ts`](src/shared/points.ts) — wire types, `intervalId`, `isValidSample`, `qualifiesPair`.
- [`src/main/points.ts`](src/main/points.ts) — adapter: config parsing, outbox, flush, registration, leaderboard.
- [`src/main/focus.ts`](src/main/focus.ts) — focus loop that the adapter passively observes.
- [`src/main/index.ts`](src/main/index.ts) — main-process wiring.
- [`src/preload.ts`](src/preload.ts) — restricted bridge for the Friends UI.
- [`src/renderer/Friends.tsx`](src/renderer/Friends.tsx) — leaderboard display.
- [`tests/points.test.ts`](tests/points.test.ts) — adapter behavior tests.

(Adjust paths if your repo layout differs; the shared contract lives in `src/shared/points.ts`.)

## 11. Test checklist

Use mocks or a separate test service. **Never call the real service to add test points.**

- Same name across two app instances → same player id (case-insensitive upsert).
- Response shapes: `{ player }`, `{ row }`, `{ rows, mode }`; `row.id` vs request `playerId`.
- Minute boundary: 59 s of union time → 0 minutes; 60 s → 1.
- Overlapping intervals from two sources merge; union is floored.
- Retry after crash between server write and local ack → server no-op, no double credit.
- Paused session, late/stale generation responses, off_track, phone, first sample → no interval queued; chain breaks.
- Points service offline → outbox persists, coach and reminders unaffected.
- Streak expiry can lower points; client displays server value without recomputation.
- No private evidence (images, chats, findings, goal graphs) is sent to the points service — only interval/identity/source data and an optional user-approved public goal title. Goal Coach's separate ai& analysis still receives images during focus as described in the app's consent flow.

## 12. Troubleshooting: 0 points

1. Is a focus session actually **active**? Paused sessions produce nothing.
2. Are findings valid (`on_track`, finite confidence, no phone)?
3. First check only establishes the **baseline**. With 20-second spacing, four valid checks provide three intervals totaling one verified minute. An app being open for a minute is not sufficient by itself.
4. Credit needs a **whole minute** of unioned verified time; partial minutes wait.
5. `POINTS_URL`/`POINTS_KEY` must match the **same host and key** as the other apps; `401` = wrong key, `404` = wrong path/player, `400` = invalid interval (check duration, 48 h age, 60 s future), timeouts = dead tunnel (ask host).
6. A gap > 30 s (slow analysis, pause, restart) breaks the chain — expected, not a bug.
7. Streak expired (no verified minute yesterday/today) → points drop; correct.
8. No arbitrary confidence filters — any finite confidence 0..1 `on_track` sample is eligible.

## 13. Future boundaries (deferred, do not build now)

- Production identity and auth (accounts, ownership protection) — current name-upsert is trust-based.
- Server-side scoring verification of evidence (API currently trusts clients).
- Durable public hosting (current host is a laptop + tunnel).
- Decentralized federation of points services.

Keep integrations additive and honest; revisit these when the host announces them.
