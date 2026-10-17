import { randomUUID } from 'node:crypto';
import type { Goal, GoalDraft } from '../shared/types';

export const MAX_TITLE_LENGTH = 120;
export const MAX_FIELD_LENGTH = 2000;

export function normalizeTitle(title: string): string {
  return String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH)
    .trim();
}

function cleanArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of input) {
    const value = String(item ?? '').trim().slice(0, MAX_FIELD_LENGTH);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function normalizeOutcome(outcome: unknown): string {
  return String(outcome ?? '').trim().slice(0, MAX_FIELD_LENGTH);
}

function isReady(outcome: string, onTrack: string[], offTrack: string[]): boolean {
  return outcome.length > 0 && onTrack.length > 0 && offTrack.length > 0;
}

function isPopulated(value: string): boolean {
  return value.length > 0;
}

function existingKey(goal: Goal): string {
  return normalizeTitle(goal.title).toLowerCase();
}

export function materializeGoals(
  drafts: GoalDraft[],
  existing: Goal[],
  sourceConversationId: string,
  scopeGoal?: Goal
): Goal[] {
  const draftsList = Array.isArray(drafts) ? drafts : [];
  if (draftsList.length === 0) return [];

  const byId = new Map<string, Goal>();
  for (const goal of existing) byId.set(goal.id, goal);
  const byTitle = new Map<string, Goal>();
  for (const goal of existing) {
    const key = existingKey(goal);
    if (!byTitle.has(key)) byTitle.set(key, goal);
  }

  const now = new Date().toISOString();
  const seenTitles = new Set<string>();
  const results: Goal[] = [];
  const resultIds = new Set<string>();

  for (const draft of draftsList) {
    if (!draft || typeof draft !== 'object') continue;

    const title = normalizeTitle(draft.title);
    if (!title) continue;

    const key = title.toLowerCase();

    // Scoped chat: reject drafts unrelated to the scoped goal.
    if (scopeGoal) {
      const scopedId = draft.id;
      if (!scopedId || scopedId !== scopeGoal.id) continue;
      if (scopedId && !byId.has(scopedId)) continue; // unknown id
    }

    // Dedup multiple same-title drafts in the same call.
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);

    // Reuse existing goal by exact id or normalized title.
    let target: Goal | undefined;
    if (typeof draft.id === 'string' && draft.id) {
      const candidate = byId.get(draft.id);
      if (!candidate) continue; // unknown id must be rejected
      // Id-based match must not conflict with a differently-titled existing goal.

      target = candidate;
    } else {
      target = byTitle.get(key);
    }

    const outcome = normalizeOutcome(draft.outcome);
    const onTrack = cleanArray(draft.onTrack);
    const offTrack = cleanArray(draft.offTrack);

    if (target) {
      // Merge: never erase populated data with empty fields.
      const mergedOutcome = isPopulated(outcome) ? outcome : target.outcome;
      const mergedOnTrack = onTrack.length > 0 ? onTrack : target.onTrack;
      const mergedOffTrack = offTrack.length > 0 ? offTrack : target.offTrack;
      const mergedReady = isReady(mergedOutcome, mergedOnTrack, mergedOffTrack);

      if (
        target.title === title &&
        target.outcome === mergedOutcome &&
        target.ready === mergedReady &&
        arraysEqual(target.onTrack, mergedOnTrack) &&
        arraysEqual(target.offTrack, mergedOffTrack)
      ) {
        continue; // unchanged, do not return
      }

      const updated: Goal = {
        ...target,
        title,
        outcome: mergedOutcome,
        onTrack: mergedOnTrack,
        offTrack: mergedOffTrack,
        ready: mergedReady,
        updatedAt: now,
      };
      if (!resultIds.has(updated.id)) {
        resultIds.add(updated.id);
        results.push(updated);
      }
    } else {
      const created: Goal = {
        id: randomUUID(),
        title,
        outcome,
        onTrack,
        offTrack,
        ready: isReady(outcome, onTrack, offTrack),
        sourceConversationId,
        conversationId: randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      resultIds.add(created.id);
      results.push(created);
    }
  }

  return results;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
