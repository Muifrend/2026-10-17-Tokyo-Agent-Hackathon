import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, CoachBridge } from './shared/types';

const STATE_CHANNEL = 'coach:state';

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> =>
  ipcRenderer.invoke(channel, ...args);

const coach: CoachBridge = {
  getFriends: () => invoke('coach:get-friends') as ReturnType<CoachBridge['getFriends']>,
  setChatGoal: (conversationId,goalId) => invoke('coach:set-chat-goal',{conversationId,goalId}) as Promise<void>,
  getState: () => invoke('coach:get-state') as Promise<AppState>,
  newBrainstorm: () => invoke('coach:new-brainstorm') as Promise<string>,
  sendMessage: (conversationId, content, requestId) =>
    invoke('coach:send-message', { conversationId, content, requestId }) as Promise<void>,
  selectGoal: (goalId, displayId) =>
    invoke('coach:select-goal', { goalId, displayId }) as Promise<string>,
  resume: (displayId) => invoke('coach:resume', { displayId }) as Promise<void>,
  pause: () => invoke('coach:pause') as Promise<void>,
  stop: () => invoke('coach:stop') as Promise<void>,
  listDisplays: () => invoke('coach:list-displays') as ReturnType<CoachBridge['listDisplays']>,
  retry: () => invoke('coach:retry') as Promise<void>,
  openPermissions: (kind) => invoke('coach:open-permissions', kind) as Promise<void>,
  onState: (listener) => {
    const handler = (_event: unknown, state: AppState): void => listener(state);
    ipcRenderer.on(STATE_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(STATE_CHANNEL, handler);
    };
  }
};

contextBridge.exposeInMainWorld('coach', coach);
