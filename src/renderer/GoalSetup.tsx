import React, { useEffect, useRef, useState } from 'react';
import type { AppState, Goal } from '../shared/types';

export function missingGoalQuestion(goal: Goal): string | null {
  if (!goal.outcome.trim()) return 'What specific outcome would tell you this goal succeeded?';
  if (!goal.onTrack.length) return 'What work would show you are on track with this goal?';
  return null;
}

interface Props {
  goal: Goal;
  onUpdated: (s: AppState) => void;
  onComplete: (g: Goal) => void;
  onClose: () => void;
}

export default function GoalSetup({ goal, onUpdated, onComplete, onClose }: Props) {
  const [answer, setAnswer] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<{ content: string; id: string } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const question = missingGoalQuestion(goal);

  useEffect(() => {
    taRef.current?.focus();
  }, [question]);

  if (!question) return null;

  const send = async () => {
    const text = answer.trim();
    if (!text || sending) return;
    const msg = `${question}\n\n${text}`;
    if (request.current?.content !== msg) request.current = { content: msg, id: crypto.randomUUID() };
    const rid = request.current.id;
    setSending(true);
    setError(null);
    try {
      await window.coach.sendMessage(goal.conversationId, msg, rid);
      const fresh = await window.coach.getState();
      const updated = fresh.goals.find(g => g.id === goal.id) ?? null;
      if (!updated) throw new Error('Goal unavailable');
      request.current = null;
      onUpdated(fresh);
      if (updated && missingGoalQuestion(updated)) {
        setAnswer('');
      } else if (updated) {
        onComplete(updated);
      }
    } catch {
      setError('Could not send. Your answer is kept \u2014 try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className="overlay"
      onKeyDown={e => { if (e.key === 'Escape' && !sending) onClose(); }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Finish goal setup">
        <p className="setup-question">{question}</p>
        <textarea
          ref={taRef}
          className="setup-answer"
          aria-label="Answer"
          rows={3}
          maxLength={15000}
          value={answer}
          disabled={sending}
          onChange={e => setAnswer(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        {error && <p className="setup-error" role="alert">{error}</p>}
        <div className="dbtns">
          <button className="btn" disabled={sending} onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={sending || !answer.trim()} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
