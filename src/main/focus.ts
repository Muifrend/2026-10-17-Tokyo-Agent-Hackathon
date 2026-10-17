import { randomUUID } from 'node:crypto';
import {
  Analysis,
  Goal,
  FocusSession,
  Frames,
  Message,
  Observation,
} from '../shared/types';
import type { Store } from './repository';

export interface FocusAI {
  verifyVision(): Promise<void>;
  analyze(goal: Goal, frames: Frames, signal?: AbortSignal): Promise<Analysis>;
}

export interface FocusCapture {
  start(displayId: string): Promise<void>;
  frames(): Promise<Frames>;
  stop(): Promise<void>;
}

export type FocusOptions = {
  store: Store;
  capture: FocusCapture;
  ai: FocusAI;
  getGoal: (id: string) => Goal | undefined;
  notify: (title: string, body: string) => void;
  onChange: () => void;
  onReminder: (msg: Message) => void;
  onNotice: (text: string | null) => void;
  onObservation?: (observation: Observation) => void;
  intervalMs?: number;
  now?: () => number;
};

const REMINDER_COOLDOWN_MS = 120000;
const ANALYZE_TIMEOUT_MS = 30000;

const VALID_VERDICTS = ['on_track', 'off_track', 'uncertain'];

function isValidAnalysis(a: unknown): a is Analysis {
  if (!a || typeof a !== 'object') return false;
  const x = a as Record<string, unknown>;
  if (!VALID_VERDICTS.includes(x.verdict as string)) return false;
  if (typeof x.confidence !== 'number' || !Number.isFinite(x.confidence)) return false;
  if (x.confidence < 0 || x.confidence > 1) return false;
  if (typeof x.reason !== 'string' || x.reason.length === 0) return false;
  if (typeof x.reminderText !== 'string' || x.reminderText.length === 0) return false;
  if (x.phoneDetected !== undefined && typeof x.phoneDetected !== 'boolean') return false;
  return true;
}

function makeId(_prefix: string): string { return randomUUID(); }

export class FocusController {
  session: FocusSession | null = null;

  private opts: FocusOptions;
  private gen = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private abort: AbortController | null = null;
  private consecutiveOffTrack = 0;
  private consecutiveErrors = 0;
  private lastReminderAt = -Infinity;
  private displayId: string | null = null;

  constructor(options: FocusOptions) {
    this.opts = options;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private safeNotify(title: string, body: string): void {
    try {
      this.opts.notify(title, body);
    } catch {
      /* callback errors must not crash */
    }
  }

  private safeOnReminder(msg: Message): void {
    try {
      this.opts.onReminder(msg);
    } catch {
      /* ignore */
    }
  }

  private safeNotice(text: string | null): void {
    try {
      this.opts.onNotice(text);
    } catch {
      /* ignore */
    }
  }

  private emit(): void {
    try {
      this.opts.onChange();
    } catch {
      /* ignore */
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private invalidate(): void {
    this.gen++;
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    this.clearTimer();
    this.busy = false;
  }

  async start(goal: Goal, displayId: string): Promise<void> {
    await this.stop();
    const t = this.now();
    this.session = {
      id: makeId('fs'),
      goalId: goal.id,
      status: 'paused',
      startedAt: new Date(t).toISOString(),
      endedAt: null,
      pauseReason: null,
      displayId,
    };
    this.lastReminderAt = -Infinity;
    this.emit();
    await this.resume(displayId);
  }

  async resume(displayId?: string): Promise<void> {
    const s = this.session;
    if (!s || s.status === 'ended') {
      this.safeNotice('No resumable focus session');
      return;
    }
    const goal = this.opts.getGoal(s.goalId);
    if (!goal || !goal.ready) {
      this.safeNotice('Goal is not ready');
      return;
    }

    this.invalidate();
    const myGen = ++this.gen;
    this.abort = new AbortController();
    this.consecutiveOffTrack = 0;
    this.consecutiveErrors = 0;

    if (displayId) this.displayId = displayId;
    else if (s.displayId) this.displayId = s.displayId;

    try {
      if (!this.displayId) throw new Error('Select a display before resuming.');
      await this.opts.ai.verifyVision();
      if (this.gen !== myGen || !this.session || this.session.id !== s.id) return;

      await this.opts.capture.start(this.displayId as string);
      if (this.gen !== myGen || !this.session || this.session.id !== s.id) return;

      this.session = { ...s, status:'active', pauseReason:null, displayId:this.displayId };
      await this.opts.store.saveSession(this.session);
      if (this.gen !== myGen || !this.session || this.session.id !== s.id) return;

      this.safeNotice(null);
      this.emit();

      const intervalMs = this.opts.intervalMs ?? 20000;
      this.clearTimer();
      this.timer = setInterval(() => {
        this.tick().catch(() => {
          /* interval must never crash */
        });
      }, intervalMs);
    } catch (err) {
      if (this.gen === myGen) await this.pause(err instanceof Error ? err.message.slice(0,180) : 'Could not start focus session');
      throw err;
    }
  }

  async pause(reason = 'paused'): Promise<void> {
    const s = this.session;
    if (!s || s.status === 'ended' || s.status === 'interrupted') return;

    // Synchronous invalidation before any await.
    this.invalidate();
    this.consecutiveOffTrack = 0;

    const pauseGeneration=this.gen;
    this.session = { ...s, status:'paused', pauseReason:reason };
    this.emit();

    try {
      await this.opts.capture.stop();
    } catch {
      /* stop tracks regardless */
    }

    if(this.gen!==pauseGeneration)return;
    try {
      await this.opts.store.saveSession(this.session!);
    } catch {
      this.safeNotice('Could not save pause state');
    }
  }

  async stop(): Promise<void> {
    const s = this.session;
    this.invalidate();

    if (!s) { await this.opts.capture.stop(); return; }

    const endedSession:FocusSession={ ...s, status:'ended', endedAt:new Date(this.now()).toISOString(), pauseReason:null };
    this.session = endedSession;
    this.emit();

    try {
      await this.opts.capture.stop();
    } catch {
      /* ignore */
    }

    try {
      await this.opts.store.saveSession(endedSession);
    } catch {
      this.safeNotice('Could not save session end');
    }
    this.emit();
  }

  async tick(): Promise<void> {
    const s = this.session;
    if (!s || s.status !== 'active' || this.busy) return;

    const myGen = this.gen;
    this.busy = true;

    try {
      const goal = this.opts.getGoal(s.goalId);
      if (!goal || !goal.ready) {
        if (this.gen === myGen) await this.pause('Goal is not available');
        return;
      }

      let frames: Frames;
      try {
        frames = await this.opts.capture.frames();
      } catch {
        // Capture failure: pause immediately (missing permission / camera left running).
        if (this.gen === myGen) await this.pause('Screen or camera capture failed');
        return;
      }
      if (this.gen !== myGen) return;

      const external = this.abort?.signal;
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), ANALYZE_TIMEOUT_MS);
      const onAbort = () => deadline.abort();
      if (external) {
        if (external.aborted) deadline.abort();
        else external.addEventListener('abort', onAbort, { once: true });
      }

      let analysis: Analysis;
      try {
        analysis = await this.opts.ai.analyze(goal, frames, deadline.signal);
      } catch {
        if (this.gen !== myGen) return;
        this.consecutiveOffTrack = 0;
        this.safeNotice('Analysis unavailable. Retrying…');
        this.consecutiveErrors++;
        if (this.consecutiveErrors >= 3) {
          await this.pause('Analysis failed repeatedly');
        }
        return;
      } finally {
        clearTimeout(timer);
        if (external) external.removeEventListener('abort', onAbort);
      }
      if (this.gen !== myGen) return;

      // Re-validate locally: never trust model output shape.
      if (!isValidAnalysis(analysis)) {
        this.consecutiveOffTrack = 0;
        this.consecutiveErrors++;
        this.safeNotice('Invalid analysis. Retrying…');
        if (this.consecutiveErrors >= 3) await this.pause('Analysis failed repeatedly');
        return;
      }

      // Phone detection is a direct object-detection policy: normalize before persist.
      if (analysis.phoneDetected === true) {
        analysis = {
          ...analysis,
          verdict: 'off_track',
          reminderText: 'Stop using your phone.',
        };
      }

      const observation: Observation = {
        ...analysis,
        id: makeId('obs'),
        sessionId: s.id,
        createdAt: new Date(this.now()).toISOString(),
      };
      try {
        await this.opts.store.saveObservation({ ...observation });
      } catch {
        // Findings would be lost; never fire reminders from unsaved observations.
        if (this.gen === myGen) await this.pause('Could not save observation');
        return;
      }
      if (this.gen !== myGen) return;

      // Success: reset error streak only AFTER observation persisted.
      this.consecutiveErrors = 0;
      this.safeNotice(null);

      // Optional consumers receive only saved findings and cannot affect coaching.
      try { this.opts.onObservation?.({ ...observation }); } catch { /* independent consumer */ }

      const t = this.now();

      // All other distractions retain the original two-high-confidence check with cooldown.
      if (analysis.verdict === 'off_track' && analysis.confidence >= 0.8) {
        this.consecutiveOffTrack++;
      } else {
        // Every other verdict / low confidence resets the streak.
        this.consecutiveOffTrack = 0;
      }

      if (
        (analysis.phoneDetected === true || this.consecutiveOffTrack >= 2) &&
        t - this.lastReminderAt >= REMINDER_COOLDOWN_MS
      ) {
        let msg: Message;
        try {
          msg = await this.opts.store.saveReminder(goal, analysis.reminderText);
        } catch {
          if (this.gen === myGen) await this.pause('Could not save reminder');
          return;
        }
        if (this.gen !== myGen) return;

        this.lastReminderAt = t;
        this.consecutiveOffTrack = 0;

        this.safeOnReminder({ ...msg });
        this.safeNotify(goal.title, analysis.reminderText);
        this.emit();
      }
    } finally {
      // Old continuations must never clear the busy lock of a newer generation.
      if (this.gen === myGen) this.busy = false;
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.stop();
    } catch {
      /* ignore */
    }
    this.invalidate();
  }
}
