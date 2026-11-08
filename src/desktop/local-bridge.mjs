// Private app transport, not a public MCP HTTP endpoint. MCP uses the stdio adapter.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';

export async function startLocalBridge({descriptorPath, handle}) {
  const token = randomBytes(32).toString('hex');
  const instanceId = randomUUID();
  const server = http.createServer(async (req, res) => {
    const reply = (code, value) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      res.end(JSON.stringify(value));
    };
    if (req.headers.origin !== undefined) return reply(403, {error:'Browser Origin denied'});
    const auth = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer ' + token);
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected))
      return reply(401, {error:'Bridge authorization required'});
    if (req.headers.host !== '127.0.0.1:' + server.address().port)
      return reply(403, {error:'Invalid bridge host'});
    if (req.method !== 'POST' || req.url !== '/v1/call')
      return reply(404, {error:'Unknown bridge endpoint'});
    if (Number(req.headers['content-length']) > 65536) {
      req.resume(); return reply(413, {error:'Input exceeds 64 KiB'});
    }
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) { reply(413, {error:'Input exceeds 64 KiB'}); return; }
        chunks.push(chunk);
      }
      const message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof message.method !== 'string' || !message.params ||
          typeof message.params !== 'object' || Array.isArray(message.params))
        return reply(400, {error:'Expected method and params object'});
      const value = await handle(message.method, message.params);
      const output = JSON.stringify({ok:true, data:value});
      if (Buffer.byteLength(output) > 262144) return reply(413, {error:'Output exceeds 256 KiB'});
      res.writeHead(200, {'Content-Type':'application/json', 'Cache-Control':'no-store'});
      res.end(output);
    } catch (error) {
      // Only controller messages cross this boundary; never include a stack or request headers.
      reply(400, {ok:false, error:String(error.message).slice(0, 500)});
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  server.setTimeout(5000, socket => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    try {
      const current = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
      if (current.instanceId === instanceId) await fs.unlink(descriptorPath);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  try {
    await fs.mkdir(path.dirname(descriptorPath), {recursive:true, mode:0o700});
    const temp = descriptorPath + '.' + instanceId + '.tmp';
    try {
      await fs.writeFile(temp, JSON.stringify({version:1, host:'127.0.0.1',
        port:server.address().port, token, instanceId, pid:process.pid}), {mode:0o600, flag:'wx'});
      await fs.rename(temp, descriptorPath);
    } finally { await fs.rm(temp, {force:true}); }
  } catch (error) { await close(); throw error; }
  return {close};
}
