import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AgentRuntime} from '../../src/agents/runtime.mjs';
import {analyseTask,planTask} from '../../src/core/adaptive-routing.mjs';
import {invokeModel} from '../../src/core/providers.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const profiles=[{id:'kimi',provider:'kimi',model:'kimi-k2.6',credentialId:'kimi',capabilities:['text','tools','code']},
 {id:'opus',provider:'anthropic',model:'claude-opus-5-5',credentialId:'anthropic',capabilities:['text','tools','code']}];
const settings={autoRouting:true,active:'anthropic',profiles:{anthropic:{model:'claude-opus-5-5'}},
 modelRegistry:profiles,adaptiveRouting:{version:1,enabled:true,models:{low:'kimi',medium:'kimi',high:'opus'}},maxTurns:3,internalMemory:false};
const response=(calls=[])=>({text:calls.length?'':'done',calls,finishReason:'completed',stopDetail:null,
 usage:{input:10,output:5,cached:0},message:{role:'assistant',content:'done',calls}});
test('runtime routes low task to Kimi, records actor/effort and applies host output cap',async()=>{
 const seen=[];let saved;const store={settings,keys:{kimi:'fixture',anthropic:'fixture'},redact:s=>s,saveRun:async run=>{saved=structuredClone(run)}};
 const r=new AgentRuntime({store,tools:{workspace:{root:'/fixture'}},emit:()=>{},provider:async req=>{seen.push(req);return response()}});
 await r.start({prompt:'Halo apa kabar',mode:'ask'});const run=saved;
 assert.equal(seen[0].profile.id,'kimi');assert.equal(seen[0].effort.level,'low');assert.equal(seen[0].maxOutput,1024);
 assert.equal(run.agent.id,'migan');assert.equal(run.routingPlan.level,'low');
});
test('catalog agent tool allowlist survives discover_tools and model cannot execute a forbidden write',async()=>{
 let writes=0,calls=0;
 const a={id:'reader',nama:'Reader',persona:'Read only',rute:['research'],profilModel:'kimi',izinTool:['discover_tools','read_file'],jenis:'tetap'};
 let saved;const store={settings,keys:{kimi:'fixture',anthropic:'fixture'},redact:s=>s,saveRun:async run=>{saved=structuredClone(run)}};
 const r=new AgentRuntime({store,catalog:{list:()=>[a]},tools:{workspace:{root:'/fixture'},execute:async c=>{if(c.name==='write_file')writes++;return {ok:true}}},emit:()=>{},
  provider:async()=>++calls===1?response([{id:'c1',name:'discover_tools',args:{group:'terminal'}}]):response([{id:'c2',name:'write_file',args:{path:'x',content:'no'}}])});
 await r.start({prompt:'Riset sumber proyek',mode:'work'});const run=saved;
 assert.equal(run.agent.id,'reader');assert.equal(run.status,'failed');assert.match(run.error,/unavailable/);assert.equal(writes,0);
});
test('risk cannot be downgraded by typed model advice, nine routes remain and visual stays gated',()=>{
 const plan=planTask({prompt:'Audit keamanan pembayaran produksi',settings,suggestion:{route:'summary',level:'low',confidence:1,abstain:false}});
 assert.equal(plan.level,'high');assert.equal(plan.profile.id,'opus');assert.equal(plan.critical,true);
 for(const route of ['conversation','summary','research','coding','debugging','planning','creative','visual','review']) assert.equal(analyseTask('fixture',route).route,route);
 assert.throws(()=>planTask({prompt:'gambar',settings}),/Visual route requires/);
 assert.throws(()=>planTask({prompt:'halo',settings,suggestion:{route:'summary',level:'low',confidence:1,abstain:false,modelId:'opus'}}),/Invalid/);
});
test('provider request applies supported effort, no fabricated native control on unknown models',async()=>{
 for(const [profile,level] of [[profiles[0],'low'],[profiles[1],'high']]){
  let body;await invokeModel({profile,key:'fixture',system:'s',messages:[],tools:[],signal:new AbortController().signal,effort:{level},
   fetchImpl:async(_,init)=>{body=JSON.parse(init.body);return profile.provider==='kimi'?Response.json({model:profile.model,choices:[{finish_reason:'stop',message:{content:'done'}}]}):Response.json({model:profile.model,content:[{type:'text',text:'done'}],stop_reason:'end_turn'});}});
  if(profile.provider==='kimi')assert.equal(body.thinking.type,'disabled');else assert.equal(body.output_config.effort,'high');
 }
});
test('two build starts racing asynchronous target validation cannot create two runtime jobs',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mg-runtime-race-'));
 const activeRoot=await fs.mkdtemp(path.join(os.tmpdir(),'mg-runtime-active-'));
 t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(activeRoot,{recursive:true,force:true})]));
 let calls=0;const store={settings,keys:{kimi:'fixture',anthropic:'fixture'},redact:s=>s,saveRun:async()=>{}};
 const r=new AgentRuntime({store,tools:{workspace:{root}},emit:()=>{},provider:async()=>{calls++;return response()}});
 const args={prompt:'Implementasikan fungsi baru',mode:'build',target:{kind:'new',root,activeRoot,confirmedByOwner:false}};
 const first=r.start(args),second=r.start(args);
 await assert.rejects(second,/already running|task is running/i);
 await first;assert.equal(calls,1);
});
test('Kimi interrupted tool calls are not executed or replayed, native context survives continuation',async()=>{
 let calls=0,writes=0;const store={settings,keys:{kimi:'fixture',anthropic:'fixture'},redact:s=>s,saveRun:async()=>{}};
 const r=new AgentRuntime({store,tools:{workspace:{root:'/fixture'},execute:async()=>{writes++;}},emit:()=>{},provider:async req=>{
  if(++calls===1)return {...response(),text:'partial',finishReason:'incomplete',stopDetail:'length',
   calls:[{id:'incomplete',name:'write_file',args:{}}],message:{role:'assistant',content:'partial',calls:[],native:{kimi:{role:'assistant',content:'partial',reasoning_content:'fixture context',tool_calls:[{id:'incomplete'}]}}}};
  const previous=req.messages.find(m=>m.role==='assistant');assert.equal(previous.native.kimi.reasoning_content,'fixture context');
  assert.equal(previous.native.kimi.tool_calls,undefined);return response();
 }});
 const result=await r.start({prompt:'Implementasikan fungsi baru',mode:'work'});
 assert.equal(result.status,'needs-validation');assert.equal(calls,2);assert.equal(writes,0);
});
