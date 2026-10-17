import { contextBridge, ipcRenderer } from 'electron';

type CommandHandler = (type: 'start' | 'stop' | 'frame', token: string) => void;

let handler: CommandHandler | null = null;
let queued: {type: "start"|"stop"|"frame";token:string}|null=null;

ipcRenderer.on('capture:command', (_event, payload: { type: 'start' | 'stop' | 'frame'; token: string }) => {
  if (!handler) { queued=payload; return; }
  if (handler && payload && typeof payload.type === 'string' && typeof payload.token === 'string') {
    handler(payload.type, payload.token);
  }
});

contextBridge.exposeInMainWorld('captureBridge', {
  onCommand(cb: CommandHandler): void {
    handler = cb;
    if(queued){const command=queued;queued=null;cb(command.type,command.token);}
  },
  ready(token: string, error?: string): void {
    ipcRenderer.send('capture:ready', token, error);
  },
  frame(token: string, image?: string, error?: string): void {
    ipcRenderer.send('capture:frame-result', token, image, error);
  },
  lost(reason: string): void {
    ipcRenderer.send('capture:lost', reason);
  },
});
