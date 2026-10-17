export interface Goal {
  id: string;
  title: string;
  outcome: string;
  onTrack: string[];
  offTrack: string[];
  ready: boolean;
  sourceConversationId: string;
  conversationId: string;
  createdAt: string;
  updatedAt: string;
}

export type GoalDetailKind = 'subgoal'|'action'|'motivation'|'obstacle'|'success_criterion'|'distraction';
export interface GoalDetailDraft { key:string;kind:GoalDetailKind;text:string;parentKey:string|null; }
export interface GoalDetail {id:string;goalId:string;kind:GoalDetailKind;text:string;parentId:string|null;sourceMessageId:string|null;createdAt:string;updatedAt:string;}
export interface GraphChanges {upserts:GoalDetail[];removeIds:string[];}
export interface GoalDraft {
  details?:GoalDetailDraft[];
  removeDetailIds?:string[];
  id: string | null;
  title: string;
  outcome: string;
  onTrack: string[];
  offTrack: string[];
}

export interface Conversation {
  goalContextStartedAt?:string|null;
  id: string;
  title: string;
  kind: 'brainstorm' | 'goal';
  goalId: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'reminder';
  content: string;
  createdAt: string;
}

export interface FocusSession {
  id: string;
  goalId: string;
  status: 'active' | 'paused' | 'ended' | 'interrupted';
  startedAt: string;
  endedAt: string | null;
  pauseReason: string | null;
  displayId: string | null;
}

export interface Analysis {
  verdict: 'on_track' | 'off_track' | 'uncertain';
  confidence: number;
  reason: string;
  reminderText: string;
}

export interface Observation extends Analysis {
  id: string;
  sessionId: string;
  createdAt: string;
}

export interface AppState {
  conversations: Conversation[];
  goalDetails: GoalDetail[];
  goals: Goal[];
  messages: Message[];
  session: FocusSession | null;
  notice: string | null;
  ready: boolean;
}

export interface DisplaySource {
  id: string;
  name: string;
  thumbnail: string;
}

export interface Frames {
  screen: string;
  camera: string;
}

export interface InterviewResult {
  reply: string;
  title: string;
  goals: GoalDraft[];
}

export interface CoachBridge {
  getState(): Promise<AppState>;
  newBrainstorm(): Promise<string>;
  sendMessage(conversationId: string, content: string, requestId: string): Promise<void>;
  setChatGoal(conversationId:string,goalId:string|null):Promise<void>;
  selectGoal(goalId: string, displayId?: string): Promise<string>;
  resume(displayId?: string): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  listDisplays(): Promise<DisplaySource[]>;
  retry(): Promise<void>;
  openPermissions(kind: 'screen' | 'camera'): Promise<void>;
  onState(listener: (state: AppState) => void): () => void;
}
