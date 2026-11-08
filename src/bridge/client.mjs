import fs from 'node:fs/promises';
import http from 'node:http';
export async function callLocalBridge(descriptorPath, method, params = {}) {
  let descriptor;
  try {
    const file = await fs.open(descriptorPath, 'r');
    try {
      if ((await file.stat()).size > 8192) throw Error('Invalid bridge descriptor');
      descriptor = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  } catch { throw Error('MiganGO bridge is unavailable. Start the bridge-enabled app in background mode.'); }
  const d = descriptor;
  if (d.version !== 1 || d.host !== '127.0.0.1' || !Number.isInteger(d.port) ||
      d.port < 1 || d.port > 65535 || !/^[a-f0-9]{64}$/.test(d.token || ''))
    throw Error('Invalid local bridge descriptor');
  const body = JSON.stringify({method, params});
  if (Buffer.byteLength(body) > 65536) throw Error('Bridge input exceeds 64 KiB');
  return new Promise((resolve, reject) => {
    const req = http.request({host:'127.0.0.1', port:d.port, path:'/v1/call', method:'POST',
      headers:{Authorization:'Bearer ' + d.token, 'Content-Type':'application/json',
        'Content-Length':Buffer.byteLength(body)}}, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 262144) { res.destroy(); reject(Error('Bridge output exceeds 256 KiB')); }
        else chunks.push(chunk);
      });
      res.on('error', () => reject(Error('Bridge response interrupted')));
      res.on('end', () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || !value.ok) throw Error(value.error || 'Bridge call rejected');
          resolve(value.data);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(6000, () => req.destroy(Error('Bridge timed out; inspect operation before retrying a start')));
    req.on('error', error => reject(error.code ? Error('MiganGO bridge connection failed; check app status') : error));
    req.end(body);
  });
}
