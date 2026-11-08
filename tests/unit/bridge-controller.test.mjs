import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBridgeController} from '../../src/desktop/bridge-controller.mjs';
test('result projection, expired and secret approvals, Stop and failed-start retry are bounded',async()=>{
 let root='/owned', clock=1000, starts=0, stopped=0, resolved=0;
 const runId=randomUUID();
 const ctl=createBridgeController({workspace:()=>root,now:()=>clock,status:()=>({}),
   start:()=>{starts++},stop:()=>stopped++,resolveApproval:()=>{resolved++;return true;},
   redact:s=>s.replaceAll('fixture-secret','[REDACTED]'),
   loadRun:async()=>({id:runId,status:'done',workspace:'/owned',final:'fixture-secret safe result',
     keys:{private:'fixture-secret'},events:[{raw:'private'}],profile:{model:'fixture',provider:'kimi',credentialId:'private'}})});
 const requestId=randomUUID();const op=await ctl.execute('start',{requestId,expectedWorkspace:root,prompt:'fixture task',mode:'work',modelId:'kimi'});
 ctl.observe({type:'start',id:runId});
 const result=await ctl.execute('result',{operationId:op.operationId});
 assert.equal(result.run.final,'[REDACTED] safe result');
 assert.equal(Object.hasOwn(result.run,'keys'),false);assert.equal(Object.hasOwn(result.run,'events'),false);
 assert.equal(Object.hasOwn(result.run.profile,'credentialId'),false);
 ctl.observe({type:'approval',id:'secret',tool:'write_file',args:{path:'a',content:'fixture-secret'},expiresAt:2000});
 const [pending]=await ctl.execute('approvals');assert.equal(pending.approvable,false);
 await assert.rejects(ctl.execute('decide',{id:'secret',digest:pending.digest,yes:true,expectedWorkspace:root}),/unredacted/);
 assert.equal(resolved,0);clock=2000;
 await assert.rejects(ctl.execute('decide',{id:'secret',digest:pending.digest,yes:false,expectedWorkspace:root}),/expired/);
 assert.deepEqual(await ctl.execute('approvals'),[]);
 root='/different';await assert.rejects(ctl.execute('result',{operationId:op.operationId}),/workspace/);
 root='/owned';await ctl.execute('stop',{operationId:op.operationId,expectedWorkspace:root});assert.equal(stopped,1);
 ctl.observe({type:'finish',runId,status:'cancelled'});
 assert.equal((await ctl.execute('operation',{operationId:op.operationId})).status,'cancelled');
 await ctl.execute('start',{requestId,expectedWorkspace:root,prompt:'fixture task',mode:'work',modelId:'kimi'});assert.equal(starts,1);
 await assert.rejects(ctl.execute('start',{requestId,expectedWorkspace:root,prompt:'fixture task',mode:'work',modelId:'opus'}),/requestId/);
 const failed=createBridgeController({workspace:()=>root,status:()=>({}),start:()=>{throw Error('busy')},stop:()=>{},loadRun:()=>{},resolveApproval:()=>{}});
 const p={requestId:randomUUID(),expectedWorkspace:root,prompt:'fixture task',mode:'work'};
 assert.equal((await failed.execute('start',p)).status,'failed');assert.equal((await failed.execute('start',p)).status,'failed');
});
