import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Conversation, Goal, DisplaySource } from '../shared/types';
import Sidebar from './Sidebar';
import GoalGraph from './GoalGraph';
import GoalSetup from './GoalSetup';
import Friends from './Friends';
import './sidebar.css';
import './friends.css';

const bridge = window.coach;


function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p: Record<string, React.ReactNode> = {
    close: <path d="M4 4l8 8M12 4l-8 8" />,
    plus: <path d="M8 3v10M3 8h10" />,
    send: <path d="M8 13V3M4 7l4-4 4 4" />,
    pause: <><rect x="4" y="3" width="3.4" height="10" /><rect x="8.6" y="3" width="3.4" height="10" /></>,
    play: <path d="M4 3l9 5-9 5z" />,
    stop: <rect x="4" y="4" width="8" height="8" />,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill={name === 'play' || name === 'stop' ? 'currentColor' : 'none'} stroke={name === 'play' || name === 'stop' ? 'none' : 'currentColor'} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name]}</svg>
  );
}

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [graphGoalId,setGraphGoalId]=useState<string|null>(null);
  const [goalMenu,setGoalMenu]=useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const currentChat=useRef<string|null>(null);
  const creatingChat=useRef<Promise<string>|null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displays, setDisplays] = useState<DisplaySource[] | null>(null);
  const [pendingGoal, setPendingGoal] = useState<Goal | null>(null);
  const [busy, setBusy] = useState(false);
  const [chosenDisplay, setChosenDisplay] = useState<string>('');
  const retryRequest = useRef<{id:string,text:string,conversationId:string}|null>(null);
  const requestFor=(text:string,conversationId:string)=>{if(retryRequest.current?.text!==text||retryRequest.current.conversationId!==conversationId)retryRequest.current={id:crypto.randomUUID(),text,conversationId};return retryRequest.current.id;};
  const [resumeMode, setResumeMode] = useState(false);
  const [setupGoalId, setSetupGoalId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const ready = state?.ready ?? false;

  useEffect(() => {
    let on = true;
    bridge.getState().then(s => { if (on) setState(s); });
    const un = bridge.onState(s => setState(s));
    return () => { on = false; un(); };
  }, []);

  const session = state?.session ?? null;
  const activeGoal = session && (session.status === 'active' || session.status === 'paused') ? state?.goals.find(g => g.id === session.goalId) ?? null : null;

  const convs = (state?.conversations ?? []).filter(c => c.kind === 'brainstorm');
  const graphGoal=state?.goals.find(g=>g.id===graphGoalId)??null;
  const selected: Conversation | null =
    state?.conversations.find(c => c.id === selectedId) ?? null;
  const messages = selected ? (state?.messages ?? []).filter(m => m.conversationId === selected.id && m.role !== 'reminder') : [];
  const goal = selected?.goalId ? state?.goals.find(g => g.id === selected.goalId) ?? null : null;

  const setupGoal = setupGoalId ? state?.goals.find(g => g.id === setupGoalId) ?? null : null;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const navigate = useCallback((id:string)=>{
    currentChat.current=id;setSelectedId(id);setGraphGoalId(null);setDraft('');setError(null);setGoalMenu(false);setFriendsOpen(false);
  },[]);
  const newChat=()=>{currentChat.current=null;setSelectedId(null);setGraphGoalId(null);setDraft('');setError(null);setGoalMenu(false);retryRequest.current=null;setFriendsOpen(false);};
  const ensureChat=async()=>{
    if(currentChat.current)return currentChat.current;
    if(creatingChat.current)return creatingChat.current;
    const promise=bridge.newBrainstorm().then(id=>{currentChat.current=id;setSelectedId(id);return id;});
    creatingChat.current=promise;
    try{return await promise;}finally{creatingChat.current=null;}
  };
  const attachGoal=async(goalId:string|null)=>{
    setBusy(true);setError(null);
    try{const id=await ensureChat();await bridge.setChatGoal(id,goalId);setGoalMenu(false);}
    catch{setError('Could not update goal context.');}finally{setBusy(false);}
  };
  const openGraph=(id:string)=>{setGraphGoalId(id);setGoalMenu(false);setError(null);setFriendsOpen(false);};

  const send=async()=>{
    const text=draft.trim();if(!text||sending||busy||!ready)return;
    setSending(true);setError(null);setPending(text);setDraft('');
    try{const id=await ensureChat();await bridge.sendMessage(id,text,requestFor(text,id));retryRequest.current=null;}
    catch{setError('Message failed to send.');setDraft(text);}
    finally{setPending(null);setSending(false);}
  };

  const prepareGoal = async (g: Goal) => {
    try {
      const screens=await bridge.listDisplays();
      if(!screens.length)throw new Error('No displays available. Check screen permission.');
      setDisplays(screens);setChosenDisplay(screens[0].id);setPendingGoal(g);
    } catch { setError('Screen unavailable. Check Screen Recording permission.'); }
  };

  const onGoalClick = async (g: Goal) => {
    setFriendsOpen(false);
    if (session && session.goalId === g.id && (session.status === 'active' || session.status === 'paused')) {
      openGraph(g.id);
      return;
    }
    if (!g.ready) {
      try {
        await bridge.selectGoal(g.id);
        openGraph(g.id);
        setSetupGoalId(g.id);
      }
      catch { setError('Could not open goal.'); }
      return;
    }
    await prepareGoal(g);
  };

  const confirmGoal = async () => {
    if (!pendingGoal) return;
    setBusy(true);
    try {
      const displayId = chosenDisplay || displays?.[0]?.id;
      await bridge.selectGoal(pendingGoal.id, displayId);
      openGraph(pendingGoal.id);
      setPendingGoal(null); setDisplays(null);

    } catch { setError('Could not start session.'); }
    finally { setBusy(false); }
  };

  const onResume = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const screens=await bridge.listDisplays();
      if(!screens.length) throw new Error('No displays');
      setResumeMode(true);setDisplays(screens);setChosenDisplay(screens.find(d=>d.id===session.displayId)?.id??screens[0].id);
    } catch { setError('Screen unavailable. Check Screen Recording permission.'); }
    finally { setBusy(false); }
  };

  const confirmResume = async () => {
    setBusy(true);
    try {
      const displayId = chosenDisplay || displays?.[0]?.id;
      await bridge.resume(displayId);
      setDisplays(null); setResumeMode(false);
    } catch { setError('Could not resume.'); }
    finally { setBusy(false); }
  };

  if (!state) return null;

  const showQuestion = !messages.length && !pending;
  const perm = /permission|screen|camera|access/i.test(error ?? state.notice ?? '');

  const composer=(bottom:boolean)=>(
    <div className={'composer'+(bottom?' bottom':'')}>
      {goal&&<div className="context-chip"><span>{goal.title}</span><button className="iconbtn" aria-label="Remove goal context" disabled={sending||busy} onClick={()=>attachGoal(null)}><Icon name="close" size={12}/></button></div>}
      <div className="goal-attachment">
        <button className="iconbtn" aria-label="Add to goal" aria-expanded={goalMenu} disabled={!ready||sending||busy||!!setupGoal||!state.goals.length} onClick={()=>setGoalMenu(!goalMenu)}><Icon name="plus"/></button>
        {goalMenu&&<div className="goal-picker" role="menu" aria-label="Current goals">{state.goals.map(g=><button role="menuitem" key={g.id} onClick={()=>attachGoal(g.id)}>{g.title}</button>)}</div>}
      </div>
      <textarea aria-label="Message" rows={1} maxLength={16000} ref={taRef} value={draft} disabled={!ready||sending||busy||!!setupGoal} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Escape')setGoalMenu(false);if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void send();}}}/>
      <button className="sendbtn" aria-label="Send" disabled={!ready||sending||busy||!!setupGoal||!draft.trim()} onClick={send}><Icon name="send"/></button>
    </div>
  );
  return (
    <div className="app">
      <Sidebar goals={state.goals} brainstorms={convs} selectedConversationId={graphGoal?null:selectedId} selectedGoalId={graphGoalId} activeGoalId={session?.status==='active'?session.goalId:null} disabled={!ready||busy||sending||!!setupGoal} friendsSelected={friendsOpen} friendsDisabled={busy||sending||!!setupGoal} onFriends={()=>setFriendsOpen(true)} onGoal={onGoalClick} onConversation={navigate} onNewChat={newChat}/>
      <main className="content">
        <header className="topbar">
          <div className="tleft">
            {activeGoal && (
              <span className="session" title={session?.status === 'paused' ? `Paused — ${session.pauseReason ?? ''}` : 'Active goal session'}>
                <span className={'dot' + (session?.status === 'active' ? ' live' : ' pause')} />
                <span className="stitle">{activeGoal.title}</span>
                {session?.status === 'paused' && <span className="slabel">Paused</span>}
              </span>
            )}
          </div>
          <div className="trcenter">{friendsOpen ? 'Friends' : graphGoal?.title??selected?.title??'Brainstorm'}</div>
          <div className="tright">
            {activeGoal && session && (
              <>
                {session.status === 'paused'
                  ? <button className="iconbtn" aria-label="Resume session" disabled={busy} onClick={onResume}><Icon name="play" /></button>
                  : <button className="iconbtn" aria-label="Pause session" disabled={busy} onClick={() => bridge.pause().catch(() => setError('Pause failed.'))}><Icon name="pause" /></button>}
                <button className="iconbtn" aria-label="Stop session" disabled={busy} onClick={() => bridge.stop().catch(() => setError('Stop failed.'))}><Icon name="stop" /></button>
              </>
            )}
          </div>
        </header>

        {(error || state.notice) && (
          <div className="notice" role="status">
            <span>{error ?? state.notice}</span>
            <span className="nactions">
              {perm && <button className="link" onClick={() => bridge.openPermissions('screen')}>Screen settings</button>}
              {perm && <button className="link" onClick={() => bridge.openPermissions('camera')}>Camera settings</button>}
              <button className="link" onClick={() => { setError(null); bridge.retry().catch(() => setError('Retry failed.')); }}>Retry</button>
            </span>
          </div>
        )}

        {friendsOpen ? <Friends /> : graphGoal ? <>
          <div className="graph-actions">
            {!graphGoal.ready
              ? <button className="btn" disabled={!!setupGoal} onClick={() => setSetupGoalId(graphGoal.id)}>Finish setup</button>
              : activeGoal?.id !== graphGoal.id && <button className="btn" disabled={busy} onClick={() => { void onGoalClick(graphGoal); }}>Start focus</button>}
          </div>
          <GoalGraph goal={graphGoal} details={state.goalDetails??[]}/>
        </> : showQuestion ? (
          <div className="empty">
            <h1>{goal?`What would you like to add to ${goal.title}?`:'What goals are you trying to achieve?'}</h1>
            {composer(false)}
          </div>
        ) : <>
          <div className="msgs" ref={listRef}>
            {messages.map(m=><div key={m.id} className={'msg '+m.role}>{m.role==='user'?<div className="bubble">{m.content}</div>:<div className="prose">{m.content}</div>}</div>)}
            {pending&&<div className="msg user"><div className="bubble">{pending}</div></div>}
            {sending&&<span className="reply-pending" aria-label="Thinking">···</span>}
          </div>
          {composer(true)}
        </>}
      </main>

      {setupGoal && (
        <GoalSetup
          goal={setupGoal}
          onUpdated={setState}
          onComplete={(updated) => { setSetupGoalId(null); openGraph(updated.id); void prepareGoal(updated); }}
          onClose={() => setSetupGoalId(null)}
        />
      )}

      {displays && pendingGoal && (
        <div className="overlay" onKeyDown={e => { if (e.key === 'Escape' && !busy) { setDisplays(null); setPendingGoal(null); } }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Start focus session">
            <p>Screen and camera images are sent to ai& during focus.</p>
            {displays.length > 1 && (
              <div className="thumbs">
                {displays.map(d => <button key={d.id} className={'display-choice'+(chosenDisplay===d.id?' selected':'')} aria-label={d.name} aria-pressed={chosenDisplay===d.id} onClick={()=>setChosenDisplay(d.id)}><img src={d.thumbnail} alt={d.name} /><span>{d.name}</span></button>)}
              </div>
            )}
            <div className="dbtns">
              <button className="btn" disabled={busy} onClick={() => { setDisplays(null); setPendingGoal(null); }}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={confirmGoal}>{displays.length > 1 ? 'Continue' : 'Continue'}</button>
              {displays.length === 1 && null}
            </div>
          </div>
        </div>
      )}

      {displays && resumeMode && session && (
        <div className="overlay" onKeyDown={e => { if (e.key === 'Escape' && !busy) { setDisplays(null); setResumeMode(false); } }}>
          <div className="dialog" role="dialog" aria-modal="true" aria-label="Resume focus session">
            <p>Screen and camera images are sent to ai& during focus.</p>
            {displays.length > 1 && <div className="thumbs">{displays.map(d => <button key={d.id} className={'display-choice'+(chosenDisplay===d.id?' selected':'')} aria-label={d.name} aria-pressed={chosenDisplay===d.id} onClick={()=>setChosenDisplay(d.id)}><img src={d.thumbnail} alt={d.name} /><span>{d.name}</span></button>)}</div>}
            <div className="dbtns">
              <button className="btn" disabled={busy} onClick={() => { setDisplays(null); setResumeMode(false); }}>Cancel</button>
              <button className="btn primary" disabled={busy} onClick={confirmResume}>Resume</button>
            </div>
          </div>
        </div>
      )}
      
    </div>
  );
}
