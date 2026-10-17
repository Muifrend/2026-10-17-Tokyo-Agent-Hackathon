export interface CaptureBridge {
  onCommand(cb: (type: 'start' | 'stop' | 'frame', token: string) => void): void;
  ready(token: string, error?: string): void;
  frame(token: string, image?: string, error?: string): void;
  lost(reason: string): void;
}

declare global {
  interface Window {
    captureBridge: CaptureBridge;
  }
}

export {};
