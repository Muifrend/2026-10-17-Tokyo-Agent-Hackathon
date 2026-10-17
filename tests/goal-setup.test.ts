import { describe, it, expect } from 'vitest';
import { missingGoalQuestion } from '../src/renderer/GoalSetup';
import type { Goal } from '../src/shared/types';

function makeGoal(partial: Partial<Goal>): Goal {
  return {
    id: 'g1',
    title: 'Write essay',
    outcome: '',
    onTrack: [],
    offTrack: [],
    ready: false,
    sourceConversationId: 'c0',
    conversationId: 'c1',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    ...partial,
  };
}

describe('missingGoalQuestion', () => {
  it('asks about outcome first when outcome is missing', () => {
    const goal = makeGoal({});
    expect(missingGoalQuestion(goal)).toMatch(/outcome/i);
  });

  it('asks about on-track work when outcome set but onTrack empty', () => {
    const goal = makeGoal({ outcome: 'Essay submitted' });
    const q = missingGoalQuestion(goal);
    expect(q).toBeTruthy();
    expect(q).toMatch(/on track/i);
  });

  it('never blocks on missing distraction criteria', () => {
    const goal = makeGoal({
      ready: false,
      outcome: 'Essay submitted',
      onTrack: ['Draft done by Friday'],
      offTrack: [],
    });
    const q = missingGoalQuestion(goal);
    expect(q).toBeNull();
  });

  it('returns null for a complete goal', () => {
    const goal = makeGoal({
      ready: true,
      outcome: 'Essay submitted',
      onTrack: ['Draft done by Friday'],
      offTrack: ['Social media'],
    });
    expect(missingGoalQuestion(goal)).toBeNull();
  });

  it('asks required questions in order: outcome, onTrack', () => {
    const g0 = makeGoal({});
    const q1 = missingGoalQuestion(g0)!;
    const g1 = makeGoal({ outcome: 'Done' });
    const q2 = missingGoalQuestion(g1)!;
    const g2 = makeGoal({ outcome: 'Done', onTrack: ['x'] });
    const q3 = missingGoalQuestion(g2);
    expect(q1).toMatch(/outcome/i);
    expect(q2).toMatch(/on track/i);
    expect(q3).toBeNull();
  });
});
