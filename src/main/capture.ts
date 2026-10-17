import { BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences, type IpcMainEvent } from 'electron';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DisplaySource, Frames } from '../shared/types';

export class CaptureService {
  onLost: (reason: string) => void = () => {};
  private hidden: BrowserWindow | null = null;
  private displayId: string | null = null;
  private token: string | null = null;
  private generation = 0;
  private pendingReady: {resolve:()=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}|null=null;
  private pendingFrame: {resolve:(s:string)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}|null=null;
  constructor(private loadWindow:(win:BrowserWindow)=>Promise<void>) {
    ipcMain.on('capture:ready', this.ready);
    ipcMain.on('capture:frame-result', this.frame);
    ipcMain.on('capture:lost', this.lost);
  }
  private authentic(event:IpcMainEvent, token?:unknown) {
    return !!this.hidden && !this.hidden.isDestroyed() && event.sender === this.hidden.webContents && (!token || token === this.token);
  }
  private ready = (event:IpcMainEvent, token:string, error?:string) => {
    if (!this.authentic(event,token) || !this.pendingReady) return;
    const pending=this.pendingReady;this.pendingReady=null;clearTimeout(pending.timer);
    if(error) pending.reject(new Error('Camera unavailable. Check camera permission.')); else pending.resolve();
  };
  private frame = (event:IpcMainEvent, token:string,image?:string,error?:string) => {
    if(!this.authentic(event,token)||!this.pendingFrame)return;
    const pending=this.pendingFrame;this.pendingFrame=null;clearTimeout(pending.timer);
    if(error||typeof image!=='string'||!image.startsWith('data:image/jpeg;base64,')||image.length>3_000_000) pending.reject(new Error('Camera frame unavailable.'));
    else pending.resolve(image);
  };
  private lost = (event:IpcMainEvent) => {if(this.authentic(event)&&this.token)this.onLost('Camera disconnected. Resume to retry.');};
  async listDisplays():Promise<DisplaySource[]> {
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:320,height:180}});
    return sources.map(s=>({id:s.id,name:s.name,thumbnail:s.thumbnail.toDataURL()}));
  }
  async start(displayId:string):Promise<void> {
    await this.stop();
    const generation=++this.generation;
    const check=()=>{if(generation!==this.generation)throw new Error('Capture canceled.');};
    const sources=await this.listDisplays();check();
    if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')!=='granted')throw new Error('Allow Screen Recording in System Settings, then restart the app.');
    if(!sources.some(s=>s.id===displayId))throw new Error('Display disconnected. Select a display again.');
    if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('camera')!=='granted') {
      const granted=await systemPreferences.askForMediaAccess('camera');check();
      if(!granted)throw new Error('Allow camera access in System Settings.');
    }
    check();
    const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,sandbox:true,contextIsolation:true,backgroundThrottling:false,preload:path.join(path.dirname(fileURLToPath(import.meta.url)),'capture-preload.cjs')}});
    this.hidden=win;this.displayId=displayId;this.token=randomUUID();
    session.defaultSession.setPermissionRequestHandler((wc,permission,callback,details)=>callback(wc===this.hidden?.webContents&&permission==='media'&&'mediaTypes' in details&&!!details.mediaTypes?.length&&details.mediaTypes.every(t=>t==='video')));
    session.defaultSession.setPermissionCheckHandler((wc,permission,_origin,details)=>wc===this.hidden?.webContents&&permission==='media'&&details.mediaType==='video');
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',event=>event.preventDefault());
    win.webContents.on('render-process-gone',()=>{if(this.hidden===win&&this.token)this.onLost('Camera process stopped. Resume to retry.');});
    win.on('closed',()=>{if(this.hidden===win&&this.token)this.onLost('Camera disconnected. Resume to retry.');});
    try {
      await this.loadWindow(win);check();
      await new Promise<void>((resolve,reject)=>{
        const timer=setTimeout(()=>{this.pendingReady=null;reject(new Error('Camera did not start. Resume to retry.'));},15000);
        this.pendingReady={resolve,reject,timer};
        win.webContents.send('capture:command',{type:'start',token:this.token});
      });check();
    }catch(error){if(generation===this.generation)await this.stop();throw error;}
  }
  async frames():Promise<Frames> {
    const generation=this.generation;
    if(!this.hidden||!this.token||!this.displayId)throw new Error('Capture stopped.');
    if(process.platform==='darwin'&&systemPreferences.getMediaAccessStatus('screen')!=='granted')throw new Error('Screen permission lost.');
    const sources=await desktopCapturer.getSources({types:['screen'],thumbnailSize:{width:1280,height:1280}});
    if(generation!==this.generation)throw new Error('Capture stopped.');
    const source=sources.find(s=>s.id===this.displayId);
    if(!source||source.thumbnail.isEmpty())throw new Error('Display unavailable.');
    const size=source.thumbnail.getSize();
    const resized=source.thumbnail.resize(size.width>=size.height?{width:1280}:{height:1280});
    const screen='data:image/jpeg;base64,'+resized.toJPEG(75).toString('base64');
    const camera=await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pendingFrame=null;reject(new Error('Camera frame timed out.'));},10000);
      this.pendingFrame={resolve,reject,timer};
      this.hidden!.webContents.send('capture:command',{type:'frame',token:this.token});
    });
    if(generation!==this.generation)throw new Error('Capture stopped.');
    return {screen,camera};
  }
  async stop():Promise<void> {
    ++this.generation;this.token=null;this.displayId=null;
    if(this.pendingReady){clearTimeout(this.pendingReady.timer);this.pendingReady.reject(new Error('Capture stopped.'));this.pendingReady=null;}
    if(this.pendingFrame){clearTimeout(this.pendingFrame.timer);this.pendingFrame.reject(new Error('Capture stopped.'));this.pendingFrame=null;}
    const win=this.hidden;this.hidden=null;
    if(win&&!win.isDestroyed())win.destroy(); // Destruction releases camera tracks even if the renderer cannot acknowledge stop.
  }
  async openPermissions(kind:'screen'|'camera') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?'+(kind==='screen'?'Privacy_ScreenCapture':'Privacy_Camera'));
  }
  async dispose(){await this.stop();ipcMain.removeListener('capture:ready',this.ready);ipcMain.removeListener('capture:frame-result',this.frame);ipcMain.removeListener('capture:lost',this.lost);}
}
