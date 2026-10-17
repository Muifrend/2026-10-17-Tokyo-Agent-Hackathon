import {_electron as electron}from'playwright';
import path from'node:path';
import {writeFile,mkdir}from'node:fs/promises';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const desktop=await electron.launch({executablePath:path.resolve('out/Goal Coach-darwin-arm64/Goal Coach.app/Contents/MacOS/goal-coach'),env,cwd:process.cwd(),timeout:30000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let page,before=new Set();
const get=()=>page.evaluate(()=>window.coach.getState());
async function until(predicate,timeout=60000){const start=Date.now();while(Date.now()-start<timeout){const s=await get();if(predicate(s))return s;if(s.notice)throw new Error(s.notice);await sleep(250);}throw new Error('UI state timed out');}
async function saveIds(){if(!page)return;const s=await get();const ids=[...s.goals,...s.conversations,...s.messages,...s.goalDetails,...(s.session?[s.session]:[])].map(x=>x.id).filter(id=>!before.has(id));await writeFile('artifacts/focus-check-ids.json',JSON.stringify(ids));}
try{
 page=await desktop.firstWindow();page.on('pageerror',e=>console.log('Renderer error:',e.message));await page.waitForFunction(()=>!!window.coach);
 const baseline=await until(s=>s.ready);before=new Set([...baseline.goals,...baseline.conversations,...baseline.messages,...baseline.goalDetails,...(baseline.session?[baseline.session]:[])].map(x=>x.id));await mkdir('artifacts',{recursive:true});
 await page.getByRole('heading',{name:'Goals',exact:true}).waitFor();await page.getByRole('heading',{name:'Brainstorms',exact:true}).waitFor();
 if(await page.getByRole('button',{name:'Goals',exact:true}).count())throw new Error('Goals header should not navigate');
 await page.getByRole('button',{name:'New chat',exact:true}).click();
 await page.getByRole('textbox',{name:'Message'}).fill('I want to finish a 500-word Tokyo history essay today. Why: preserve our family memories. Subgoal: gather reliable sources. Action under that subgoal: read the museum guide. Obstacle: limited research time. Success is a finished 500-word essay. On track is writing or historical research. Distractions are unrelated videos and phone scrolling.');await page.getByRole('button',{name:'Send',exact:true}).click();
 let s=await until(s=>s.goals.some(g=>!before.has(g.id))&&s.messages.some(m=>m.role==='assistant'&&!before.has(m.id)));await saveIds();
 const goal=s.goals.find(g=>!before.has(g.id));if(!goal.ready)throw new Error('Explicit criteria did not produce a ready goal');
 await page.locator('.goals-section').getByRole('button',{name:goal.title,exact:true}).click();await page.getByRole('dialog',{name:'Start focus session'}).waitFor();await page.getByRole('button',{name:'Continue',exact:true}).click();await page.getByTestId('goal-graph').waitFor({timeout:60000});await saveIds();
 const count=await page.locator('.react-flow__node').count();if(count<7)throw new Error('Rich graph missing nodes');if(await page.getByRole('textbox',{name:'Message'}).count())throw new Error('Goal graph should not show chat composer');
 await page.getByRole('heading',{name:'Goals',exact:true}).waitFor();await page.getByRole('heading',{name:'Brainstorms',exact:true}).waitFor();
 await sleep(500);await page.screenshot({path:'artifacts/goal-graph.png'});
 s=await get();if(s.session?.status==='active')await page.getByRole('button',{name:'Pause session'}).click();
 console.log('Permanent sidebar headings, permission flow, and interactive goal graph passed.');
 await page.getByRole('button',{name:'New chat',exact:true}).click();await page.getByRole('button',{name:'Add to goal',exact:true}).click();await page.getByRole('menuitem',{name:goal.title,exact:true}).click();
 await until(s=>s.conversations.some(c=>c.kind==='brainstorm'&&c.goalId===goal.id));
 await page.getByRole('textbox',{name:'Message'}).fill('Add one action to this goal: draft the introduction on Sunday. Keep the existing goal and all existing facts.');await page.getByRole('button',{name:'Send',exact:true}).click();
 s=await until(s=>s.goalDetails.some(n=>n.goalId===goal.id&&n.kind==='action'&&/intro/i.test(n.text)));await saveIds();
 if(s.goals.filter(g=>!before.has(g.id)).length!==1)throw new Error('Refinement duplicated the goal');
 await page.locator('.reply-pending').waitFor({state:'hidden'});
 await page.screenshot({path:'artifacts/goal-context.png'});
 await page.locator('.goals-section').getByRole('button',{name:goal.title,exact:true}).click();await page.getByTestId('goal-graph').waitFor();
 if(!await page.getByTestId('goal-graph').getByText(/intro/i).count())throw new Error('Graph did not reflect refinement');
 await page.evaluate(()=>window.coach.stop());console.log('Chat + context refined the same persistent graph without creating another goal.');
}finally{await saveIds().catch(()=>{});await desktop.close();}
