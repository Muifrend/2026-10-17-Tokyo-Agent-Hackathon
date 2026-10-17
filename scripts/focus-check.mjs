import { _electron as electron } from 'playwright';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
const launchEnv={...process.env};delete launchEnv.ELECTRON_RUN_AS_NODE;
const desktop=await electron.launch({executablePath:path.resolve('out/Goal Coach-darwin-arm64/Goal Coach.app/Contents/MacOS/goal-coach'),env:launchEnv,cwd:process.cwd(),timeout:30000});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let checkIds=[];
async function state(page){return await page.evaluate(()=>window.coach.getState());}
try{
 const page=await desktop.firstWindow();
 await page.waitForFunction(()=>!!window.coach);
 let s;
 for(let i=0;i<150;i++){s=await state(page);if(s.ready||s.notice)break;await sleep(200);}
 if(!s.ready)throw new Error('Desktop not ready');
 const beforeIds=[...s.conversations,...s.goals,...s.messages].map(x=>x.id);
 await page.getByRole('button',{name:'New chat',exact:true}).click();
 await page.locator('h1').waitFor();
 await page.getByRole('textbox',{name:'Message'}).fill('My goal is to verify the Goal Coach desktop app. Success is a working five-minute focus session. On track: reviewing code, checking the app, writing implementation notes, or terminal work. Off track: unrelated videos, social media, or unrelated phone use. These criteria are complete.');
 await page.getByRole('button',{name:'Send',exact:true}).click();
 for(let i=0;i<180;i++){s=await state(page);if(s.goals.some(g=>!beforeIds.includes(g.id)))break;if(s.notice)throw new Error(s.notice);await sleep(250);}
 const goal=s.goals.find(g=>!beforeIds.includes(g.id));
 checkIds=[...s.conversations,...s.goals,...s.messages].filter(x=>!beforeIds.includes(x.id)).map(x=>x.id);
 await writeFile('artifacts/focus-check-ids.json',JSON.stringify(checkIds));
 if(!goal?.ready)throw new Error('Interview did not produce a ready goal');
 if(s.messages.filter(m=>m.role==='user'&&!beforeIds.includes(m.id)).length!==1)throw new Error('User message duplicated');
 console.log('Live GUI interview, goal extraction, and sidebar persistence passed.');
 await page.getByRole('button',{name:'Goals',exact:true}).click();
 await page.getByRole('button',{name:goal.title,exact:true}).click();
 console.log('Screen permission/picker requested.');
 await page.getByRole('dialog',{name:'Start focus session'}).waitFor({timeout:90000});
 await page.getByRole('button',{name:'Continue',exact:true}).click();
 let last='';
 for(let i=0;i<360;i++){
  s=await state(page);
  if(s.session?.status==='active')break;
  const status=s.notice||s.session?.pauseReason||'Starting capture';
  if(status!==last){console.log(status);last=status;}
  if(s.notice&&s.session?.status==='paused'){
   console.log('Permission state:',await desktop.evaluate(({systemPreferences})=>({screen:systemPreferences.getMediaAccessStatus('screen'),camera:systemPreferences.getMediaAccessStatus('camera')})));
   throw new Error('Live capture needs macOS permissions');
  }
  await sleep(250);
 }
 if(s.session?.status!=='active')throw new Error('Focus did not start');
 checkIds.push(s.session.id);await writeFile('artifacts/focus-check-ids.json',JSON.stringify(checkIds));
 console.log('Real screen and webcam capture started. Beginning five-minute minimized check.');
 await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.isVisible())?.minimize());
 for(let minute=1;minute<=5;minute++){
  await sleep(60000);s=await state(page);
  if(s.session?.status!=='active')throw new Error('Background focus paused: '+(s.notice||s.session?.pauseReason));
  console.log('Background capture active at minute '+minute+'.');
 }
 await page.evaluate(()=>window.coach.pause());
 s=await state(page);if(s.session?.status!=='paused')throw new Error('Pause failed');
 const windows=await desktop.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().length);
 if(windows!==1)throw new Error('Camera window remained after pause');
 console.log('Five-minute background session passed; pause released camera window.');
 await page.evaluate(()=>window.coach.stop());
 await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.restore();w.focus();});
 await page.screenshot({path:'artifacts/focus-session.png'});
}finally{
 await desktop.close();
}
