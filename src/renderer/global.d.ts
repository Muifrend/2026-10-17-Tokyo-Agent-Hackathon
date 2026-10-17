/// <reference types="vite/client" />
import type { CoachBridge } from '../shared/types';

declare global {
  interface Window {
    coach: CoachBridge;
  }
}

export {};
