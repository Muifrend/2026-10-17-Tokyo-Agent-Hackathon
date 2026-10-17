import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { AppState, Conversation, Goal, DisplaySource } from '../shared/types';

const bridge = window.coach;

type Tab = 'goals' | 'brainstorm';

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const p: Record<string, React.ReactNode> = {
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
  const [tab, setTab] = useState<Tab>('brainstorm');
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

  const convs = (state?.conversations ?? []).filter(c => tab === 'goals' ? c.kind === 'goal' : c.kind === 'brainstorm');
  const selected: Conversation | null =
    convs.find(c => c.id === selectedId) ?? null;
  const messages = selected ? (state?.messages ?? []).filter(m => m.conversationId === selected.id) : [];
  const goal = selected?.goalId ? state?.goals.find(g => g.id === selected.goalId) ?? null : null;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, pending]);

  const navigate = useCallback((id: string) => {
    setSelectedId(id);
    setTab(id && (state?.conversations.find(c => c.id === id)?.kind) === 'goal' ? 'goals' : 'brainstorm');
    setDraft(''); setError(null);
  }, [state?.conversations]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending || !ready) return;
    if (!selected) {
      // empty brainstorm: create on first send
      setSending(true); setError(null);
      try {
        const id = await bridge.newBrainstorm();
        setSelectedId(id);
        setPending(text); setDraft('');
        await bridge.sendMessage(id, text, requestFor(text,id));
        retryRequest.current=null;
      } catch { setError('Message failed to send.'); setDraft(text); }
      finally { setPending(null); setSending(false); }
      return;
    }
    setSending(true); setError(null);
    setPending(text); setDraft('');
    try {
      await bridge.sendMessage(selected.id, text, requestFor(text,selected.id));
      retryRequest.current=null;
    } catch {
      setError('Message failed to send.');
      setDraft(text);
    } finally {
      setPending(null); setSending(false);
    }
  };

  const onGoalClick = async (g: Goal) => {
    if (session && session.goalId === g.id && (session.status === 'active' || session.status === 'paused')) {
      navigate(g.conversationId);
      return;
    }
    if (!g.ready) {
      try { await bridge.selectGoal(g.id); navigate(g.conversationId); }
      catch { setError('Could not open goal.'); }
      return;
    }
    setPendingGoal(g);
    try { const screens=await bridge.listDisplays(); if(!screens.length)throw new Error('No displays available. Check screen permission.'); setDisplays(screens);setChosenDisplay(screens[0].id); }
    catch { setError('Screen unavailable. Check Screen Recording permission.'); setPendingGoal(null); }
  };

  const confirmGoal = async () => {
    if (!pendingGoal) return;
    setBusy(true);
    try {
      const displayId = chosenDisplay || displays?.[0]?.id;
      const cid = await bridge.selectGoal(pendingGoal.id, displayId);
      setPendingGoal(null); setDisplays(null);
      navigate(cid); setTab('goals');
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

  const emptyState = !selected;
  const showQuestion = tab === 'brainstorm' && !messages.length && !pending;
  const goalChatEmpty = selected?.kind === 'goal' && messages.length === 0 && !pending;
  const perm = /permission|screen|camera|access/i.test(error ?? state.notice ?? '');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="tabs">
          <button className={tab === 'goals' ? 'tab on' : 'tab'} onClick={() => { setTab('goals'); setSelectedId(null); }}>Goals</button>
          <button className={tab === 'brainstorm' ? 'tab on' : 'tab'} onClick={() => { setTab('brainstorm'); setSelectedId(null); }}>Brainstorm</button>
          <button className="iconbtn" aria-label="New chat" onClick={async () => {
            try { const id = await bridge.newBrainstorm(); setTab('brainstorm'); setSelectedId(id); }
            catch { setError('Could not create chat.'); }
          }}><Icon name="plus" /></button>
        </div>
        <div className="rows">
          {tab === 'goals' && (state.goals).map(g => (
            <button key={g.id} className={'row' + (selected?.goalId === g.id ? ' sel' : '')} onClick={() => onGoalClick(g)}>
              <span className={'dot' + (session?.goalId === g.id && session.status === 'active' ? ' live' : '') + (!g.ready ? ' hollow' : '')} />
              <span className="rtitle">{g.title}</span>
            </button>
          ))}
          {tab === 'brainstorm' && convs.map(c => (
            <button key={c.id} className={'row' + (selected?.id === c.id ? ' sel' : '')} onClick={() => navigate(c.id)}>
              <span className="rtitle">{c.title || 'New chat'}</span>
            </button>
          ))}
        </div>
      </aside>
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
          <div className="trcenter">{selected ? (selected.title || 'New chat') : tab === 'goals' ? 'Goals' : 'Brainstorm'}</div>
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

        {showQuestion ? (
          <div className="empty">
            <h1>What goals are you trying to achieve?</h1>
            <div className="composer">
              <textarea aria-label="Message" rows={1} maxLength={16000} ref={taRef} value={draft} placeholder={ready ? '' : 'Connecting…'} disabled={!ready || sending}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="sendbtn" aria-label="Send" disabled={!ready || sending || !draft.trim()} onClick={send}><Icon name="send" /></button>
            </div>
          </div>
        ) : (
          <>
            <div className="msgs" ref={listRef}>
              {goalChatEmpty && goal && (
                <p className="sys">{!goal.ready
                  ? !goal.outcome ? 'What would achieving this goal look like?' : !goal.onTrack.length ? 'What work on your screen would count as progress?' : 'What should count as a distraction from this goal?'
                  : ''}</p>
              )}
              {messages.map(m => (
                <div key={m.id} className={'msg ' + m.role}>
                  {m.role === 'user' ? <div className="bubble">{m.content}</div> : <div className="prose">{m.content}</div>}
                </div>
              ))}
              {pending && <div className="msg user"><div className="bubble">{pending}</div></div>}
            </div>
            {(selected || tab === "brainstorm") && <div className="composer bottom">
              <textarea aria-label="Message" rows={1} maxLength={16000} ref={taRef} value={draft} disabled={!ready || sending}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <button className="sendbtn" aria-label="Send" disabled={!ready || sending || !draft.trim()} onClick={send}><Icon name="send" /></button>
            </div>}
          </>
        )}
      </main>

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
