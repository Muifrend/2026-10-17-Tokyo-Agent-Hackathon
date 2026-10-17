import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import {
  type FocusInterval,
  type FriendsState,
  POINTS_SOURCE,
  type Player,
  type Sample,
  intervalId,
  isValidSample,
  qualifiesPair,
} from '../shared/points';
import type { FocusSession, Observation } from '../shared/types';

const MAX_OUTBOX = 10000;
const RETENTION_MS = 48 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 20000;
const FLUSH_BATCH = 100;

const PlayerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    color: z.string(),
    goalTitle: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .strip();

const PlayerResponseSchema = z.object({ player: PlayerSchema });

const PointsRowSchema = z
  .object({
    rank: z.number().int().min(1),
    id: z.string().min(1).max(64),
    name: z.string(),
    color: z.string(),
    points: z.number().finite().nonnegative(),
    focusedMinutes: z.number().finite().nonnegative(),
    todayMinutes: z.number().finite().nonnegative(),
    streak: z.number().int().nonnegative(),
    lastActiveAt: z.string().nullable(),
    live: z.boolean(),
    sources: z.array(z.string()),
    goalTitle: z.string().nullable().optional(),
    createdAt: z.string(),
  })
  .strip();

const LeaderboardResponseSchema = z.object({ rows: z.array(PointsRowSchema) });

/** Focus responses are { row: ranked PointsRow }, NOT an interval record. */
const FocusResponseSchema = z.object({ row: PointsRowSchema });

const FocusRecordSchema = z.object({ id: z.string().min(1).max(128), start: z.string().datetime(), end: z.string().datetime() })
  .refine(r => Date.parse(r.end) - Date.parse(r.start) >= 5000 && Date.parse(r.end) - Date.parse(r.start) <= 900000);

const PersistedStateSchema = z.object({
  version: z.literal(1),
  baseUrl: z.string(),
  playerName: z.string(),
  player: PlayerSchema.nullable().default(null),
  outbox: z
    .array(FocusRecordSchema)
    .max(MAX_OUTBOX)
    .default([]),
});

type PersistedState = z.infer<typeof PersistedStateSchema>;

function loopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function parseConfig(env: NodeJS.ProcessEnv): { baseUrl: string; playerName: string } | null {
  const rawUrl = (env.POINTS_URL ?? '').trim();
  const playerName = (env.POINTS_PLAYER_NAME ?? '').trim();
  const key = (env.POINTS_KEY ?? '').trim();
  if (!rawUrl || !playerName || !key) return null;
  if (playerName.length < 1 || playerName.length > 32) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.protocol === 'http:' && !loopbackHost(url.hostname)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const basePath = url.pathname.replace(/\/+$/, '');
  return { baseUrl: url.origin + basePath, playerName };
}

export interface PointsServiceOptions {
  env: NodeJS.ProcessEnv;
  statePath: string;
  now?: () => number;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Optional multiplayer points adapter for the main process.
 * Never throws to the coach; all failures degrade to offline/setup states.
 */
export class PointsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  private config: { baseUrl: string; playerName: string } | null = null;
  private apiKey: string | null = null;
  private state: PersistedState | null = null;
  private corrupt = false;
  private diskError = false;
  private closed = false;
  private prev: Sample | null = null;
  private session: FocusSession | null = null;
  private generation = 0;
  private timer: NodeJS.Timeout | null = null;
  private ioChain: Promise<void> = Promise.resolve();
  private flushPromise: Promise<void> | null = null;
  private registerInFlight: Promise<Player> | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly aborts = new Set<AbortController>();

  constructor(options: PointsServiceOptions) {
    this.env = options.env;
    this.statePath = options.statePath;
    this.now = options.now ?? Date.now;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 4000;
  }

  /** Idempotent: concurrent callers share one initialization. */
  init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    this.config = parseConfig(this.env);
    if (this.config) this.apiKey = (this.env.POINTS_KEY ?? '').trim();
    if (this.config) await this.loadState();
    if (!this.closed && !this.timer) {
      this.timer = setInterval(() => {
        void this.flushNow();
      }, FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Called on focus state change; resets continuity on any session/status change. */
  setSession(session: FocusSession | null): void {
    const before = this.session;
    this.session = session ? { ...session } : null; // snapshot: never mutated later
    const sameActiveSession =
      session !== null &&
      before !== null &&
      session.id === before.id &&
      session.status === before.status &&
      session.status === 'active';
    if (!sameActiveSession) {
      this.generation++; // invalidates any queued observation from the old state
      this.prev = null;
    }
  }

  /** Resets continuity when the latest analysis was invalidated. */
  invalidateCheck(): void {
    this.generation++;
    this.prev = null;
  }

  /**
   * Passive hook. Called synchronously after a persisted observation;
   * returns immediately and swallows all internal async errors.
   */
  recordObservation(observation: Observation): void {
    const gen = this.generation;
    const sessionSnapshot = this.session ? { ...this.session } : null;
    const observedAt = this.now();
    void this.enqueueObservation({ ...observation }, gen, sessionSnapshot, observedAt).catch(() => {
      if (this.generation === gen) { this.generation++; this.prev = null; }
    });
  }

  async leaderboard(): Promise<FriendsState> {
    try {
      await this.init(); // coalesced; never claims corrupt while loading
    } catch {
      /* init never throws to callers */
    }
    const playerName = this.config?.playerName ?? (this.env.POINTS_PLAYER_NAME ?? '').trim();
    if (!this.config) {
      return {
        status: 'setup',
        rows: [],
        playerName,
        message: 'Friends needs the shared points service.',
      };
    }
    if (this.corrupt || !this.state) {
      return {
        status: 'offline',
        rows: [],
        playerName,
        message: 'Points state file is unreadable; fix or remove it before points can sync.',
      };
    }
    try {
      if (!this.state.player) await this.ensureRegistered();
      const data = await this.requestJson('GET', '/v1/leaderboard', LeaderboardResponseSchema);
      return { status: 'ready', rows: data.rows, playerName, message: null };
    } catch {
      return {
        status: 'offline',
        rows: [],
        playerName,
        message: this.diskError
          ? 'Could not save points progress locally; points are paused.'
          : 'Points service is unreachable right now.',
      };
    }
  }

  /** Coalesced: awaiting flushNow always awaits the current flush if one is running. */
  flushNow(): Promise<void> {
    if (this.flushPromise) return this.flushPromise;
    const run = (async () => {
      try {
        await this.runFlush();
      } catch {
        /* never surfaces raw errors */
      }
    })().finally(() => {
      this.flushPromise = null;
    });
    this.flushPromise = run;
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const ctrl of this.aborts) ctrl.abort();
    this.aborts.clear();
    await Promise.race([
      this.ioChain.catch(() => {}),
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.timeoutMs);
        t.unref?.();
      }),
    ]);
  }

  // ---------------------------------------------------------------- private

  private async loadState(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.state = this.freshState(); // only a missing file means fresh
        return;
      }
      this.corrupt = true; // other read errors: never overwrite
      this.state = null;
      return;
    }
    let parsed: PersistedState;
    try {
      parsed = PersistedStateSchema.parse(JSON.parse(raw));
    } catch {
      this.corrupt = true; // never silently overwrite a malformed queue
      this.state = null;
      return;
    }
    const storedName = parsed.playerName.trim().toLowerCase();
    if (
      parsed.baseUrl !== this.config!.baseUrl ||
      storedName !== this.config!.playerName.trim().toLowerCase()
    ) {
      // Different identity: never submit the previous player's queue.
      this.state = this.freshState();
      return;
    }
    this.state = parsed;
  }

  private freshState(): PersistedState {
    return {
      version: 1,
      baseUrl: this.config!.baseUrl,
      playerName: this.config!.playerName,
      player: null,
      outbox: [],
    };
  }

  private runIo<T>(task: () => Promise<T> | T): Promise<T> {
    const run = this.ioChain.then(task, task);
    this.ioChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private persistLocked(): Promise<void> {
    if (this.corrupt || !this.state) return Promise.reject(new Error('points-state-unavailable'));
    const data = JSON.stringify(this.state); // key is never part of state
    const tmp = this.statePath + '.tmp';
    return mkdir(path.dirname(this.statePath), { recursive: true })
      .then(() => writeFile(tmp, data, { mode: 0o600 }))
      .then(() => rename(tmp, this.statePath));
  }

  private enqueueObservation(
    observation: Observation,
    gen: number,
    sessionSnapshot: FocusSession | null,
    observedAt: number,
  ): Promise<void> {
    return this.runIo(async () => {
      if (this.closed || !this.config || !this.state || this.corrupt) return;
      if (this.generation !== gen) return; // queued sample is stale: skip, never rewind baseline
      const session = sessionSnapshot;
      if (!session || session.status !== 'active' || observation.sessionId !== session.id) {
        this.generation++;
        this.prev = null;
        return;
      }
      const cur: Sample = {
        id: observation.id,
        sessionId: observation.sessionId,
        createdAt: observation.createdAt,
        verdict: observation.verdict,
        confidence: observation.confidence,
        phoneDetected: observation.phoneDetected,
      };
      if (!isValidSample(cur, observedAt)) {
        this.prev = null;
        return;
      }
      const prev = this.prev;
      if (prev && (prev.id === cur.id || Date.parse(cur.createdAt) <= Date.parse(prev.createdAt))) return;
      if (!prev || !qualifiesPair(prev, cur, observedAt)) {
        this.prev = cur;
        return;
      }
      const record: FocusInterval = {
        id: intervalId(cur.id),
        start: prev.createdAt,
        end: cur.createdAt,
      };
      if (this.state.outbox.some((r) => r.id === record.id)) {
        this.prev = cur; // duplicate/stale observation id: never double credit, never rewind
        return;
      }
      this.state.outbox.push(record);
      if (this.state.outbox.length > MAX_OUTBOX) this.state.outbox.shift();
      if (this.closed || this.generation !== gen) {
        this.state.outbox = this.state.outbox.filter((r) => r.id !== record.id);
        return;
      }
      try {
        await this.persistLocked(); // durable before any network send
        this.diskError = false;
      } catch {
        // never queue a record that did not persist
        this.state.outbox = this.state.outbox.filter((r) => r.id !== record.id);
        this.diskError = true;
        this.generation++;
        this.prev = null;
        return;
      }
      if (this.generation !== gen) {
        // invalidated while persisting: drop the credit, never restore prev from old generation
        this.state.outbox = this.state.outbox.filter((r) => r.id !== record.id);
        try {
          await this.persistLocked();
        } catch {
          this.diskError = true;
        }
        return;
      }
      this.prev = cur;
    }).then(() => {
      void this.flushNow();
    });
  }

  /** Expire by `start` (the server validates start), then snapshot a bounded batch. */
  private expireBatch(): Promise<FocusInterval[]> {
    return this.runIo(() => {
      if (!this.state || this.corrupt) return [];
      const cutoff = this.now() - RETENTION_MS;
      const kept: FocusInterval[] = [];
      let changed = false;
      for (const record of this.state.outbox) {
        const start = Date.parse(record.start);
        if (Number.isFinite(start) && start < cutoff) {
          changed = true;
          continue;
        }
        kept.push(record);
      }
      if (!changed) return kept.slice(0, FLUSH_BATCH);
      const snapshot = this.state.outbox;
      this.state.outbox = kept;
      return this.persistLocked()
        .then((): FocusInterval[] => {
          this.diskError = false;
          return kept.slice(0, FLUSH_BATCH);
        })
        .catch((): FocusInterval[] => {
          if (this.state) this.state.outbox = snapshot;
          this.diskError = true;
          return []; // diskError blocks flushing until the next persist success
        });
    });
  }

  private async runFlush(): Promise<void> {
    if (this.closed || !this.config || this.corrupt || !this.state) return;
    if (this.diskError) {
      try { await this.runIo(() => this.persistLocked()); this.diskError = false; }
      catch { return; }
    }
    if (!this.state.player) {
      try {
        await this.ensureRegistered();
      } catch {
        return;
      }
    }
    if (!this.state.player) return;
    const player = this.state.player;
    const batch = await this.expireBatch();
    if (batch.length === 0) return;
    for (const record of batch) {
      if (this.closed || this.corrupt) return;
      try {
        const parsed = await this.requestJson('POST', '/v1/focus', FocusResponseSchema, {
          id: record.id,
          playerId: player.id,
          source: POINTS_SOURCE,
          start: record.start,
          end: record.end,
        });
        if (parsed.row.id !== player.id) return;
      } catch {
        return; // first network/server failure stops the batch
      }
      const removed = await this.runIo(async () => {
        if (!this.state) return false;
        const snapshot = this.state.outbox;
        const next = snapshot.filter((r) => r.id !== record.id);
        if (next.length === snapshot.length) return true; // already gone
        this.state.outbox = next;
        try {
          await this.persistLocked();
          this.diskError = false;
          return true;
        } catch {
          this.state.outbox = snapshot; // restore for retry; server is idempotent
          this.diskError = true;
          return false;
        }
      });
      if (!removed) return;
    }
  }

  private ensureRegistered(): Promise<Player> {
    if (!this.registerInFlight) {
      this.registerInFlight = this.doRegister().finally(() => {
        this.registerInFlight = null;
      });
    }
    return this.registerInFlight;
  }

  private async doRegister(): Promise<Player> {
    if (!this.config) throw new Error('not-configured');
    const parsed = await this.requestJson('POST', '/v1/players', PlayerResponseSchema, {
      name: this.config.playerName,
    });
    const player = parsed.player;
    if (player.name.trim().toLowerCase() !== this.config.playerName.toLowerCase()) throw new Error('player-mismatch');
    await this.runIo(async () => {
      if (!this.state) throw new Error('points-state-unavailable');
      const previous = this.state.player;
      this.state.player = player;
      try { await this.persistLocked(); }
      catch { this.state.player = previous; this.diskError = true; throw new Error('points-state-unavailable'); }
    });
    this.diskError = false;
    return player;
  }

  /** Fetch + JSON parse + schema validate, all inside the request timeout. */
  private async requestJson<T>(
    method: 'GET' | 'POST',
    path: string,
    schema: { parse: (value: unknown) => T },
    body?: unknown,
  ): Promise<T> {
    if (!this.config || !this.apiKey) throw new Error('not-configured');
    if (this.closed) throw new Error('closed');
    const ctrl = new AbortController();
    this.aborts.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetchImpl(this.config.baseUrl + path, {
        method,
        headers: {
          'x-points-key': this.apiKey,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      const parsed: unknown = await res.json(); // abort stays active through body read
      if (this.closed) throw new Error('closed');
      if (!res.ok) throw new Error('http-' + res.status);
      return schema.parse(parsed);
    } finally {
      clearTimeout(timer);
      this.aborts.delete(ctrl);
    }
  }
}

