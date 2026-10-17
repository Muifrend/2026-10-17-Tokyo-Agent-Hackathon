import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { FocusController, FocusAI, FocusCapture } from '../src/main/focus';
import { Analysis, Goal, Message, Observation, Frames } from '../src/shared/types';
import type { Store } from '../src/main/repository';

function makeGoal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    title: 'Deep Work',
    outcome: 'finish the report',
    onTrack: ['writing'],
    offTrack: ['social media'],
    ready: true,
    sourceConversationId: 'c1',
    conversationId: 'c1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function analysis(over: Partial<Analysis> = {}): Analysis {
  return {
    verdict: 'off_track',
    confidence: 0.9,
    reason: 'browsing social media',
    reminderText: 'Please refocus on your goal.',
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  // let pending promise continuations (post fake-timer resolution) run
  return Promise.resolve().then(() => Promise.resolve());
}

function makeMocks() {
  const store = {
    load: vi.fn().mockResolvedValue({
      conversations: [],
      goals: [],
      messages: [],
      session: null,
      notice: null,
      ready: true,
    }),
    saveSession: vi.fn().mockResolvedValue(undefined),
    saveObservation: vi.fn().mockResolvedValue(undefined),
    saveReminder: vi.fn().mockImplementation(async (g:Goal,text:string) => ({id:'reminder',conversationId:g.conversationId,role:'reminder',content:text,createdAt:new Date().toISOString()})),
    saveConversation: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveGoal: vi.fn().mockResolvedValue(undefined),
    deleteGoal: vi.fn().mockResolvedValue(undefined),
  } as unknown as {[K in keyof Store]: Mock<Store[K]>};

  const capture = {
    start: vi.fn().mockResolvedValue(undefined),
    frames: vi.fn().mockResolvedValue({ screen: 's', camera: 'c' } as Frames),
    stop: vi.fn().mockResolvedValue(undefined),
  } as {[K in keyof FocusCapture]: Mock<FocusCapture[K]>};

  const ai = {
    verifyVision: vi.fn().mockResolvedValue(undefined),
    analyze: vi.fn().mockResolvedValue(analysis()),
  } as {[K in keyof FocusAI]: Mock<FocusAI[K]>};

  const notify = vi.fn();
  const onChange = vi.fn();
  const onReminder = vi.fn();
  const onNotice = vi.fn();

  return { store, capture, ai, notify, onChange, onReminder, onNotice };
}

type Mocks = ReturnType<typeof makeMocks>;

function makeController(m: Mocks, goals: Goal[]) {
  return new FocusController({
    store: m.store,
    capture: m.capture,
    ai: m.ai,
    getGoal: (id) => goals.find((g) => g.id === id),
    notify: m.notify,
    onChange: m.onChange,
    onReminder: m.onReminder,
    onNotice: m.onNotice,
    intervalMs: 20000,
  });
}

const goal = makeGoal();

describe('FocusController', () => {
  let m: Mocks;
  let controller: FocusController;

  beforeEach(() => {
    vi.useFakeTimers();
    m = makeMocks();
    controller = makeController(m, [goal]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two high-confidence off_track ticks trigger exactly one persistent reminder and one notification', async () => {
    m.ai.analyze.mockResolvedValue(analysis({ verdict: 'off_track', confidence: 0.9 }));
    await controller.start(goal, 'd1');

    await controller.tick();
    await controller.tick();
    await controller.tick();

    expect(m.store.saveReminder).toHaveBeenCalledTimes(1);
    expect(m.onReminder).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledWith('Deep Work', 'Please refocus on your goal.');
    expect(m.store.saveObservation).toHaveBeenCalledTimes(3);
    expect(m.store.saveReminder).toHaveBeenCalledWith(goal, 'Please refocus on your goal.');
  });

  it('on_track, uncertain and low-confidence verdicts reset the streak', async () => {
    m.ai.analyze
      .mockResolvedValueOnce(analysis({ verdict: 'off_track', confidence: 0.9 }))
      .mockResolvedValueOnce(analysis({ verdict: 'on_track', confidence: 0.95 }))
      .mockResolvedValueOnce(analysis({ verdict: 'uncertain', confidence: 0.9 }))
      .mockResolvedValueOnce(analysis({ verdict: 'off_track', confidence: 0.7 }));
    await controller.start(goal, 'd1');

    await controller.tick();
    await controller.tick();
    await controller.tick();
    await controller.tick();

    expect(m.store.saveReminder).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('cooldown suppresses repeated reminders', async () => {
    m.ai.analyze.mockResolvedValue(analysis({ verdict: 'off_track', confidence: 0.95 }));
    await controller.start(goal, 'd1');

    await controller.tick();
    await controller.tick(); // reminder fires here
    await controller.tick();
    await controller.tick();
    await controller.tick();

    expect(m.store.saveReminder).toHaveBeenCalledTimes(1);
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it('malformed verdict / confidence never notify', async () => {
    m.ai.analyze.mockResolvedValue({
      verdict: 'weird',
      confidence: 2.5,
      reason: 'x',
      reminderText: 'y',
    } as unknown as Analysis);
    await controller.start(goal, 'd1');
    await controller.tick();
    await controller.tick();

    expect(m.store.saveObservation).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.store.saveReminder).not.toHaveBeenCalled();
    expect(controller.session?.status).toBe('active');
  });

  it('skips tick while a previous analysis is still in flight', async () => {
    const d = deferred<Analysis>();
    m.ai.analyze.mockReturnValue(d.promise);
    await controller.start(goal, 'd1');

    const t1 = controller.tick();
    await controller.tick(); // busy: must be skipped
    expect(m.ai.analyze).toHaveBeenCalledTimes(1);

    d.resolve(analysis());
    await t1;
    expect(controller.session?.status).toBe('active');
  });

  it('pause aborts the analyze signal and stale results cannot persist or notify', async () => {
    const d = deferred<Analysis>();
    m.ai.analyze.mockReturnValue(d.promise);
    await controller.start(goal, 'd1');

    const t1 = controller.tick();
    await flush();
    const signal = m.ai.analyze.mock.calls[0][2] as AbortSignal;

    await controller.pause('manual');
    expect(signal.aborted).toBe(true);

    // Stale analyze resolves multiple times after pause: nothing may leak.
    d.resolve(analysis({ verdict: 'off_track', confidence: 0.99 }));
    await t1;
    await flush();

    expect(m.store.saveObservation).not.toHaveBeenCalled();
    expect(m.store.saveReminder).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.onReminder).not.toHaveBeenCalled();
    expect(controller.session?.status).toBe('paused');
  });

  it('switching goals discards late results of the old session', async () => {
    const d = deferred<Analysis>();
    m.ai.analyze.mockReturnValue(d.promise);
    const goal2 = makeGoal({ id: 'g2', title: 'Second' });
    controller = makeController(m, [goal, goal2]);
    await controller.start(goal, 'd1');
    const t1 = controller.tick();
    await flush();
    await controller.start(goal2, 'd2');

    d.resolve(analysis({ verdict: 'off_track', confidence: 0.99 }));
    await t1;
    await flush();

    expect(m.store.saveObservation).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
    expect(controller.session?.goalId).toBe('g2');
  });

  it('capture failure pauses immediately and stops the interval', async () => {
    m.capture.frames.mockRejectedValue(new Error('permission denied'));
    await controller.start(goal, 'd1');

    await controller.tick();
    expect(controller.session?.status).toBe('paused');
    expect(controller.session?.pauseReason).toContain('capture');
    expect(m.store.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' })
    );

    const framesCalls = m.capture.frames.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(m.capture.frames.mock.calls.length).toBe(framesCalls);
  });

  it('three consecutive API errors pause; earlier errors only retry', async () => {
    m.ai.analyze.mockRejectedValue(new Error('api down'));
    await controller.start(goal, 'd1');

    await controller.tick();
    await controller.tick();
    expect(controller.session?.status).toBe('active');

    await controller.tick();
    expect(controller.session?.status).toBe('paused');
    expect(m.notify).not.toHaveBeenCalled();
    expect(m.store.saveReminder).not.toHaveBeenCalled();
  });

  it('DB failure on observation pauses without any reminder or notification', async () => {
    m.store.saveObservation.mockRejectedValue(new Error('db locked'));
    m.ai.analyze.mockResolvedValue(analysis({ verdict: 'off_track', confidence: 0.95 }));
    await controller.start(goal, 'd1');

    await controller.tick();
    await controller.tick();

    expect(controller.session?.status).toBe('paused');
    expect(m.store.saveReminder).not.toHaveBeenCalled();
    expect(m.onReminder).not.toHaveBeenCalled();
    expect(m.notify).not.toHaveBeenCalled();
  });

  it('explicit resume preserves session id and reacquires capture', async () => {
    await controller.start(goal, 'd1');
    const id = controller.session!.id;
    expect(controller.session?.status).toBe('active');

    await controller.pause('manual');
    m.capture.start.mockClear();
    m.ai.verifyVision.mockClear();

    await controller.resume();
    expect(controller.session!.id).toBe(id);
    expect(controller.session?.status).toBe('active');
    expect(m.capture.start).toHaveBeenCalledTimes(1);
    expect(m.ai.verifyVision).toHaveBeenCalledTimes(1);
  });

  it('resume requires a ready goal and leaves the session paused otherwise', async () => {
    const notReady = makeGoal({ id: 'g3', ready: false });
    const c = makeController(m, [notReady]);
    await c.start(notReady, 'd1');

    expect(c.session?.status).toBe('paused');
    expect(m.capture.start).not.toHaveBeenCalled();
    expect(m.onNotice).toHaveBeenCalled();
  });

  it('dispose releases capture and clears the timer, ending the session', async () => {
    await controller.start(goal, 'd1');
    await controller.dispose();

    expect(controller.session?.status).toBe('ended');
    expect(m.capture.stop).toHaveBeenCalled();
    const framesCalls = m.capture.frames.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(m.capture.frames.mock.calls.length).toBe(framesCalls);
    expect(m.store.saveSession).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ended' })
    );
  });


  it('an API error breaks an otherwise consecutive off-track streak',async()=>{
    await controller.start(goal,'d1');
    m.ai.analyze.mockResolvedValueOnce(analysis()).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(analysis());
    await controller.tick();await controller.tick();await controller.tick();
    expect(m.notify).not.toHaveBeenCalled();
  });
  it('an invalid analysis breaks the consecutive off-track streak',async()=>{
    await controller.start(goal,'d1');
    m.ai.analyze.mockResolvedValueOnce(analysis()).mockResolvedValueOnce({...analysis(),confidence:NaN}).mockResolvedValueOnce(analysis());
    await controller.tick();await controller.tick();await controller.tick();
    expect(m.notify).not.toHaveBeenCalled();
  });
  it('a pause during vision preflight cannot start capture later',async()=>{
    const check=deferred<void>();m.ai.verifyVision.mockReturnValue(check.promise);
    const starting=controller.start(goal,'d1');await flush();
    await controller.pause('manual');check.resolve();await starting;
    expect(m.capture.start).not.toHaveBeenCalled();expect(controller.session?.status).toBe('paused');
  });

  it('emits state on transitions', async () => {
    await controller.start(goal, 'd1');
    const afterStart = m.onChange.mock.calls.length;
    expect(afterStart).toBeGreaterThan(0);
    await controller.pause('manual');
    expect(m.onChange.mock.calls.length).toBeGreaterThan(afterStart);
  });
});
