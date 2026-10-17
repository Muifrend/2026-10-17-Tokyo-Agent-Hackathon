import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => void>(),
  getSources: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: class {},
  desktopCapturer: { getSources: electron.getSources },
  ipcMain: {
    on: (name: string, fn: (...args: any[]) => void) => electron.handlers.set(name, fn),
    removeListener: (name: string) => electron.handlers.delete(name),
  },
  session: { defaultSession: {} },
  shell: {},
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
}));
import { CaptureService } from '../src/main/capture';

function activeCapture(reply = true) {
  const service = new CaptureService(async () => {});
  const images: string[] = [];
  const webContents = {
    send: vi.fn((_channel, command) => {
      if (!reply) return;
      const image = 'data:image/jpeg;base64,' + Buffer.from(`frame-${images.length + 1}`).toString('base64');
      images.push(image);
      electron.handlers.get('capture:frame-result')!({ sender: webContents }, command.token, image);
    }),
  };
  let destroyed = false;
  const hidden = { webContents, isDestroyed: () => destroyed, destroy: vi.fn(() => { destroyed = true; }) };
  Object.assign(service, { hidden, token: 'capture-token', displayId: 'screen:1', generation: 1 });
  const thumbnail = {
    isEmpty: () => false,
    getSize: () => ({ width: 1280, height: 720 }),
    resize: () => ({ toJPEG: () => Buffer.from('screen') }),
  };
  electron.getSources.mockResolvedValue([{ id: 'screen:1', thumbnail }]);
  return { service, images, hidden, webContents };
}

describe('single webcam frame capture', () => {
  beforeEach(() => { vi.useFakeTimers(); electron.getSources.mockReset(); electron.handlers.clear(); });
  afterEach(() => { vi.useRealTimers(); });

  it('captures one screenshot and exactly one webcam still', async () => {
    const { service, images, webContents } = activeCapture();
    const frames = await service.frames();
    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(frames.camera).toBe(images[0]);
    expect(frames).not.toHaveProperty('cameraFrames');
    expect(electron.getSources).toHaveBeenCalledTimes(1);
    await service.dispose();
  });

  it('stop rejects a pending camera request immediately and clears its timeout', async () => {
    const { service, hidden, webContents } = activeCapture(false);
    const pending = service.frames();
    const rejected = expect(pending).rejects.toThrow('Capture stopped');
    await vi.advanceTimersByTimeAsync(0);
    await service.stop();
    await rejected;
    expect(hidden.destroy).toHaveBeenCalledTimes(1);
    expect(webContents.send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await service.dispose();
  });
});
