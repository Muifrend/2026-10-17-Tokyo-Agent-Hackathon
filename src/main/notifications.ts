export interface NativeNotificationLike {
  once(event: 'failed' | 'close' | 'show', callback: () => void): unknown;
  show(): void;
  close(): void;
}

export interface ReminderNotificationsDeps {
  supported: () => boolean;
  create: (title: string, body: string) => NativeNotificationLike;
  onUnavailable: () => void;
  onShown: () => void;
}

export class ReminderNotifications {
  private readonly deps: ReminderNotificationsDeps;
  private readonly retained = new Set<NativeNotificationLike>();
  private disposed = false;

  constructor(deps: ReminderNotificationsDeps) {
    this.deps = deps;
  }

  deliver(title: string, body: string): void {
    if (this.disposed) return;

    let supported: boolean;
    try {
      supported = this.deps.supported();
    } catch {
      this.reportUnavailable();
      return;
    }

    if (!supported) {
      this.reportUnavailable();
      return;
    }

    let notification: NativeNotificationLike;
    try {
      notification = this.deps.create(title, body);
    } catch {
      this.reportUnavailable();
      return;
    }

    const removeRef = (): void => {
      this.retained.delete(notification);
    };

    const onFailed = (): void => {
      if (this.disposed) return;
      removeRef();
      this.reportUnavailable();
    };

    const onShown = (): void => {
      if (this.disposed) return;
      try {
        this.deps.onShown();
      } catch {
        // callback errors must not crash
      }
    };

    const onClose = (): void => {
      removeRef();
    };

    try {
      notification.once('failed', onFailed);
      notification.once('show', onShown);
      notification.once('close', onClose);
    } catch {
      this.reportUnavailable();
      return;
    }

    this.retained.add(notification);

    try {
      notification.show();
    } catch {
      removeRef();
      this.reportUnavailable();
    }
    // Intentionally never treat .show() return value as success.
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const notification of this.retained) {
      try {
        notification.close();
      } catch {
        // ignore close errors during disposal
      }
    }
    this.retained.clear();
  }

  private reportUnavailable(): void {
    if (this.disposed) return;
    try {
      this.deps.onUnavailable();
    } catch {
      // callback errors must not crash
    }
  }
}
