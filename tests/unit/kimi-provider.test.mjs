import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invokeModel} from '../../src/core/providers.mjs';
import {validateRegistry} from '../../src/core/model-registry.mjs';
import {chooseRoute} from '../../src/core/router.mjs';
import {Store} from '../../src/core/storage.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const signal = new AbortController().signal;
const base = {profile:{provider:'kimi',model:'fixture-kimi',baseURL:'https://attacker.invalid'},key:'fixture-secret',
 system:'Coding task', messages:[{role:'user',content:'read the file'}],tools:[],signal};
test('Kimi keeps a distinct credential binding and works in manual/registry routing',()=>{
 const [profile]=validateRegistry([{id:'kimi',provider:'kimi',model:'fixture-kimi',credentialId:'kimi',capabilities:['text','tools','code']}]);
 assert.equal(profile.provider,'kimi');
 assert.equal(chooseRoute({active:'kimi',profiles:{kimi:{model:'fixture-kimi'}}},'work').provider,'kimi');
});
test('existing three-provider settings reopen with the new Kimi default and can still be saved',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mg-legacy-settings-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const profiles={openai:{model:''},anthropic:{model:'fixture'},ollama:{model:'fixture',baseURL:'http://127.0.0.1'}};
 await fs.writeFile(path.join(root,'settings.json'),JSON.stringify({active:'anthropic',profiles}));
 const store=new Store(root,{isEncryptionAvailable:()=>true});await store.init();
 assert.equal(store.publicSettings().profiles.kimi.model,'kimi-k2.6');
 await store.saveSettings({...store.settings,profiles});
 assert.equal(store.publicSettings().profiles.kimi.model,'kimi-k2.6');
});
test('Kimi uses only its official origin, converts tool history and preserves native reasoning in the next turn',async()=>{
 let captured;
 const first=await invokeModel({...base,tools:[{name:'read_file',description:'read',parameters:{type:'object'}}],fetchImpl:async(url,init)=>{
   captured={url,init,body:JSON.parse(init.body)};
   return Response.json({model:'fixture-kimi',choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
     reasoning_content:'fixture reasoning',tool_calls:[{id:'call-1',type:'function',function:{name:'read_file',arguments:'{"path":"a.txt"}'}}]}}],usage:{prompt_tokens:11,completion_tokens:4,prompt_tokens_details:{cached_tokens:3}}});
 }});
 assert.equal(captured.url,'https://api.moonshot.ai/v1/chat/completions');
 assert.equal(captured.init.redirect,'error');
 assert.equal(captured.init.headers.Authorization,'Bearer fixture-secret');
 assert.equal(captured.init.headers['User-Agent'],'miganGO/0.1.0');
 assert.equal(captured.body.messages[0].role,'system');
 assert.equal(first.calls[0].args.path,'a.txt');// prompt_tokens includes the 3 cached tokens (Kimi docs, 27 Oct): ordinary input is 8, not 11.
 assert.equal(first.usage.input,8);assert.equal(first.usage.cached,3);
 await invokeModel({...base,messages:[first.message,{role:'tool',callId:'call-1',name:'read_file',content:'ok'}],fetchImpl:async(_,init)=>{
   const m=JSON.parse(init.body).messages;
   assert.equal(m[1].reasoning_content,'fixture reasoning');assert.equal(m[1].tool_calls[0].id,'call-1');
   assert.equal(m[2].tool_call_id,'call-1');
   return Response.json({model:'fixture-kimi',choices:[{finish_reason:'stop',message:{role:'assistant',content:'done'}}],usage:{prompt_tokens:20,completion_tokens:5}});
 }});
});
test('Kimi output limit, invalid tools, model mismatch and reflected credentials fail safely',async()=>{
 const response=message=>async()=>Response.json(message);
 const limited=await invokeModel({...base,fetchImpl:response({model:'fixture-kimi',choices:[{finish_reason:'length',message:{content:'partial'}}]})});
 assert.equal(limited.finishReason,'incomplete');assert.equal(limited.stopDetail,'length');
 await assert.rejects(invokeModel({...base,fetchImpl:response({model:'other',choices:[]})}),/identity mismatch/);
 await assert.rejects(invokeModel({...base,fetchImpl:response({choices:[{message:{tool_calls:[{id:'c',function:{name:'x',arguments:'[]'}}]}}]})}),/Invalid tool arguments/);
 await assert.rejects(invokeModel({...base,fetchImpl:async()=>Response.json({error:{message:'echo fixture-secret'}},{status:401})}),e=>e.message.includes('[REDACTED]')&&!e.message.includes('fixture-secret'));
});
