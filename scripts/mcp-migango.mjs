// Local stdio MCP. stdout contains protocol messages only; never print connection capabilities.
import path from 'node:path';
import os from 'node:os';
import {createMcpHandler} from '../src/bridge/mcp.mjs';
import {callLocalBridge} from '../src/bridge/client.mjs';
const arg = process.argv.indexOf('--discovery');
const descriptor = arg >= 0 ? process.argv[arg + 1] :
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming'),
    'migan-workbench/local-bridge/connection.json');
if (!descriptor || !path.isAbsolute(descriptor)) throw Error('An absolute discovery file path is required');
const handle = createMcpHandler({call:(method, params) => callLocalBridge(descriptor,method,params)});
let buffered = '', chain = Promise.resolve();
const output = value => { if (value) process.stdout.write(JSON.stringify(value) + '\n'); };
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffered += chunk;
  for (;;) {
    const at = buffered.indexOf('\n');
    if (at < 0) break;
    const line = buffered.slice(0,at); buffered = buffered.slice(at+1);
    if (Buffer.byteLength(line) > 131072) { process.stderr.write('MCP input limit exceeded\n'); process.exitCode = 1; process.stdin.destroy(); return; }
    chain = chain.then(async () => {
      try { output(await handle(JSON.parse(line))); }
      catch { output({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}}); }
    });
  }
  if (Buffer.byteLength(buffered) > 131072) { process.stderr.write('MCP input limit exceeded\n'); process.exitCode = 1; process.stdin.destroy(); }
});
process.stdin.on('end', () => { void chain.then(() => { if (buffered.trim()) process.stderr.write('Incomplete MCP frame\n'); }); });
