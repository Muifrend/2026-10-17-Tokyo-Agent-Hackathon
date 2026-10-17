import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { Neo4jStore } from '../src/main/repository';
import { AIClient } from '../src/main/ai';
import { materializeGoals } from '../src/main/goals';
import type { Conversation, Message, FocusSession, Observation } from '../src/shared/types';

async function main() {
  config({ quiet: true });
  const store = new Neo4jStore();
  const ai = new AIClient();
  const ids: string[] = [];
  try {
    await store.init();
    console.log('Neo4j connected.');
    await ai.init();
    const time = new Date().toISOString();
    const conversation: Conversation = { id: randomUUID(), title: '[integration check]', kind: 'brainstorm', goalId: null, createdAt: time };
    ids.push(conversation.id);
    await store.createConversation(conversation);
    const user: Message = { id: randomUUID(), conversationId: conversation.id, role: 'user', content: 'My goal is to finish a 500-word Tokyo travel essay today. On track means writing or researching Tokyo history. Off track means unrelated social media or using my phone for entertainment.', createdAt: time };
    const answer = await ai.interview([user], []);
    const goals = materializeGoals(answer.goals, [], conversation.id);
    if (!goals.length) throw new Error('Interview did not extract the explicitly stated goal');
    const assistant: Message = { id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: answer.reply, createdAt: new Date().toISOString() };
    ids.push(user.id, assistant.id, ...goals.flatMap(g => [g.id,g.conversationId]));
    await store.saveTurn(conversation.id, user, assistant, goals, answer.title);
    await store.saveTurn(conversation.id, user, assistant, goals, answer.title);
    const loaded = await store.load();
    if (loaded.messages.filter(m => m.id === user.id).length !== 1 || !loaded.goals.some(g => g.id === goals[0].id)) throw new Error('Persistence or retry deduplication failed');
    if (!loaded.conversations.some(c => c.id === goals[0].conversationId)) throw new Error('Goal chat missing');
    console.log('Real interview extracted a goal; Neo4j save/load and idempotent retry passed.');
    await ai.verifyVision();
    console.log('Real ai& image input and strict JSON validation passed.');
    const focus: FocusSession = { id: randomUUID(), goalId: goals[0].id, status: 'active', startedAt: time, endedAt: null, pauseReason: null, displayId: 'test' };
    ids.push(focus.id);
    await store.saveSession(focus);
    const observation: Observation = { id: randomUUID(), sessionId: focus.id, createdAt: time, verdict: 'uncertain', confidence: .2, reason: 'Synthetic integration check', reminderText: 'Continue writing.' };
    ids.push(observation.id);
    await store.saveObservation(observation);
    const reminder = await store.saveReminder(goals[0], 'Integration check only.');
    ids.push(reminder.id);
    console.log('Focus session, findings, and reminder persistence passed.');
  } finally {
    await store.close();
    if (ids.length) {
      const driver = neo4j.driver(process.env.NEO4J_URI!,neo4j.auth.basic(process.env.NEO4J_USERNAME!,process.env.NEO4J_PASSWORD!));
      try {
        await driver.executeQuery('MATCH (n) WHERE n.id IN $ids AND any(label IN labels(n) WHERE label IN $labels) DETACH DELETE n', {ids, labels:['TGCConversation','TGCMessage','TGCGoal','TGCFocusSession','TGCObservation']}, {database:process.env.NEO4J_DATABASE || 'neo4j'});
        console.log('Temporary integration records removed.');
      } finally { await driver.close(); }
    }
  }
}
main().catch(() => { console.error('Live integration check failed. No credentials or image data logged.'); process.exitCode = 1; });
