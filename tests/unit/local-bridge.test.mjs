import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {startLocalBridge} from '../../src/desktop/local-bridge.mjs';
import {callLocalBridge} from '../../src/bridge/client.mjs';
import {createBridgeController} from '../../src/desktop/bridge-controller.mjs';
test('loopback capability, Origin and body guards; client uses the app endpoint',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mg-bridge-test-'));
 const descriptorPath=path.join(root,'connection.json');
 const bridge=await startLocalBridge({descriptorPath,handle:async(method)=>({method,ok:true})});
 t.after(async()=>{await bridge.close();await fs.rm(root,{recursive:true,force:true});});
 const d=JSON.parse(await fs.readFile(descriptorPath,'utf8'));
 assert.equal(d.host,'127.0.0.1');
 const url='http://127.0.0.1:'+d.port+'/v1/call';
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+d.token,Origin:'https://example.invalid'},body:'{}'})).status,403);
 assert.equal((await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+d.token},body:'x'.repeat(65537)})).status,413);
 const result=await callLocalBridge(descriptorPath,'status',{});
 assert.equal(result.method,'status');
 await bridge.close();
 await assert.rejects(fs.access(descriptorPath));
});
test('controller has no credential/settings/OS operations and strips result keys',async()=>{
 const controller=createBridgeController({workspace:()=>'/owned',status:()=>({ready:true}),redact:s=>s.replaceAll('fixture-secret','[REDACTED]'),start:()=>{},stop:()=>true,loadRun:async()=>null,resolveApproval:()=>true});
 await assert.rejects(controller.execute('saveSettings',{}),/Unknown/);
 assert.deepEqual(await controller.execute('status',{}),{ready:true});
});
test('start idempotency, workspace and exact one-shot file approval',async()=>{
 let starts=0,resolved=0;
 // '/owned' stands for an isolated worktree here; the default check is tested below.
 const ctl=createBridgeController({workspace:()=>'/owned',status:()=>({}),redact:s=>s,start:()=>{starts++;},stop:()=>true,loadRun:async id=>({id,status:'done',workspace:'/owned',final:'result',keys:{forbidden:'fixture-secret'}}),resolveApproval:()=>{resolved++;return true;},canGrantWrites:()=>({ok:true})});
 const requestId=randomUUID(),args={requestId,expectedWorkspace:'/owned',prompt:'test fixture',mode:'work'};
 await ctl.execute('start',args);await ctl.execute('start',args);assert.equal(starts,1);
 await assert.rejects(ctl.execute('start',{...args,prompt:'changed'}),/requestId/);
 await assert.rejects(ctl.execute('start',{...args,requestId:randomUUID(),expectedWorkspace:'/other'}),/workspace/i);
 ctl.observe({type:'start',id:randomUUID()});
 const id=randomUUID();
 ctl.observe({type:'approval',id,tool:'write_file',args:{path:'result.txt',content:'ok',expectedHash:null},expiresAt:Date.now()+10000});
 const [p]=await ctl.execute('approvals',{});
 await assert.rejects(ctl.execute('decide',{id,digest:'wrong',yes:true,expectedWorkspace:'/owned'}),/digest/i);
 assert.equal(resolved,0);
 await ctl.execute('decide',{id,digest:p.digest,yes:true,expectedWorkspace:'/owned'});
 assert.equal(resolved,1);
 await assert.rejects(ctl.execute('decide',{id,digest:p.digest,yes:true,expectedWorkspace:'/owned'}),/pending/i);
 ctl.observe({type:'approval',id:'shell-1',tool:'shell',args:{command:'do not run'},expiresAt:Date.now()+10000});
 const [shell]=await ctl.execute('approvals',{});
 await assert.rejects(ctl.execute('decide',{id:shell.id,digest:shell.digest,yes:true,expectedWorkspace:'/owned'}),/file/i);
});
test('MCP handler exposes only bounded bridge tools and returns typed errors',async()=>{
 const {createMcpHandler}=await import('../../src/bridge/mcp.mjs');
 const handler=createMcpHandler({call:async(method)=>({method})});
 const before=await handler({jsonrpc:'2.0',id:0,method:'tools/list'});
 assert.equal(before.error.code,-32002);
 await handler({jsonrpc:'2.0',id:99,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}});
 const tools=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
 assert.equal(tools.result.tools.length,7);
 assert(!JSON.stringify(tools).includes('saveSettings'));
 const result=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'migango_status',arguments:{}}});
 assert.equal(JSON.parse(result.result.content[0].text).method,'status');
 const error=await handler({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'vault_get',arguments:{}}});
 assert.equal(error.result.isError,true);
});

// Markas (26 Oct 2026): bridge clients may grant file writes only in an isolated git worktree on
// a non-main branch; the server enforces it, not only the CLI. Rejecting is always allowed.
test('decide grants writes only in an isolated worktree; a plain folder can only reject', async () => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migango-decide-'));
  try {
    let resolved = [];
    const ctl = createBridgeController({workspace:()=>root,status:()=>({}),redact:s=>s,start:()=>{},stop:()=>true,loadRun:async()=>null,resolveApproval:(id,yes)=>{resolved.push([id,yes]);return true;}});
    await ctl.execute('start',{requestId:randomUUID(),expectedWorkspace:root,prompt:'tes uji',mode:'work'});
    ctl.observe({type:'start',id:randomUUID()});
    ctl.observe({type:'approval',id:'w1',tool:'write_file',args:{path:'a.txt',content:'x',expectedHash:null},expiresAt:Date.now()+10000});
    const [w] = await ctl.execute('approvals',{});
    await assert.rejects(ctl.execute('decide',{id:'w1',digest:w.digest,yes:true,expectedWorkspace:root}),/worktree/i);
    assert.deepEqual(resolved, []);
    await ctl.execute('decide',{id:'w1',digest:w.digest,yes:false,expectedWorkspace:root});
    assert.deepEqual(resolved, [['w1', false]]);
  } finally {
    await fs.rm(root,{recursive:true,force:true});
  }
});
