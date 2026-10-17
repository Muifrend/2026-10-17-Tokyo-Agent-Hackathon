import type { Goal, Conversation } from '../shared/types';

export interface SidebarProps {
  goals: Goal[];
  brainstorms: Conversation[];
  selectedConversationId: string | null;
  selectedGoalId: string | null;
  activeGoalId: string | null;
  disabled: boolean;
  onGoal: (goal: Goal) => void;
  onConversation: (id: string) => void;
  onNewChat: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const {
    goals,
    brainstorms,
    selectedConversationId,
    selectedGoalId,
    activeGoalId,
    disabled,
    onGoal,
    onConversation,
    onNewChat,
  } = props;

  return (
    <aside className="sidebar">
      <section className="sidebar-section goals-section">
        <div className="sidebar-heading">
          <h2>Goals</h2>
        </div>
        <div className="rows sidebar-list">
          {goals.map((goal) => {
            const selected = goal.id === selectedGoalId;
            const active = goal.id === activeGoalId;
            return (
              <button
                key={goal.id}
                className={`sidebar-row${selected ? ' selected' : ''}`}
                disabled={disabled}
                onClick={() => onGoal(goal)}
                title={goal.title}
              >
                <span
                  className={`goal-dot${active ? ' active' : ''}`}
                  aria-hidden="true"
                />
                <span className="sidebar-row-title">{goal.title}</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="sidebar-section brainstorms-section">
        <div className="sidebar-heading">
          <h2>Brainstorms</h2>
          <button
            className="new-chat-button"
            aria-label="New chat"
            title="New chat"
            disabled={disabled}
            onClick={onNewChat}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4Z" />
            </svg>
          </button>
        </div>
        <div className="rows sidebar-list">
          {brainstorms.map((c) => (
            <button
              key={c.id}
              className={`sidebar-row${c.id === selectedConversationId ? ' selected' : ''}`}
              disabled={disabled}
              onClick={() => onConversation(c.id)}
              title={c.title}
            >
              <span className="sidebar-row-title">{c.title}</span>
            </button>
          ))}
        </div>
      </section>
    </aside>
  );
}
