import { _electron as electron } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const root=process.cwd();
const launchEnv={...process.env};delete launchEnv.ELECTRON_RUN_AS_NODE;
const desktop=await electron.launch({executablePath:path.join(root,'out/Goal Coach-darwin-arm64/Goal Coach.app/Contents/MacOS/goal-coach'),env:launchEnv,cwd:root,timeout:30000});
try{
 const page=await desktop.firstWindow();
 page.on('pageerror',e=>console.log('Renderer error:',e.message));
 await page.waitForFunction(()=>!!window.coach,{timeout:15000});
 let state;
 for(let attempt=0;attempt<150;attempt++){state=await page.evaluate(()=>window.coach.getState());if(state.ready||state.notice)break;await new Promise(r=>setTimeout(r,200));}
 console.log(JSON.stringify({ready:state.ready,notice:state.notice,goals:state.goals.length,conversations:state.conversations.length}));
 await mkdir('artifacts',{recursive:true});
 await page.screenshot({path:'artifacts/desktop.png'});
 if(!state.ready)throw new Error('App setup failed');
 if(process.argv.includes('--expect-saved')&&(!state.goals.length||!state.messages.some(m=>m.role==='user')))throw new Error('Restart persistence failed');
 if(process.argv.includes('--expect-saved'))console.log('Chats and goals survived a full app restart.');
 if(await page.locator('h1').innerText()!=='What goals are you trying to achieve?')throw new Error('Initial question missing');
 console.log('Packaged desktop launch, preload bridge, live connections, and initial UI passed.');
}finally{await desktop.close();}
