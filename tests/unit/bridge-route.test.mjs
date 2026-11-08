import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBridgeController } from '../../src/desktop/bridge-controller.mjs';

// 27 Oct 2026: a coding task about a screenshot/OCR module was refused at start ("Visual route
// requires an image/multimodal adapter") because the keyword rule matched "screenshot"/"vision"
// in the prompt. The bridge caller may now name the route; it goes to the runtime as the owner
// override that classifyTask already honours. Unknown routes are refused.
const abs = (p) => path.resolve(p);
function controller() {
  const starts = [];
  const ctl = createBridgeController({
    workspace: () => abs('/owned'), status: () => ({}), redact: (s) => s,
    start: (payload) => { starts.push(payload); },
    stop: () => true, loadRun: async () => null, resolveApproval: () => true,
    canGrantWrites: () => ({ ok: true }),
  });
  const start = (extra) => ctl.execute('start', { requestId: randomUUID(), expectedWorkspace: abs('/owned'), prompt: 'Bangun modul OCR untuk screenshot', mode: 'work', ...extra });
  return { ctl, starts, start };
}

test('a named route reaches the runtime as the owner override', async () => {
  const c = controller();
  await c.start({ route: 'coding' });
  assert.equal(c.starts[0].routeOverride, 'coding');
});

test('without a route the runtime classifies as before', async () => {
  const c = controller();
  await c.start({});
  assert.equal(Object.hasOwn(c.starts[0], 'routeOverride'), false);
});

test('an unknown or malformed route is refused before anything starts', async () => {
  for (const route of ['tidak-ada', '', 5, 'auto ', '__proto__']) {
    const c = controller();
    await assert.rejects(c.start({ route }), /route/i, String(route));
    assert.equal(c.starts.length, 0);
  }
});

test('the same requestId with a different route is not a replay', async () => {
  const c = controller();
  const requestId = randomUUID();
  const base = { requestId, expectedWorkspace: abs('/owned'), prompt: 'Bangun modul OCR', mode: 'work' };
  await c.ctl.execute('start', { ...base, route: 'coding' });
  await assert.rejects(c.ctl.execute('start', { ...base, route: 'research' }), /different input/);
});
