import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NativeNotificationLike } from '../src/main/notifications';
import { ReminderNotifications } from '../src/main/notifications';

class FakeNotification implements NativeNotificationLike {
  readonly emitter = new EventEmitter();
  shown = 0;
  closed = 0;

  once(event: 'failed' | 'close' | 'show', callback: () => void): unknown {
    this.emitter.once(event, callback);
    return this;
  }

  show(): void {
    this.shown++;
  }

  close(): void {
    this.closed++;
    this.emitter.emit('close');
  }

  emitFailed(): void {
    this.emitter.emit('failed');
  }

  emitShow(): void {
    this.emitter.emit('show');
  }
}

function setup(supported = true) {
  const created: FakeNotification[] = [];
  const deps = {
    supported: vi.fn(() => supported),
    create: vi.fn((title: string, body: string) => {
      const n = new FakeNotification();
      void title;
      void body;
      created.push(n);
      return n;
    }),
    onUnavailable: vi.fn(),
    onShown: vi.fn(),
  };
  const rn = new ReminderNotifications(deps);
  return { rn, deps, created };
}

describe('ReminderNotifications', () => {
  it('reports unavailable asynchronously when failed event fires after deliver', () => {
    const { rn, deps, created } = setup();
    rn.deliver('t', 'b');
    expect(deps.onUnavailable).not.toHaveBeenCalled();
    created[0].emitFailed();
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
    expect(created[0].closed).toBe(0);
  });

  it('reports shown only on the show event, not on .show() call', () => {
    const { rn, deps, created } = setup();
    rn.deliver('t', 'b');
    expect(deps.onShown).not.toHaveBeenCalled();
    created[0].emitShow();
    expect(deps.onShown).toHaveBeenCalledTimes(1);
  });

  it('reports unavailable immediately when unsupported', () => {
    const { rn, deps } = setup(false);
    rn.deliver('t', 'b');
    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('handles synchronous create exception', () => {
    const create = vi.fn(() => {
      throw new Error('boom');
    });
    const onUnavailable = vi.fn();
    const rn = new ReminderNotifications({
      supported: () => true,
      create,
      onUnavailable,
      onShown: vi.fn(),
    });
    rn.deliver('t', 'b');
    expect(onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('handles synchronous show exception and removes retained reference', () => {
    const { rn, deps, created } = setup();
    rn.deliver('t', 'b');
    const n = created[0];
    deps.create.mockImplementationOnce(() => {
      const failing = new FakeNotification();
      vi.spyOn(failing, 'show').mockImplementation(() => { throw new Error('boom'); });
      created.push(failing);
      return failing;
    });
    // deliver again with a failing-show notification
    rn.deliver('t2', 'b2');
    const second = created[1];
    expect(deps.onUnavailable).toHaveBeenCalledTimes(1);
    // second notification should not be retained: failing show removed it
    expect(second.emitter.listenerCount('failed')).toBe(1);
    rn.dispose();
    expect(n.closed).toBe(1);
    expect(second.closed).toBe(0);
  });

  it('ignores delayed failed events after dispose', () => {
    const { rn, deps, created } = setup();
    rn.deliver('t', 'b');
    rn.dispose();
    created[0].emitFailed();
    expect(deps.onUnavailable).not.toHaveBeenCalled();
  });

  it('dispose closes all retained notifications and clears refs', () => {
    const { rn, created } = setup();
    rn.deliver('a', 'x');
    rn.deliver('b', 'y');
    rn.dispose();
    expect(created.map((n) => n.closed)).toEqual([1, 1]);
    rn.dispose(); // second dispose is a no-op
    expect(created.map((n) => n.closed)).toEqual([1, 1]);
  });

  it('close event removes the retained reference', () => {
    const { rn, created } = setup();
    rn.deliver('t', 'b');
    const n = created[0];
    n.close();
    // dispose should not close it again beyond the explicit close
    rn.dispose();
    expect(n.closed).toBe(1);
  });

  it('callback errors in onShown do not crash', () => {
    const onShown = vi.fn(() => {
      throw new Error('callback boom');
    });
    const created: FakeNotification[] = [];
    const rn = new ReminderNotifications({
      supported: () => true,
      create: () => {
        const n = new FakeNotification();
        created.push(n);
        return n;
      },
      onUnavailable: vi.fn(),
      onShown,
    });
    rn.deliver('t', 'b');
    expect(() => created[0].emitShow()).not.toThrow();
  });

  it('does not report failure after disposed even on new deliver', () => {
    const { rn, deps } = setup(false);
    rn.dispose();
    rn.deliver('t', 'b');
    expect(deps.onUnavailable).not.toHaveBeenCalled();
  });
});
