/** Built-UI smoke check with synthetic sessions; run after npm run build. */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const dir = mkdtempSync(join(tmpdir(), 'aw-ui-'));
const checks = "\nconst failures=[];const pass=[];const assert=(ok,msg)=>{(ok?pass:failures).push(msg)};\nconst emit=(body)=>window.dispatchEvent(new MessageEvent('message',{data:{pane:'conversation',body}}));\nconst session={key:'claude:test',sessionId:'test',provider:'claude',title:'Synthetic conversation',projectName:'Test',status:'waiting',lastActivityAt:Date.now()};\nconst caps={canSend:true,canInterrupt:false,canAdopt:true,canResumeHere:false,canRelease:false,estimated:false,adoptOnSend:true,sendHint:'Send takes over here'};\nconst init=(key=session.key)=>emit({type:'init',session:{...session,key},caps,truncated:true,blocks:[{kind:'tool',id:'t:tool',toolUseId:'tool1',name:'Read',inputPreview:'file',state:'done',result:{text:'short',truncated:true,isError:false}}]});\ntry{\ninit();\nassert(!document.getElementById('composerWrite').hidden,'external composer visible');\nconst msg=document.getElementById('msg');msg.value='keep my draft';document.getElementById('send').click();\nconst sent=posts.findLast(x=>x.body.type==='send').body;assert(sent.sessionKey==='claude:test','send scoped to conversation');\nassert(msg.value==='keep my draft','draft retained until acknowledgement');\ndocument.getElementById('send').click();assert(posts.at(-1).body.type==='cancelSend','queued send cancels');\nemit({type:'sendResult',requestId:sent.requestId,error:'Cancelled'});assert(msg.value==='keep my draft'&&!msg.readOnly,'failed send restores editable draft');\ndocument.getElementById('send').click();const next=posts.findLast(x=>x.body.type==='send').body;emit({type:'sendResult',requestId:next.requestId});assert(msg.value==='','successful send clears draft');\nconst more=document.querySelector('[data-id=\"t:tool\"] .showmore');more.click();assert(posts.at(-1).body.toolUseId==='tool1','tool expansion carries original tool id');\nemit({type:'blockText',id:'t:tool',text:'full output'});assert(document.querySelector('[data-id=\"t:tool\"]').textContent.includes('full output'),'full tool text rendered');\ndocument.getElementById('notch').click();const history=posts.at(-1).body;assert(history.before==='t:tool','history pages before visible transcript');\nemit({type:'archive',requestId:history.requestId,blocks:[{kind:'user',id:'t:old',text:'earlier'}],more:false,query:''});assert(document.getElementById('blocks').firstElementChild.dataset.id==='t:old','history prepended');\nmsg.value='session A draft';init('claude:other');assert(msg.value==='','switch does not leak draft');init();assert(msg.value==='session A draft','switch back restores draft');\nemit({type:'composer',composer:{permissionMode:'default',slashCommands:['compact'],busy:false,queued:0,costUsd:0.12,contextTokens:100,contextWindow:1000}});msg.value='/c';msg.dispatchEvent(new Event('input'));assert(!document.getElementById('slashcommands').hidden,'slash autocomplete opens');assert(document.getElementById('sessionusage').textContent.includes('$0.120'),'cost displayed');\n}catch(e){failures.push(e.stack)}\nconst result=document.createElement('pre');result.id='results';result.textContent=JSON.stringify({pass,failures});document.body.appendChild(result);\n";
const html = `<html><head><style>${readFileSync('dist/webview/conversation.css', 'utf8')}</style></head><body><div id="convApp"></div><script>const posts=[];let saved={};window.acquireVsCodeApi=()=>({postMessage:m=>posts.push(m),getState:()=>saved,setState:s=>saved=s});</script><script src="file://${resolve('dist/webview/conversation.js')}"></script><script>${checks}</script></body></html>`;
writeFileSync(join(dir, 'index.html'), html);
const child = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', `--user-data-dir=${join(dir, 'profile')}`, '--remote-debugging-port=0', `file://${join(dir, 'index.html')}`]);
let socket: WebSocket | undefined;
try {
  const endpoint = await new Promise<string>((resolveEndpoint, reject) => {
    const timeout = setTimeout(() => reject(new Error('Chrome did not start')), 15000);
    let stderr = '';
    child.once('error', reject);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const found = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (found) { clearTimeout(timeout); resolveEndpoint(found[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolveOpen, reject) => { socket!.onopen = () => resolveOpen(); socket!.onerror = reject; });
  let seq = 0;
  const request = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolveCall, reject) => {
    const id = ++seq;
    const timeout = setTimeout(() => { socket!.removeEventListener('message', listener); reject(new Error(`Timed out: ${method}`)); }, 10000);
    const listener = (event: MessageEvent) => { const result = JSON.parse(String(event.data)); if (result.id !== id) return; clearTimeout(timeout); socket!.removeEventListener('message', listener); result.error ? reject(new Error(JSON.stringify(result.error))) : resolveCall(result.result); };
    socket!.addEventListener('message', listener);
    socket!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetInfos } = await request('Target.getTargets');
  const target = targetInfos.find((t: any) => t.type === 'page');
  const { sessionId } = await request('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  const result = await request('Runtime.evaluate', { expression: `new Promise(resolve => { const check = () => { const el = document.getElementById('results'); if (el) resolve(el.textContent); else setTimeout(check, 20); }; check(); })`, awaitPromise: true, returnByValue: true }, sessionId);
  const outcome = JSON.parse(result.result.value);
  console.log(JSON.stringify(outcome, null, 2));
  if (outcome.failures.length) process.exitCode = 1;
  await request('Browser.close');
} finally {
  socket?.close(); child.kill();
  // Chrome may still be flushing its isolated profile; leave it if cleanup races shutdown.
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temporary profile only */ }
}
