import { describe, it, expect } from 'vitest';
import { materializeGoals, normalizeTitle } from '../src/main/goals';
import type { Goal, GoalDraft } from '../src/shared/types';

function existingGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'Write the report',
    outcome: 'Report submitted',
    onTrack: ['outline done'],
    offTrack: ['drafting'],
    ready: true,
    sourceConversationId: 'conv-src',
    conversationId: 'conv-goal',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function draft(overrides: Partial<GoalDraft> = {}): GoalDraft {
  return {
    id: null,
    title: 'New goal',
    outcome: 'done',
    onTrack: ['a'],
    offTrack: ['b'],
    ...overrides,
  };
}

describe('normalizeTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTitle('  Write   the  report ')).toBe('Write the report');
  });

  it('constrains length', () => {
    expect(normalizeTitle('x'.repeat(500)).length).toBeLessThanOrEqual(120);
  });
});

describe('materializeGoals', () => {
  it('creates new goals with uuid ids, conversationId, and provenance', () => {
    const out = materializeGoals([draft()], [], 'conv-src');
    expect(out).toHaveLength(1);
    expect(out[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out[0].conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out[0].sourceConversationId).toBe('conv-src');
    expect(out[0].createdAt).toBe(out[0].updatedAt);
  });

  it('reuses existing goal by normalized title and preserves provenance', () => {
    const existing = existingGoal();
    const out = materializeGoals(
      [draft({ title: '  write  THE report ', outcome: 'updated outcome' })],
      [existing],
      'conv-new'
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('goal-1');
    expect(out[0].sourceConversationId).toBe('conv-src');
    expect(out[0].conversationId).toBe('conv-goal');
    expect(out[0].createdAt).toBe('2024-01-01T00:00:00.000Z');
    expect(out[0].outcome).toBe('updated outcome');
    expect(out[0].updatedAt).not.toBe(existing.updatedAt);
  });

  it('rejects drafts with unknown existing ids', () => {
    const out = materializeGoals([draft({ id: 'unknown-id' })], [existingGoal()], 'conv-src');
    expect(out).toHaveLength(0);
  });

  it('accepts drafts referencing known existing ids with same title', () => {
    const out = materializeGoals(
      [draft({ id: 'goal-1', title: 'Write the report', outcome: 'refined' })],
      [existingGoal()],
      'conv-src'
    );
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('refined');
  });

  it('rejects unrelated drafts in scoped chats', () => {
    const scope = existingGoal();
    const out = materializeGoals(
      [draft({ title: 'Unrelated thing' }), draft({ id: scope.id, title: scope.title, outcome: 'scoped update' })],
      [scope],
      'conv-src',
      scope
    );
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(scope.id);
    expect(out[0].outcome).toBe('scoped update');
  });

  it('rejects unknown ids in scoped chats', () => {
    const scope = existingGoal();
    const out = materializeGoals(
      [draft({ id: 'bogus', title: scope.title })],
      [scope],
      'conv-src',
      scope
    );
    expect(out).toHaveLength(0);
  });

  it('dedups multiple same-title drafts in one call', () => {
    const out = materializeGoals(
      [draft({ title: 'Same title', outcome: 'first' }), draft({ title: 'same  TITLE', outcome: 'second' })],
      [],
      'conv-src'
    );
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe('first');
  });

  it('marks not ready when outcome or track lists are empty', () => {
    const out = materializeGoals(
      [draft({ outcome: '  ', onTrack: [], offTrack: ['x'] }), draft({ title: 'B', outcome: 'ok', onTrack: ['a'], offTrack: [' '] })],
      [],
      'conv-src'
    );
    expect(out[0].ready).toBe(false);
    expect(out[1].ready).toBe(false);
  });

  it('strips blank entries and dedups arrays', () => {
    const out = materializeGoals(
      [draft({ onTrack: [' a ', '', 'a', 'b'], offTrack: ['', '  '] })],
      [],
      'conv-src'
    );
    expect(out[0].onTrack).toEqual(['a', 'b']);
    expect(out[0].offTrack).toEqual([]);
    expect(out[0].ready).toBe(false);
  });

  it('merges updates without erasing populated fields with empty ones', () => {
    const existing = existingGoal();
    const out = materializeGoals(
      [draft({ id: existing.id, title: existing.title, outcome: '', onTrack: [], offTrack: [] })],
      [existing],
      'conv-src'
    );
    expect(out).toHaveLength(0); // nothing changed, so unchanged goal not returned
  });

  it('returns existing untouched when drafts array is empty', () => {
    const existing = existingGoal();
    const out = materializeGoals([], [existing], 'conv-src');
    expect(out).toHaveLength(0);
  });

  it('never deletes unrelated existing goals', () => {
    const a = existingGoal();
    const b = existingGoal({ id: 'goal-2', title: 'Other goal' });
    const out = materializeGoals([draft({ title: 'Brand new' })], [a, b], 'conv-src');
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Brand new');
  });
});
