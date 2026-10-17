/**
 * Shared contract for the optional multiplayer points adapter.
 * Mirrors the North Star API and is safe to import from any process.
 */

export const POINTS_SOURCE = 'goal-coach';

export interface Player {
  id: string;
  name: string;
  color: string;
  goalTitle?: string | null;
  createdAt: string;
}

export interface PointsRow {
  rank: number;
  /** The API exposes the player id as `id`, NOT `playerId`. */
  id: string;
  name: string;
  color: string;
  points: number;
  focusedMinutes: number;
  todayMinutes: number;
  streak: number;
  lastActiveAt: string | null;
  live: boolean;
  sources: string[];
  goalTitle?: string | null;
  createdAt: string;
}

export interface FriendsState {
  status: 'ready' | 'setup' | 'offline';
  rows: PointsRow[];
  playerName: string;
  message: string | null;
}

/** Outbox record: only ever id + start + end. */
export interface FocusInterval {
  id: string;
  start: string;
  end: string;
}

/** Minimal shape of an observation sample used for continuity checks. */
export interface Sample {
  id: string;
  sessionId: string;
  createdAt: string;
  verdict: 'on_track' | 'off_track' | 'uncertain';
  confidence: number;
  phoneDetected?: boolean;
}

export function intervalId(observationId: string): string {
  return 'goal-coach:' + observationId;
}

/**
 * A single sample is creditable when the verdict is `on_track`, the
 * confidence is a finite number in [0, 1] (a shape-validity check only —
 * there is no minimum-confidence eligibility gate), and it is not in
 * the future. Phone-detected samples are never creditable.
 */
export function isValidSample(sample: Sample, nowMs: number): boolean {
  if (!sample || typeof sample.id !== 'string' || sample.id.length === 0) return false;
  if (typeof sample.sessionId !== 'string' || sample.sessionId.length === 0) return false;
  if (sample.verdict !== 'on_track') return false;
  if (typeof sample.confidence !== 'number' || !Number.isFinite(sample.confidence)) return false;
  if (sample.confidence < 0 || sample.confidence > 1) return false;
  if (sample.phoneDetected !== undefined && typeof sample.phoneDetected !== 'boolean') return false;
  if (sample.phoneDetected === true) return false;
  const t = Date.parse(sample.createdAt);
  if (!Number.isFinite(t)) return false;
  if (t > nowMs + 1000) return false;
  return true;
}

/**
 * Pure helper: does `prev` chain to `cur` as a creditable interval?
 * Both ends must be valid on_track samples (any confidence in [0, 1],
 * no phone), in the same session, with ids differing, strictly
 * increasing timestamps and a gap of 5s..30s inclusive. The first
 * sample of a session never qualifies because `prev` is absent.
 */
export function qualifiesPair(prev: Sample, cur: Sample, nowMs: number): boolean {
  if (!prev || !cur) return false;
  if (!isValidSample(prev, nowMs) || !isValidSample(cur, nowMs)) return false;
  if (prev.id === cur.id) return false;
  if (prev.sessionId !== cur.sessionId) return false;
  const a = Date.parse(prev.createdAt);
  const b = Date.parse(cur.createdAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (b <= a) return false;
  const delta = b - a;
  if (delta < 5000 || delta > 30000) return false;
  return true;
}
