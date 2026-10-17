import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import neo4j from 'neo4j-driver';
import { Neo4jStore } from '../src/main/repository';
import { AIClient } from '../src/main/ai';
import { materializeGoals } from '../src/main/goals';
import { materializeGoalGraph } from '../src/main/goal-graph';
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
    const user: Message = { id: randomUUID(), conversationId: conversation.id, role: 'user', content: 'My goal is to finish a 500-word Tokyo travel essay today. My motivation is preserving memories of our family visit. One subgoal is gathering reliable historical sources; an action under that subgoal is reading the Tokyo museum guide. My obstacle is limited research time. Success means a finished 500-word essay today. On track means writing or researching Tokyo history. Off track means unrelated social media or using my phone for entertainment.', createdAt: time };
    const answer = await ai.interview([user], []);
    if(process.env.GRAPH_TEST_DEBUG)console.log('Synthetic interview graph:',JSON.stringify(answer.goals));
    const goals = materializeGoals(answer.goals, [], conversation.id);
    if (!goals.length) throw new Error('Interview did not extract the explicitly stated goal');
    const assistant: Message = { id: randomUUID(), conversationId: conversation.id, role: 'assistant', content: answer.reply, createdAt: new Date().toISOString() };
    ids.push(user.id, assistant.id, ...goals.flatMap(g => [g.id,g.conversationId]));
    const graph=materializeGoalGraph(answer.goals,goals,[],user.id);
    ids.push(...graph.upserts.map(n=>n.id));
    await store.saveTurn(conversation.id, user, assistant, goals, answer.title,graph);
    await store.saveTurn(conversation.id, user, assistant, goals, answer.title,graph);
    const loaded = await store.load();
    if (loaded.messages.filter(m => m.id === user.id).length !== 1 || !loaded.goals.some(g => g.id === goals[0].id)) throw new Error('Persistence or retry deduplication failed');
    if (!loaded.conversations.some(c => c.id === goals[0].conversationId)) throw new Error('Goal chat missing');
    const kinds=new Set(loaded.goalDetails.filter(d=>d.goalId===goals[0].id).map(d=>d.kind));
    if(!['subgoal','action','motivation','obstacle','success_criterion','distraction'].every(k=>kinds.has(k as never)))throw new Error('Interview omitted explicit graph facts');
    console.log('Real interview created all six semantic node kinds; Neo4j save/load and retry passed.');
    const refineChat:Conversation={id:randomUUID(),title:'Refinement',kind:'brainstorm',goalId:null,createdAt:new Date().toISOString()};ids.push(refineChat.id);
    await store.createConversation(refineChat);await store.setChatGoal(refineChat.id,goals[0].id);
    const user2:Message={id:randomUUID(),conversationId:refineChat.id,role:'user',content:'Add a new action to this existing goal: draft the introduction on Sunday. Keep the existing goal and all its other facts.',createdAt:new Date().toISOString()};ids.push(user2.id);
    const refined=await ai.interview([user2],goals,goals[0],undefined,loaded.goalDetails);
    if(process.env.GRAPH_TEST_DEBUG)console.log('Synthetic refinement:',JSON.stringify(refined.goals));
    const updates=materializeGoals(refined.goals,goals,refineChat.id,goals[0]);
    const afterGoals=[...goals.filter(g=>!updates.some(u=>u.id===g.id)),...updates];
    const graph2=materializeGoalGraph(refined.goals,afterGoals,loaded.goalDetails,user2.id);ids.push(...graph2.upserts.map(d=>d.id));
    const assistant2:Message={id:randomUUID(),conversationId:refineChat.id,role:'assistant',content:refined.reply,createdAt:new Date().toISOString()};ids.push(assistant2.id);
    await store.saveTurn(refineChat.id,user2,assistant2,updates,refined.title,graph2);
    const after=await store.load();
    if(after.conversations.find(c=>c.id===refineChat.id)?.goalId!==goals[0].id||!after.goalDetails.some(d=>d.goalId===goals[0].id&&d.sourceMessageId===user2.id&&d.kind==='action'))throw new Error('Cross-chat graph refinement failed');
    const probe=neo4j.driver(process.env.NEO4J_URI!,neo4j.auth.basic(process.env.NEO4J_USERNAME!,process.env.NEO4J_PASSWORD!));
    try{
      const native=await probe.executeQuery('MATCH (g:TGCGoal {id:$id})-[:HAS_SUBGOAL|REQUIRES_ACTION|MOTIVATED_BY|FACES_OBSTACLE|SUCCESS_WHEN|DISTRACTED_BY*1..5]->(d:TGCGoalDetail) RETURN count(DISTINCT d) AS facts',{id:goals[0].id},{database:process.env.NEO4J_DATABASE||'neo4j'});
      if(native.records[0].get('facts').toNumber()<6)throw new Error('Native graph relationships missing');
    }finally{await probe.close();}
    console.log('Second chat refined the same goal; native Neo4j semantic relationships verified.');
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
        await driver.executeQuery('MATCH (n) WHERE n.id IN $ids AND any(label IN labels(n) WHERE label IN $labels) DETACH DELETE n', {ids, labels:['TGCConversation','TGCMessage','TGCGoal','TGCFocusSession','TGCObservation','TGCGoalDetail']}, {database:process.env.NEO4J_DATABASE || 'neo4j'});
        console.log('Temporary integration records removed.');
      } finally { await driver.close(); }
    }
  }
}
main().catch((error) => { console.error('Live integration check failed:',error instanceof Error ? error.message : 'Unknown error'); process.exitCode = 1; });
