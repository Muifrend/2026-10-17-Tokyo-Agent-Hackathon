import { useEffect, useRef, useState } from 'react';
import type { FriendsState } from '../shared/points';

function safeTint(color: unknown): string | undefined {
  if (typeof color !== 'string') return undefined;
  const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(color.trim());
  return m ? color.trim() : undefined;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export default function Friends() {
  const [state, setState] = useState<FriendsState | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || disposed) return;
      inFlight = true;
      try {
        const next = await window.coach.getFriends();
        if (!disposed) setState(previous => next.status === 'offline' && previous
          ? { ...previous, status: 'offline', message: next.message }
          : next);
      } catch {
        if (!disposed) setState(previous => ({
          status: 'offline', rows: previous?.rows ?? [],
          playerName: previous?.playerName ?? '', message: 'Friends unavailable.',
        }));
      } finally {
        inFlight = false;
        if (!disposed) setLoading(false);
      }
    };
    refreshRef.current = () => { void refresh(); };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 20000);
    return () => { disposed = true; window.clearInterval(timer); refreshRef.current = () => undefined; };
  }, []);

  const unavailable = state?.status !== 'ready';
  const player = state?.playerName.toLowerCase();
  return (
    <div className="friends-view" aria-label="Friends leaderboard">
      {loading ? <p className="friends-note">Loading…</p> : <>
        {unavailable && <div className="friends-status" role="status">
          <span>{state?.message ?? 'Friends unavailable.'}</span>
          <button className="btn" onClick={() => refreshRef.current()}>Retry</button>
        </div>}
        {state?.status === 'ready' && !state.rows.length && <p className="friends-note">No players yet.</p>}
        {!!state?.rows.length && <table className="friends-table" aria-label="Leaderboard">
          <thead><tr><th scope="col" className="col-rank">Rank</th><th scope="col">Name</th><th scope="col" className="col-points">Points</th></tr></thead>
          <tbody>{state.rows.map(row => {
            const you = row.name.toLowerCase() === player;
            const tint = safeTint((row as { color?: unknown }).color);
            return <tr key={row.id} className={you ? 'you' : undefined}>
              <td className="col-rank"><span className={`friends-rank${row.rank === 1 ? ' first' : ''}`}>{row.rank}</span></td>
              <td>
                <span className="friends-name">
                  <span className="friends-avatar" style={tint ? { background: `color-mix(in srgb, ${tint} 20%, var(--bg))`, color: 'var(--text)' } : undefined} aria-hidden="true">{initials(row.name)}</span>
                  {row.live && <span className="friends-live" role="img" aria-label="Recently focused" />}
                  <span className="friends-nametext">{row.name}{you && <span className="friends-you"> (you)</span>}</span>
                </span>
              </td>
              <td className="col-points"><span className="friends-points">{row.points}</span></td>
            </tr>;
          })}</tbody>
        </table>}
      </>}
    </div>
  );
}

