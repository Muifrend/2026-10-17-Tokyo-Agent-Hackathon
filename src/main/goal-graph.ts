import { randomUUID } from 'node:crypto';
import type { Goal, GoalDraft, GoalDetail, GoalDetailDraft, GraphChanges, GoalDetailKind } from '../shared/types';

const relations = {subgoal:'HAS_SUBGOAL',action:'REQUIRES_ACTION',motivation:'MOTIVATED_BY',obstacle:'FACES_OBSTACLE',success_criterion:'SUCCESS_WHEN',distraction:'DISTRACTED_BY'} as const;
export function relationFor(kind:GoalDetailKind) {if(!Object.hasOwn(relations,kind))throw new Error('Invalid goal detail kind');return relations[kind];}
const norm=(text:string)=>text.trim().replace(/\s+/g,' ').toLowerCase();
const factKey=(kind:GoalDetailKind,text:string)=>kind+'|'+norm(text);
const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
function goalFor(draft:GoalDraft,goals:Goal[]) {
 const goal=draft.id?goals.find(g=>g.id===draft.id):goals.find(g=>norm(g.title)===norm(draft.title));
 if(!goal)throw new Error('Unknown goal in graph update');return goal;
}
function patchGoal(goal:Goal,draft:GoalDraft,existing:GoalDetail[],sourceMessageId:string|null,previousGoal?:Goal):GraphChanges {
 const before=new Map(existing.filter(n=>n.goalId===goal.id).map(n=>[n.id,n]));
 const working=new Map([...before].map(([id,n])=>[id,{...n}]));
 const removed=new Set(draft.removeDetailIds??[]);
 if(previousGoal){
  const criteria=(g:Goal)=>new Set([factKey('success_criterion',g.outcome),...g.onTrack.map(t=>factKey('success_criterion',t)),...g.offTrack.map(t=>factKey('distraction',t))]);
  const oldFacts=criteria(previousGoal),newFacts=criteria(goal);
  for(const n of before.values())if(oldFacts.has(factKey(n.kind,n.text))&&!newFacts.has(factKey(n.kind,n.text))&&!draft.details?.some(d=>d.key===n.id))removed.add(n.id);
 }
 for(const id of removed){if(!before.has(id))throw new Error('Cannot remove an unknown or unrelated goal detail');working.delete(id);}
 const details=draft.details??[];
 if(details.length>30)throw new Error('Too many goal details in one reply');
 const keyToId=new Map([...working.keys()].map(id=>[id,id]));
 const byText=new Map([...working.values()].map(n=>[factKey(n.kind,n.text),n.id]));
 const seenKeys=new Set<string>();
 const now=new Date().toISOString();
 for(const d of details){
  if(!d.key||d.key.length>80||seenKeys.has(d.key))throw new Error('Invalid or duplicate goal detail key');
  if(!Object.hasOwn(relations,d.kind)||!d.text.trim()||d.text.length>1000)throw new Error('Invalid goal detail');
  seenKeys.add(d.key);
  if(!working.has(d.key)&&(existing.some(n=>n.id===d.key)||uuid.test(d.key)))throw new Error('Unknown or unrelated goal detail key');
  const keyed=working.get(d.key);
  const sameId=byText.get(factKey(d.kind,d.text));
  if(keyed&&sameId&&sameId!==keyed.id)throw new Error('A matching goal detail already exists');
  const id=keyed?.id??sameId??randomUUID();
  const previous=working.get(id);
  if(previous)byText.delete(factKey(previous.kind,previous.text));
  working.set(id,{id,goalId:goal.id,kind:d.kind,text:d.text.trim(),parentId:previous?.parentId??null,sourceMessageId:previous?.sourceMessageId??sourceMessageId,createdAt:previous?.createdAt??now,updatedAt:previous?.updatedAt??now});
  keyToId.set(d.key,id);byText.set(factKey(d.kind,d.text),id);
 }
 const assignedParents=new Map<string,string|null>();
 for(const d of details){
  const id=keyToId.get(d.key)!;
  const parentId=d.parentKey===null?null:keyToId.get(d.parentKey);
  if(parentId===undefined)throw new Error('Unknown or unrelated parent in goal graph');
  if(parentId===id)throw new Error('A goal detail cannot parent itself');
  if(parentId&&working.get(parentId)?.kind!=='subgoal')throw new Error('Goal detail parent must be a subgoal');
  if(assignedParents.has(id)&&assignedParents.get(id)!==parentId)throw new Error('Conflicting parents for the same fact');
  assignedParents.set(id,parentId);working.get(id)!.parentId=parentId;
 }
 // Authoritative legacy fields also become native, connected criterion nodes.
 const criteria:Array<[GoalDetailKind,string]>=[['success_criterion',goal.outcome],...goal.onTrack.map(t=>['success_criterion',t] as [GoalDetailKind,string]),...goal.offTrack.map(t=>['distraction',t] as [GoalDetailKind,string])];
 const removedFacts=new Set([...removed].map(id=>{const n=before.get(id)!;return factKey(n.kind,n.text);}));
 for(const [kind,text]of criteria){
  if(!text.trim())continue;
  const key=factKey(kind,text);
  if(byText.has(key)||removedFacts.has(key))continue;
  const id=randomUUID();working.set(id,{id,goalId:goal.id,kind,text:text.trim(),parentId:null,sourceMessageId,createdAt:now,updatedAt:now});byText.set(key,id);
 }
 for(const n of working.values())if(n.parentId&&removed.has(n.parentId))n.parentId=null;
 for(const n of working.values()){
  const seen=new Set([n.id]);let parent=n.parentId;
  while(parent){
   if(seen.has(parent))throw new Error('Goal graph parent cycle');seen.add(parent);
   const node=working.get(parent);if(!node||node.kind!=='subgoal')throw new Error('Invalid goal graph parent');parent=node.parentId;
  }
 }
 const upserts:GoalDetail[]=[];
 for(const n of working.values()){
  const old=before.get(n.id);
  if(!old||old.text!==n.text||old.kind!==n.kind||old.parentId!==n.parentId)upserts.push({...n,sourceMessageId,updatedAt:now});
 }
 return {upserts,removeIds:[...removed]};
}
export function materializeGoalGraph(drafts:GoalDraft[],goals:Goal[],existing:GoalDetail[],sourceMessageId:string|null,previousGoals:Goal[]=goals):GraphChanges {
 let current=[...existing];const upserts=new Map<string,GoalDetail>();const removeIds=new Set<string>();
 for(const draft of drafts){
  const target=goalFor(draft,goals);
  const patch=patchGoal(target,draft,current,sourceMessageId,previousGoals.find(g=>g.id===target.id));
  for(const id of patch.removeIds){removeIds.add(id);upserts.delete(id);}
  for(const n of patch.upserts){upserts.set(n.id,n);removeIds.delete(n.id);}
  const changed=new Set([...patch.removeIds,...patch.upserts.map(n=>n.id)]);
  current=[...current.filter(n=>!changed.has(n.id)),...patch.upserts];
 }
 return {upserts:[...upserts.values()],removeIds:[...removeIds]};
}
export function backfillGoalGraph(goals:Goal[],existing:GoalDetail[]):GraphChanges {
 return materializeGoalGraph(goals.map(g=>({id:g.id,title:g.title,outcome:g.outcome,onTrack:g.onTrack,offTrack:g.offTrack,details:[]})),goals,existing,null);
}
