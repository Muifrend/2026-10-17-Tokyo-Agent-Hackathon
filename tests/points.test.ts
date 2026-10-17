import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { qualifiesPair } from '../src/shared/points';
import { PointsService } from '../src/main/points';
import type { FocusSession, Observation } from '../src/shared/types';

const BASE = Date.parse('2024-01-01T10:00:00.000Z');
const iso = (ms: number) => new Date(BASE + ms).toISOString();
const wait = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));

let nowOffset = 0;
const now = () => BASE + nowOffset;

const session = (over: Partial<FocusSession> = {}): FocusSession => ({
  id: 's1',
  goalId: 'g1',
  status: 'active',
  startedAt: iso(0),
  endedAt: null,
  pauseReason: null,
  displayId: null,
  ...over,
});

const obs = (id: string, atMs: number, over: Partial<Observation> = {}): Observation => ({
  id,
  sessionId: 's1',
  createdAt: iso(atMs),
  verdict: 'on_track',
  confidence: 0.95,
  phoneDetected: false,
  reason: '',
  reminderText: '',
  ...over,
});

const player = { id: 'p1', name: 'Ada', color: '#88aaff', goalTitle: null, createdAt: iso(0) };
const row = {
  rank: 1,
  id: 'p1',
  createdAt: iso(0),
  goalTitle: null,
  name: 'Ada',
  color: '#88aaff',
  points: 10,
  focusedMinutes: 10,
  todayMinutes: 10,
  streak: 1,
  lastActiveAt: iso(0),
  live: true,
  sources: ['goal-coach'],
};

interface FakeFetch {
  calls: { url: string; method?: string; key?: string; body?: unknown }[];
  failFocus: boolean;
  networkDown: boolean;
  leaderboardMalformed: boolean;
}

function makeFetch(fake: FakeFetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    fake.calls.push({ url, method: init?.method, key: headers['x-points-key'], body });
    if (fake.networkDown) throw new Error('ECONNREFUSED');
    const json = (o: unknown, status = 200) => ({ ok: status < 400, status, json: async () => o });
    if (url.endsWith('/v1/players')) return json({ player });
    if (url.endsWith('/v1/leaderboard')) return fake.leaderboardMalformed ? json({ rows: 'nope' }) : json({ rows: [row] });
    if (url.endsWith('/v1/focus')) {
      if (fake.failFocus) return json({ error: 'nope' }, 500);
      return json({ row });
    }
    return json({ error: 'not found' }, 404);
  }) as typeof fetch;
}

const envFor = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  POINTS_URL: 'https://points.example.com',
  POINTS_KEY: 'secret-key',
  POINTS_PLAYER_NAME: 'Ada',
  ...over,
});

let dir = '';
let statePath = '';
let fake: FakeFetch;
let service: PointsService;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  nowOffset = 120000;
  dir = await mkdtemp(path.join(tmpdir(), 'points-'));
  statePath = path.join(dir, 'points-state.json');
  fake = { calls: [], failFocus: false, networkDown: false, leaderboardMalformed: false };
  service = new PointsService({ env: envFor(), statePath, now, fetch: makeFetch(fake) });
  cleanup = () => rm(dir, { recursive: true, force: true });
});

afterEach(async () => {
  await service.close();
  await cleanup();
});

const focusCalls = () => fake.calls.filter((c) => c.url.endsWith('/v1/focus'));

describe('PointsService', () => {
  it('absent configuration: setup state, no network, no throw', async () => {
    const bare = new PointsService({
      env: {},
      statePath,
      now,
      fetch: makeFetch(fake),
    });
    await bare.init();
    bare.recordObservation(obs('a', 0));
    const state = await bare.leaderboard();
    expect(state.status).toBe('setup');
    expect(fake.calls).toHaveLength(0);
    await bare.close();
  });

  it('credits a qualifying interval, key stays out of file/state', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();

    const calls = focusCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({
      id: 'goal-coach:b',
      source: 'goal-coach',
      start: iso(0),
      end: iso(10000),
    });
    expect(calls[0].key).toBe('secret-key');
    const file = await readFile(statePath, 'utf8');
    expect(file).not.toContain('secret-key');
    expect(JSON.parse(file).outbox).toHaveLength(0);
  });

  it('never credits the first sample alone', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it('boundary: only gaps of 5 through 30 seconds qualify', () => {
    expect(qualifiesPair(obs('a', 0), obs('b', 5000), now())).toBe(true);
    expect(qualifiesPair(obs('a', 0), obs('b', 4999), now())).toBe(false);
    expect(qualifiesPair(obs('a', 0), obs('b', 30000), now())).toBe(true);
    expect(qualifiesPair(obs('a', 0), obs('b', 30001), now())).toBe(false);
  });

  it.each([
    ['off_track', { verdict: 'off_track' as const }],
    ['uncertain', { verdict: 'uncertain' as const }],
    ['NaN confidence', { confidence: NaN }],
    ['out-of-range confidence', { confidence: 1.1 }],
    ['phone detected', { phoneDetected: true }],
  ])('breaks continuity through a %s sample', async (_name, over) => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000, over));
    await wait();
    service.recordObservation(obs('c', 20000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it.each([0.6, 0.7, 0.75, 0, 1])('low or boundary confidence %s still credits a durable exact interval', async (confidence) => {
    expect(qualifiesPair(obs('a', 0, { confidence }), obs('b', 10000, { confidence }), now())).toBe(true);
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0, { confidence }));
    await wait();
    service.recordObservation(obs('b', 10000, { confidence }));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(1);
    expect(focusCalls()[0].body).toMatchObject({ id: 'goal-coach:b', start: iso(0), end: iso(10000) });
  });

  it.each([-1, 1.1])('malformed confidence %s is rejected by the pair check', (confidence) => {
    expect(qualifiesPair(obs('a', 0, { confidence }), obs('b', 10000), now())).toBe(false);
    expect(qualifiesPair(obs('a', 0), obs('b', 10000, { confidence }), now())).toBe(false);
  });

  it('pause then resume on same session id resets continuity', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.setSession(session({ status: 'paused' }));
    service.setSession(session());
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
    service.recordObservation(obs('c', 20000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(1);
    expect(focusCalls()[0].body).toMatchObject({ id: 'goal-coach:c' });
  });

  it('session switch breaks continuity across sessions', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.setSession(session({ id: 's2' }));
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it('skips 40s gaps but resumes on the next qualifying pair', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 40000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
    service.recordObservation(obs('c', 50000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(1);
    expect(focusCalls()[0].body).toMatchObject({ id: 'goal-coach:c', start: iso(40000), end: iso(50000) });
  });

  it('duplicate observation never double credits', async () => {
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(1);
  });

  it('retries queued interval after network failure with exact id/timestamps', async () => {
    fake.networkDown = true;
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
    const onDisk = JSON.parse(await readFile(statePath, 'utf8'));
    expect(onDisk.outbox).toEqual([{ id: 'goal-coach:b', start: iso(0), end: iso(10000) }]);

    fake.networkDown = false;
    await service.flushNow();
    const calls = focusCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ id: 'goal-coach:b', start: iso(0), end: iso(10000) });
    expect(JSON.parse(await readFile(statePath, 'utf8')).outbox).toHaveLength(0);
  });

  it('restart restores pending records from disk', async () => {
    fake.networkDown = true;
    await service.init();
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.close();

    fake.networkDown = false;
    const second = new PointsService({ env: envFor(), statePath, now, fetch: makeFetch(fake) });
    await second.init();
    await second.flushNow();
    const calls = focusCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ id: 'goal-coach:b', start: iso(0), end: iso(10000) });
    await second.close();
  });

  it('malformed leaderboard response degrades to safe offline state', async () => {
    fake.leaderboardMalformed = true;
    await service.init();
    const state = await service.leaderboard();
    expect(state.status).toBe('offline');
    expect(state.rows).toEqual([]);
    expect(state.message).toBeTruthy();
  });

  it('valid leaderboard response is exposed as ready', async () => {
    await service.init();
    const state = await service.leaderboard();
    expect(state.status).toBe('ready');
    expect(state.rows).toHaveLength(1);
    expect(state.playerName).toBe('Ada');
    expect(state.message).toBeNull();
  });

  it('API unavailable: recordObservation returns immediately and never throws', async () => {
    fake.networkDown = true;
    await service.init();
    service.setSession(session());
    expect(() => service.recordObservation(obs('a', 0))).not.toThrow();
    await wait();
    const state = await service.leaderboard();
    expect(state.status).toBe('offline');
    expect(state.message).toBeTruthy();
  });

  it('corrupt state file: init fails soft, file is not overwritten, nothing is sent', async () => {
    await writeFile(statePath, '{broken', 'utf8');
    await service.init();
    const state = await service.leaderboard();
    expect(state.status).toBe('offline');
    service.setSession(session());
    service.recordObservation(obs('a', 0));
    await wait();
    service.recordObservation(obs('b', 10000));
    await wait();
    await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
    expect(await readFile(statePath, 'utf8')).toBe('{broken');
  });

  it('init does not mutate the provided env object', async () => {
    const env = envFor();
    const snapshot = JSON.stringify(env);
    await service.init();
    expect(JSON.stringify(env)).toBe(snapshot);
  });

  it('recordObservation before init skips safely', () => {
    const uninitialized = new PointsService({ env: envFor(), statePath, now, fetch: makeFetch(fake) });
    expect(() => uninitialized.recordObservation(obs('a', 0))).not.toThrow();
  });
  it('queued callbacks cannot restore continuity after an immediate pause/resume', async () => {
    await service.init(); service.setSession(session());
    service.recordObservation(obs('a', 0));
    service.setSession(session({ status: 'paused' })); service.setSession(session());
    service.recordObservation(obs('b', 10000)); await wait(); await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it('queued callbacks cannot restore continuity after a failed check', async () => {
    await service.init(); service.setSession(session());
    service.recordObservation(obs('a', 0)); service.invalidateCheck();
    service.recordObservation(obs('b', 10000)); await wait(); await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it('stale duplicate observations cannot rewind the interval baseline', async () => {
    await service.init(); service.setSession(session());
    service.recordObservation(obs('a', 0)); await wait();
    service.recordObservation(obs('b', 10000)); await wait(); await service.flushNow();
    service.recordObservation(obs('a', 0)); await wait();
    service.recordObservation(obs('c', 20000)); await wait(); await service.flushNow();
    expect(focusCalls().map(c => c.body)).toEqual([
      expect.objectContaining({start:iso(0),end:iso(10000)}),
      expect.objectContaining({start:iso(10000),end:iso(20000)}),
    ]);
  });

  it('expired persisted intervals are discarded using their start time', async () => {
    const oldStart = new Date(now() - 48*3600000 - 1000).toISOString();
    const recentEnd = new Date(now() - 48*3600000 + 19000).toISOString();
    await writeFile(statePath, JSON.stringify({version:1,baseUrl:envFor().POINTS_URL,playerName:'Ada',player,
      outbox:[{id:'expired',start:oldStart,end:recentEnd}]}));
    await service.init(); await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
    expect(JSON.parse(await readFile(statePath,'utf8')).outbox).toEqual([]);
  });

  it('a different configured player never submits the previous player queue', async () => {
    await writeFile(statePath, JSON.stringify({version:1,baseUrl:envFor().POINTS_URL,playerName:'Other',player,
      outbox:[{id:'someone-else',start:iso(0),end:iso(10000)}]}));
    await service.init(); await service.flushNow();
    expect(focusCalls()).toHaveLength(0);
  });

  it('strips extra server fields from the state exposed to the renderer', async () => {
    const customFetch = (async (_input:unknown,init?:RequestInit) => ({ok:true,status:200,json:async()=>
      init?.method==='POST'?{player}:{rows:[{...row,secret:'must-not-reach-renderer'}]}})) as typeof fetch;
    const other=new PointsService({env:envFor(),statePath,now,fetch:customFetch});
    try {const state=await other.leaderboard(); expect(state.status).toBe('ready'); expect(JSON.stringify(state)).not.toContain('must-not');}
    finally {await other.close();}
  });

});
