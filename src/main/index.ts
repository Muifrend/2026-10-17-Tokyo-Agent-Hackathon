import { app, BrowserWindow, ipcMain, powerMonitor, Notification } from 'electron';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import path, { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

import { Neo4jStore } from './repository';
import { AIClient } from './ai';
import { materializeGoals } from './goals';
import { materializeGoalGraph,backfillGoalGraph } from './goal-graph';
import { CaptureService } from './capture';
import { FocusController } from './focus';
import { ReminderNotifications } from './notifications';
import { PointsService } from './points';

import type {
  AppState,
  Conversation,
  Goal,
  Message,
  GoalDetail,
} from '../shared/types';

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const __dirname = dirname(fileURLToPath(import.meta.url));

const STATE_CHANNEL = 'coach:state';

const textSchema = z.string().trim().min(1).max(16000);
const uuidSchema = z.string().uuid();
const displayIdSchema = z.string().min(1).max(200);
const permissionKindSchema = z.enum(['screen', 'camera']);

function sanitizeError(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unexpected error';
  const trimmed = message.trim().slice(0, 180);
  return trimmed.length > 0 ? trimmed : 'Unexpected error';
}

function nowIso(): string {
  return new Date().toISOString();
}

class CoachApp {
  private store: Neo4jStore | null = null;
  private ai: AIClient | null = null;
  private capture: CaptureService;
  private focus: FocusController | null = null;
  private points: PointsService | null = null;

  private mainWindow: BrowserWindow | null = null;

  private conversations: Conversation[] = [];
  private goals: Goal[] = [];
  private goalDetails:GoalDetail[]=[];
  private messages: Message[] = [];

  private ready = false;
  private bootstrapping = false;
  private notice: string | null = null;
  private notificationNotice: string | null = null;
  private notifications = new ReminderNotifications({
    supported: () => Notification.isSupported(),
    create: (title, body) => new Notification({ title, body }),
    onUnavailable: () => {
      this.notificationNotice = 'Reminder saved. macOS notification delivery failed; check Notifications settings.';
      this.push();
    },
    onShown: () => { this.notificationNotice = null; this.push(); },
  });

  private turnInFlight = false;
  private inFlightRequestId: string | null = null;
  private inFlightPromise: Promise<void> | null = null;

  private focusActionBusy = false;
  private shutdownStarted = false;
  private shutdownComplete = false;

  constructor() {
    this.capture = new CaptureService(async (win: BrowserWindow) => {
      await this.loadPage(win, true);
    });
    this.capture.onLost = (reason: string) => {
      void Promise.resolve(this.focus?.pause(reason)).catch(() => {
        /* session loss handled by controller */
      });
    };
  }

  // --------------------------------------------------------------------- state

  private snapshot(): AppState {
    return {
      conversations: [...this.conversations],
      goals: [...this.goals],
      goalDetails:[...this.goalDetails],
      messages: [...this.messages],
      session: this.focus?.session ?? null,
      notice: this.notice ?? this.notificationNotice,
      ready: this.ready,
    };
  }

  private push(): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      try {
        this.mainWindow.webContents.send(STATE_CHANNEL, this.snapshot());
      } catch {
        /* window gone */
      }
    }
  }

  private setNotice(notice: string): void {
    this.notice = notice;
    this.push();
  }

  private applyLoaded(data: { conversations: Conversation[]; goals: Goal[]; messages: Message[];goalDetails:GoalDetail[] }): void {
    this.conversations = data.conversations;
    this.goals = data.goals;
    this.goalDetails=data.goalDetails;
    this.messages = data.messages;
  }

  private notify(title: string, body: string): void {
    this.notifications.deliver(String(title), String(body));
  }

  // ----------------------------------------------------------------- bootstrap

  async bootstrap(): Promise<void> {
    if (this.ready || this.bootstrapping) return;
    this.bootstrapping = true;
    try {
      // Dotenv from userData then cwd; quiet, never log values.
      try {
        dotenvConfig({ path: join(app.getPath('userData'), '.env'), quiet: true });
      } catch {
        /* missing file is fine */
      }
      try {
        dotenvConfig({ path: join(process.cwd(), '.env'), quiet: true });
      } catch {
        /* missing file is fine */
      }

      // A packaged app directory must never contain a .env file.
      if (app.isPackaged && existsSync(join(app.getAppPath(), '.env'))) {
        throw new Error('Packaged app directory must not contain a .env file');
      }

      // Clean up any failed previous attempt without touching ready state.
      if (!this.ready) {
        if (this.focus) {
          try {
            await this.focus.dispose();
          } catch {
            /* ignore */
          }
          this.focus = null;
        }
        if (this.store) {
          try {
            await this.store.close();
          } catch {
            /* ignore */
          }
          this.store = null;
        }
      }

      // Constructors validate required env (names only, never values).
      if (!this.points) {
        this.points = new PointsService({ env: process.env, statePath: join(app.getPath('userData'), 'points-outbox.json') });
        void this.points.init().catch(() => undefined);
      }
      this.store = new Neo4jStore(process.env);
      this.ai = new AIClient(process.env);

      await this.store.init();
      await this.ai.init();

      let data = await this.store.load();
      const migrated=backfillGoalGraph(data.goals,data.goalDetails);
      if(migrated.upserts.length){await this.store.saveGraph(migrated);data=await this.store.load();}
      this.applyLoaded(data);

      this.focus = new FocusController({
        store: this.store,
        capture: this.capture,
        ai: {verifyVision:()=>this.ai!.verifyVision(),analyze:(goal,frames,signal)=>this.ai!.analyze(goal,frames,signal,this.goalDetails)},
        getGoal: (goalId: string) => this.goals.find((g) => g.id === goalId),
        notify: (title: string, body: string) => this.notify(title, body),
        onChange: () => { this.points?.setSession(this.focus?.session ?? null); this.push(); },
        onObservation: observation => this.points?.recordObservation(observation),
        onReminder: (message: Message) => {
          this.messages.push(message);
          this.push();
        },
        onNotice: (text: string | null) => {
          if (text) this.points?.invalidateCheck();
          this.notice = text;
          this.push();
        },
      });

      this.ready = true;
      this.notice = null;
      this.push();
    } catch (error) {
      // Short setup error: names, not values; no stacks to the renderer.
      this.notice = sanitizeError(error);
      this.push();
    } finally {
      this.bootstrapping = false;
    }
  }

  async retry(): Promise<void> {
    if (this.ready) {
      // Already ready: attempt a data reload. Keep the current (paused) session;
      // do NOT resume monitoring automatically.
      try {
        await this.ai!.init();
        if (this.focus?.session) await this.store!.saveSession(this.focus.session);
        const data = await this.store!.load();
        this.applyLoaded(data);
        this.notice = null;
        this.push();
      } catch (error) {
        this.setNotice(sanitizeError(error));
      }
      return;
    }
    if (this.bootstrapping) return; // avoid dropping busy changes
    await this.bootstrap();
  }

  // -------------------------------------------------------------------- window

  private async loadPage(win: BrowserWindow, capture: boolean): Promise<void> {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      const url = new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
      if (capture) url.searchParams.set('capture', '1');
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
        capture ? { query: { capture: '1' } } : undefined);
    }
  }

  private isAllowedUrl(url: string): boolean {
    return false; // No renderer-initiated navigation, including local files.
  }

  private hardenWebContents(contents: Electron.WebContents): void {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      if (!this.isAllowedUrl(url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  }

  async createMainWindow(): Promise<void> {
    const backgroundColor =
      process.platform === 'darwin' ? '#00000000' : process.platform === 'win32' ? '#202124' : '#2b2b2b';

    this.mainWindow = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 760,
      minHeight: 560,
      title: 'Goal Coach',
      titleBarStyle: 'hiddenInset',
      backgroundColor,
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });

    this.hardenWebContents(this.mainWindow.webContents);

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    this.mainWindow.on('close', (event) => {
      if (this.shutdownComplete) return;
      event.preventDefault();
      if (this.shutdownStarted) return;
      this.shutdownStarted = true;
      void this.shutdown()
        .catch(() => undefined)
        .then(() => {
          this.shutdownComplete = true;
          if (this.mainWindow && !this.mainWindow.isDestroyed()) this.mainWindow.destroy();
          app.quit(); // guarded; before-quit sees shutdownStarted
        });
    });

    await this.loadPage(this.mainWindow, false);
  }

  private async shutdown(): Promise<void> {
    if (this.shutdownStarted && this.shutdownComplete) return;
    this.notifications.dispose();
    // Guarantee capture tracks stop before quit: synchronous intercept + async cleanup.
    try {      await this.capture.stop();
    } catch {
      /* ignore */
    }
    try {
      await this.focus?.dispose();
    } catch {
      /* ignore */
    }
    this.focus = null;
    await this.points?.close().catch(() => undefined);
    this.points = null;
    try {
      await this.capture.dispose();
    } catch {
      /* ignore */
    }
    try {
      await this.store?.close();
    } catch {
      /* ignore */
    }
    this.store = null;
    this.ai = null;
  }

  // ----------------------------------------------------------------------- ipc

  private handle<T>(
    channel: string,
    schema: z.ZodType<T> | null,
    handler: (payload: T, event: Electron.IpcMainInvokeEvent) => Promise<unknown> | unknown,
  ): void {
    ipcMain.handle(channel, async (event, payload: unknown) => {
      // Only the exact main window may call; capture/external senders are rejected.
      if (!this.mainWindow || this.mainWindow.isDestroyed() || event.sender !== this.mainWindow.webContents) {
        throw new Error('Unauthorized sender');
      }
      let parsed = payload as T;
      if (schema) {
        const result = schema.safeParse(payload);
        if (!result.success) throw new Error('Invalid request');
        parsed = result.data;
      }
      try {
        return await handler(parsed, event);
      } catch (error) {
        throw new Error(sanitizeError(error));
      }
    });
  }

  registerIpc(): void {
    this.handle('coach:get-friends', null, async () => this.points
      ? this.points.leaderboard()
      : { status: 'setup', rows: [], playerName: '', message: 'Friends needs the shared points service.' });
    // Available always, never throws for bootstrap state.
    this.handle(
      'coach:get-state',
      null,
      () => this.snapshot(),
    );

    this.handle('coach:new-brainstorm', null, async () => {
      if (!this.ready || !this.store) throw new Error('Not ready');
      const id = randomUUID();
      const conversation: Conversation = {
        id,
        title: 'New chat',
        kind: 'brainstorm',
        goalId: null,
        createdAt: nowIso(),
      };
      await this.store.createConversation(conversation);
      this.conversations.push(conversation);
      this.push();
      return id;
    });

    this.handle(
      'coach:send-message',
      z.object({
        conversationId: uuidSchema,
        content: textSchema,
        requestId: uuidSchema,
      }),
      async ({ conversationId, content, requestId }) => {
        await this.sendMessage(conversationId, content, requestId);
        return null;
      },
    );

    this.handle('coach:set-chat-goal',z.object({conversationId:uuidSchema,goalId:uuidSchema.nullable()}),async({conversationId,goalId})=>{
      if(!this.ready||!this.store)throw new Error('Not ready');
      if(this.turnInFlight)throw new Error('Wait for the current reply.');
      const chat=this.conversations.find(c=>c.id===conversationId);
      if(!chat||chat.kind!=='brainstorm')throw new Error('Select a brainstorm chat');
      if(goalId&&!this.goals.some(g=>g.id===goalId))throw new Error('Goal not found');
      await this.store.setChatGoal(conversationId,goalId);chat.goalId=goalId;this.push();
    });

    this.handle(
      'coach:select-goal',
      z.object({
        goalId: uuidSchema,
        displayId: displayIdSchema.optional(),
      }),
      async ({ goalId, displayId }) => this.selectGoal(goalId, displayId),
    );

    this.handle(
      'coach:resume',
      z.object({ displayId: displayIdSchema.optional() }),
      async ({ displayId }) => {
        if (!this.ready) throw new Error('Not ready');
        if (!this.focus) throw new Error('Not ready');
        let target = displayId ?? this.focus.session?.displayId ?? undefined;
        if (target) {
          const displays = await this.capture.listDisplays();
          if (!displays.some((d) => d.id === target)) throw new Error('Select a display');
        }
        await this.focusAction(() => this.focus!.resume(target));
        this.push();
        return null;
      },
    );

    this.handle('coach:pause', null, async () => {
      if (!this.focus) throw new Error('No active session');
      try {
        await this.focus.pause();
      } catch (error) {
        this.setNotice(sanitizeError(error));
        throw error;
      }
      this.push();
      return null;
    });

    this.handle('coach:stop', null, async () => {
      if (!this.focus) throw new Error('No active session');
      try {
        await this.focus.stop();
      } catch (error) {
        this.setNotice(sanitizeError(error));
        throw error;
      }
      this.push();
      return null;
    });

    this.handle('coach:list-displays', null, async () => {
      if (!this.ready) throw new Error('Not ready');
      // May trigger the native screen permission prompt.
      return await this.capture.listDisplays();
    });

    this.handle('coach:retry', null, async () => {
      await this.retry();
      return null;
    });

    this.handle(
      'coach:open-permissions',
      permissionKindSchema,
      async (kind) => {
        await this.capture.openPermissions(kind);
        return null;
      },
    );
  }

  // -------------------------------------------------------------- send-message

  private async sendMessage(conversationId: string, content: string, requestId: string): Promise<void> {
    if (!this.ready || !this.store || !this.ai) throw new Error('Not ready');

    const userMessageId = `${requestId}:u`;

    // One global in-flight turn lock with idempotent retry.
    if (this.turnInFlight) {
      if (this.inFlightRequestId === requestId && this.inFlightPromise) {
        await this.inFlightPromise;
        return;
      }
      throw new Error('Another message is still being answered. Try again shortly.');
    }
    if (this.messages.some((m) => m.id === userMessageId)) {
      return; // already committed
    }

    const conversation = this.conversations.find((c) => c.id === conversationId);
    if (!conversation) throw new Error('Conversation not found');

    this.turnInFlight = true;
    this.inFlightRequestId = requestId;
    // Editing the focused goal while monitoring: pause first.
    if (
      conversation.goalId &&
      this.focus?.session &&
      this.focus.session.goalId === conversation.goalId &&
      this.focus.session.status === 'active'
    ) {
      try {
        await this.focus.pause('Paused to refine goal');
      } catch {
        /* notice surfaced via onChange/onNotice */
      }
    }

    const userMessage: Message = {
      id: userMessageId,
      conversationId,
      role: 'user',
      content,
      createdAt: nowIso(),
    };


    const run = (async () => {
      try {
        const prior = this.messages
          .filter((m) => m.conversationId === conversationId && (!conversation.goalId || !conversation.goalContextStartedAt || m.createdAt>=conversation.goalContextStartedAt))
          .slice()
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        prior.push(userMessage);

        const scopeGoal = conversation.goalId
          ? this.goals.find((g) => g.id === conversation.goalId)
          : undefined;

        const result = await this.ai!.interview(prior, this.goals, scopeGoal,undefined,this.goalDetails);

        // Never generate goals locally without AI: only from the interview result.
        const scopedDrafts=scopeGoal?result.goals.filter(d=>d.id===scopeGoal.id):result.goals;
        const updatedGoals = materializeGoals(
          scopedDrafts,
          this.goals,
          conversationId,
          scopeGoal,
        );
        for (const goal of updatedGoals) {
          if (!goal.conversationId) goal.conversationId = conversationId;
        }

        const goalsAfter=[...this.goals.filter(g=>!updatedGoals.some(u=>u.id===g.id)),...updatedGoals];
        const graphChanges=materializeGoalGraph(scopedDrafts,goalsAfter,this.goalDetails,userMessage.id,this.goals);
        const userTs = Date.parse(userMessage.createdAt);
        const assistantMessage: Message = {
          id: `${requestId}:a`,
          conversationId,
          role: 'assistant',
          content: result.reply,
          createdAt: new Date(Math.max(Date.now(), Number.isNaN(userTs) ? 0 : userTs)).toISOString(),
        };

        await this.store!.saveTurn(
          conversationId,
          userMessage,
          assistantMessage,
          updatedGoals,
          result.title,
          graphChanges,
        );

        // Committed. Cache merge first so state is consistent even if reload fails.
        this.messages.push(userMessage, assistantMessage);
        const changedDetails=new Set([...graphChanges.removeIds,...graphChanges.upserts.map(d=>d.id)]);
        this.goalDetails=[...this.goalDetails.filter(d=>!changedDetails.has(d.id)),...graphChanges.upserts];
        this.notice = null;
        if (result.title) conversation.title = result.title;
        for (const goal of updatedGoals) {
          const index = this.goals.findIndex((g) => g.id === goal.id);
          if (index >= 0) this.goals[index] = goal;
          else this.goals.push(goal);
          if (!this.conversations.some(c => c.id === goal.conversationId)) this.conversations.push({id:goal.conversationId,title:goal.title,kind:'goal',goalId:goal.id,createdAt:goal.createdAt});
        }

        try {
          const data = await this.store!.load();
          this.applyLoaded(data);
        } catch {
          // Keep the committed turn state consistent in-memory; do not claim the user message was lost.
          this.setNotice('Reload failed but message committed');
        }
        this.push();
      } catch (error) {
        // No invented assistant reply; leave clear error notice, release lock in finally.
        this.setNotice(sanitizeError(error));
        throw error;
      } finally {
        this.turnInFlight = false;
        this.inFlightRequestId = null;
        this.inFlightPromise = null;
      }
    })();

    this.turnInFlight = true;
    this.inFlightRequestId = requestId;
    this.inFlightPromise = run;
    await run;
  }

  // ---------------------------------------------------------------- select-goal

  private async focusAction<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.focusActionBusy)throw new Error('Focus is starting. Try again shortly.');
    this.focusActionBusy=true;
    try{return await operation();}finally{this.focusActionBusy=false;}
  }
  private async selectGoal(goalId:string,displayId?:string):Promise<string> {
    return this.focusAction(()=>this.selectGoalNow(goalId,displayId));
  }
  private async selectGoalNow(goalId: string, displayId?: string): Promise<string> {
    if (!this.ready) throw new Error('Not ready');
    const goal = this.goals.find((g) => g.id === goalId);
    if (!goal) throw new Error('Goal not found');

    const session = this.focus?.session ?? null;
    if (
      session &&
      session.goalId === goalId &&
      (session.status === 'active' || session.status === 'paused')
    ) {
      // Already focused on this goal: just navigate.
      return goal.conversationId;
    }


    if (!goal.ready) {
      await this.focus?.stop();
      // Incomplete goal: UI collects missing criteria via goal chat.
      this.push();
      return goal.conversationId;
    }

    let target = displayId;
    if (target) {
      if (!displayIdSchema.safeParse(target).success) throw new Error('Invalid display');
    }
    if (!target) {
      const displays = await this.capture.listDisplays();
      if (displays.length === 0) throw new Error('Select a display');
      if (displays.length === 1) target = displays[0].id;
      else throw new Error('Select a display');
    }

    try {
      await this.focus!.start(goal, target);
    } catch (error) {
      // Permission/AI failure leaves the session paused; goal chat still opens.
      this.setNotice(sanitizeError(error));
    }
    this.push();
    return goal.conversationId;
  }
}

// ----------------------------------------------------------------------- entry

const coach = new CoachApp();

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      event.preventDefault();
    });
  });

  app.whenReady().then(async () => {
    coach.registerIpc();

    powerMonitor.on('suspend', () => {
      void Promise.resolve(coach['focus']?.pause('System suspended')).catch(() => undefined);
    });
    powerMonitor.on('lock-screen', () => {
      void Promise.resolve(coach['focus']?.pause('Screen locked')).catch(() => undefined);
    });

    try {
      await coach.createMainWindow();
    } catch (error) {
      // State remains available; surface concise notice via bootstrap.
      console.error('Window failed to load');
    }

    // Async bootstrap after window load; startup state is available even on config error.
    void coach.bootstrap();
  });

  app.on('window-all-closed', () => {
    // Quit on all platforms including macOS.
    app.quit();
  });

  app.on('before-quit', (event) => {
    // Robust quit path (e.g. Cmd+Q): guarantee async cleanup before exit.
    if (!coach['shutdownComplete']) {
      event.preventDefault();
      if (coach['shutdownStarted']) return;
      coach['shutdownStarted'] = true;
      void coach['shutdown']()
        .catch(() => undefined)
        .then(() => {
          coach['shutdownComplete'] = true;
          app.quit();
        });
    }
  });

  process.on('unhandledRejection', () => { void coach['focus']?.pause('Unexpected error. Resume to retry.'); });
}
