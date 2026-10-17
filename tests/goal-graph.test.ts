import {describe,it,expect} from 'vitest';
import {materializeGoalGraph,backfillGoalGraph,relationFor} from '../src/main/goal-graph';
import type {Goal,GoalDraft,GoalDetailDraft} from '../src/shared/types';
const goal:Goal={id:'goal',title:'Write a book',outcome:'Finish a draft',onTrack:['Writing chapters'],offTrack:['Unrelated scrolling'],ready:true,sourceConversationId:'chat',conversationId:'goal-chat',createdAt:'2026-10-17',updatedAt:'2026-10-17'};
const patch=(details:GoalDetailDraft[]):GoalDraft=>({id:goal.id,title:goal.title,outcome:goal.outcome,onTrack:goal.onTrack,offTrack:goal.offTrack,details});
describe('goal knowledge graph',()=>{
 it('creates real hierarchical facts with canonical IDs and source provenance',()=>{
  const changes=materializeGoalGraph([patch([{key:'outline',kind:'subgoal',text:'Plan the chapters',parentKey:null},{key:'draft',kind:'action',text:'Write chapter one',parentKey:'outline'},{key:'why',kind:'motivation',text:'Share my family history',parentKey:null},{key:'blocker',kind:'obstacle',text:'Limited evening time',parentKey:null}])],[goal],[],'user-message');
  const parent=changes.upserts.find(n=>n.kind==='subgoal')!;const action=changes.upserts.find(n=>n.kind==='action')!;
  expect(parent.id).toMatch(/^[0-9a-f-]{36}$/);expect(action.parentId).toBe(parent.id);expect(changes.upserts.every(n=>n.goalId===goal.id&&n.sourceMessageId==='user-message')).toBe(true);
  expect(new Set(changes.upserts.map(n=>n.kind))).toEqual(new Set(['subgoal','action','motivation','obstacle','success_criterion','distraction']));
 });
 it('deduplicates the same fact across chats and preserves its identity when edited',()=>{
  const first=materializeGoalGraph([patch([{key:'why',kind:'motivation',text:'Family history',parentKey:null}])],[goal],[],'m1');
  const duplicate=materializeGoalGraph([patch([{key:'again',kind:'motivation',text:' family   history ',parentKey:null}])],[goal],first.upserts,'m2');
  expect(duplicate.upserts.filter(n=>n.kind==='motivation')).toHaveLength(1); // Formatting changes retain the same UUID.
  expect(duplicate.upserts.find(n=>n.kind==='motivation')?.id).toBe(first.upserts.find(n=>n.kind==='motivation')?.id);
  const id=first.upserts.find(n=>n.kind==='motivation')!.id;
  const updated=materializeGoalGraph([patch([{key:id,kind:'motivation',text:'Preserve family stories',parentKey:null}])],[goal],first.upserts,'m3');
  expect(updated.upserts.find(n=>n.id===id)?.sourceMessageId).toBe('m3');
 });
 it('can attach a later action to an existing subgoal',()=>{
  const first=materializeGoalGraph([patch([{key:'outline',kind:'subgoal',text:'Plan the chapters',parentKey:null}])],[goal],[],'m1');const parent=first.upserts.find(n=>n.kind==='subgoal')!;
  const next=materializeGoalGraph([patch([{key:'next',kind:'action',text:'Interview my grandmother',parentKey:parent.id}])],[goal],first.upserts,'m2');
  expect(next.upserts.find(n=>n.kind==='action')?.parentId).toBe(parent.id);
 });
 it('rejects cycles and unknown or cross-goal parents',()=>{
  expect(()=>materializeGoalGraph([patch([{key:'a',kind:'subgoal',text:'A',parentKey:'b'},{key:'b',kind:'subgoal',text:'B',parentKey:'a'}])],[goal],[],'m')).toThrow(/cycle/);
  expect(()=>materializeGoalGraph([patch([{key:'action',kind:'action',text:'Write',parentKey:'unknown'}])],[goal],[],'m')).toThrow(/parent/);
  const foreign={id:'foreign',goalId:'other',kind:'subgoal' as const,text:'Other',parentId:null,sourceMessageId:null,createdAt:'t',updatedAt:'t'};
  expect(()=>materializeGoalGraph([patch([{key:'foreign',kind:'subgoal',text:'Steal',parentKey:null}])],[goal],[foreign],'m')).toThrow(/unrelated/);
 });
 it('backfills legacy criteria idempotently without invented motivations or actions',()=>{
  const first=backfillGoalGraph([goal],[]);expect(first.upserts).toHaveLength(3);
  expect(first.upserts.every(n=>n.sourceMessageId===null)).toBe(true);
  expect(backfillGoalGraph([goal],first.upserts).upserts).toHaveLength(0);
 });
 it('removes only explicitly selected facts and reparents surviving children',()=>{
  const first=materializeGoalGraph([patch([{key:'s',kind:'subgoal',text:'Outline',parentKey:null},{key:'a',kind:'action',text:'Write intro',parentKey:'s'}])],[goal],[],'m1');
  const parent=first.upserts.find(n=>n.kind==='subgoal')!;const next=materializeGoalGraph([{...patch([]),removeDetailIds:[parent.id]}],[goal],first.upserts,'m2');
  expect(next.removeIds).toEqual([parent.id]);expect(next.upserts.find(n=>n.kind==='action')?.parentId).toBeNull();
 });
 it('replaces obsolete criteria when the user revises a goal outcome',()=>{
  const old=backfillGoalGraph([goal],[]);const revised={...goal,outcome:'Publish the finished book'};
  const changes=materializeGoalGraph([{...patch([]),outcome:revised.outcome}],[revised],old.upserts,'revision',[goal]);
  expect(changes.removeIds).toContain(old.upserts.find(n=>n.text===goal.outcome)!.id);
  expect(changes.upserts.some(n=>n.text===revised.outcome)).toBe(true);
 });
 it('uses an allowlisted native Neo4j relationship type',()=>{expect(relationFor('motivation')).toBe('MOTIVATED_BY');expect(()=>relationFor('UNTRUSTED' as never)).toThrow();});
});
