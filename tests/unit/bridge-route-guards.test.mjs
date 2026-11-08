import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { startLocalBridge } from '../../src/desktop/local-bridge.mjs';
import { fixture, reply } from './team-fixture.mjs';

// Markas, 27 Oct 2026: the bridge may name a task route (2800437) only while (1) the bridge listens
// on loopback alone and keeps requiring its token, (2) unknown routes are refused (bridge-route
// test + tests/mutation/bridge-route.mjs) and (3) dollars stay with the cost meter whatever the route.
const connects = (port, host) => new Promise((resolve) => {
  const s = net.connect({ port, host, timeout: 1500 });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  s.once('timeout', () => { s.destroy(); resolve(false); });
});

test('the bridge listens on loopback only: other interfaces of this machine refuse the port', async (t) => {
  const outer = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  if (!outer.length) return t.skip('no non-loopback IPv4 interface on this machine');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mg-loop-'));
  const descriptorPath = path.join(root, 'connection.json');
  const bridge = await startLocalBridge({ descriptorPath, handle: async () => ({}) });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true }); });
  const { port } = JSON.parse(await fs.readFile(descriptorPath, 'utf8'));
  assert.equal(await connects(port, '127.0.0.1'), true, 'loopback answers');
  for (const address of outer) assert.equal(await connects(port, address), false, address + ' must not answer');
});

test('a run with a named route still pays through the cost meter', async () => {
  const f = fixture({ settings: { internalMemory: false }, provider: async () => reply('Selesai.') });
  let metered = 0;
  f.runtime.meter = { call: (req, provider) => (metered++, provider(req)), report: async () => ({ providers: [] }) };
  await f.runtime.start({ prompt: 'Bangun modul OCR untuk screenshot', mode: 'work', routeOverride: 'coding' });
  assert.ok(metered >= 1, 'every model call went through the meter');
});

test('a meter refusal stops a routed run before any provider call', async () => {
  let sent = 0;
  const f = fixture({ settings: { internalMemory: false }, provider: async () => (sent++, reply('x')) });
  f.runtime.meter = {
    call: () => { throw Object.assign(new Error('Pagu biaya harian anthropic tercapai'), { code: 'ERR_COST_CAP' }); },
    report: async () => ({ providers: [] }),
  };
  await f.runtime.start({ prompt: 'Bangun modul OCR', mode: 'work', routeOverride: 'coding' }).catch(() => {});
  assert.equal(sent, 0);
  assert.equal(f.parent().status, 'failed');
  assert.match(f.parent().error, /Pagu/);
});
