import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {startLocalBridge} from '../../src/desktop/local-bridge.mjs';
import {callLocalBridge} from '../../src/bridge/client.mjs';
test('stdio subprocess negotiates, calls real fixture HTTP bridge and stops on EOF',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mcp-migango-'));
 const descriptorPath=path.join(root,'connection.json');
 const bridge=await startLocalBridge({descriptorPath,handle:async(method)=>({method,fixture:true})});
 const child=spawn(process.execPath,[path.resolve('scripts/mcp-migango.mjs'),'--discovery',descriptorPath],{windowsHide:true,stdio:['pipe','pipe','pipe']});
 t.after(async()=>{child.kill();await bridge.close();await fs.rm(root,{recursive:true,force:true});});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});
 child.stdin.end([
  {jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},
  {jsonrpc:'2.0',method:'notifications/initialized'},
  {jsonrpc:'2.0',id:2,method:'tools/list'},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'migango_status',arguments:{}}},
  {jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'migango_status',arguments:{key:'forbidden'}}},
 ].map(x=>JSON.stringify(x)).join('\n')+'\n');
 assert.equal(await closed,0);assert.equal(err,'');
 const messages=out.trim().split('\n').map(s=>JSON.parse(s));assert.equal(messages.length,4);
 assert.equal(messages[0].result.protocolVersion,'2025-06-18');
 assert.equal(messages[1].result.tools.length,7);
 assert.equal(JSON.parse(messages[2].result.content[0].text).method,'status');
 assert.equal(messages[3].result.isError,true);
 const d=JSON.parse(await fs.readFile(descriptorPath,'utf8'));assert(!out.includes(d.token));
 await fs.writeFile(descriptorPath,JSON.stringify({...d,host:'example.invalid'}));
 await assert.rejects(callLocalBridge(descriptorPath,'status'),/Invalid local/);
 await fs.writeFile(descriptorPath,JSON.stringify(d));
});
