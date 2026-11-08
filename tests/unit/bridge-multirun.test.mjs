// Bridge multi-run (markas, 27 Oct 2026): a new start is accepted while another run is active only
// when its workspace differs (one lock per workspace), the workspace is an isolated worktree, and the
// number of active runs stays below the owner's limit (default 1, max 3). Operation, approvals and
// result are kept per operationId; approvals stay per run.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createBridgeController} from '../../src/desktop/bridge-controller.mjs';

const isolated = p => ({ok: p.startsWith('/wt/') || p.startsWith('\\wt\\') || /^[a-z]:\\wt\\/i.test(p)});
const abs = p => process.platform === 'win32' ? 'C:' + p.replaceAll('/', '\\') : p;
function make({limit, starts = [], stops = [], resolved = [], runs = new Map()} = {}) {
  const ctl = createBridgeController({
    workspace: () => abs('/owned'), status: () => ({}), redact: s => s,
    // The run's workspace travels as a second argument, never inside the model payload.
    start: (payload, run) => { starts.push({...run, prompt: payload.prompt}); },
    stop: target => { stops.push(target); return true; },
    loadRun: async id => runs.get(id) || null,
    resolveApproval: (id, yes) => { resolved.push([id, yes]); return true; },
    canGrantWrites: p => isolated(p),
    ...(limit === undefined ? {} : {maxActive: () => limit}),
  });
  const start = ws => ctl.execute('start', {requestId: randomUUID(), expectedWorkspace: abs(ws), prompt: 'tugas uji', mode: 'work'});
  return {ctl, start, starts, stops, resolved, runs};
}

test('default limit is one active run; a second start is refused', async () => {
  const {start} = make();
  assert.equal((await start('/owned')).status, 'running');
  await assert.rejects(start('/wt/a'), /limit|running|workspace/i);
});

test('limit 2: different isolated worktrees run together, a third is refused', async () => {
  const {start, starts} = make({limit: 2});
  const a = await start('/wt/a'), b = await start('/wt/b');
  assert.equal(a.status, 'running'); assert.equal(b.status, 'running');
  assert.notEqual(a.operationId, b.operationId);
  assert.equal(a.workspace, abs('/wt/a')); assert.equal(b.workspace, abs('/wt/b'));
  assert.deepEqual(starts.map(s => s.workspace), [abs('/wt/a'), abs('/wt/b')]);
  await assert.rejects(start('/wt/c'), /limit/i);
  assert.equal(starts.length, 2);
});

test('one lock per workspace: the same workspace cannot run twice', async () => {
  const {start, starts} = make({limit: 3});
  await start('/wt/a');
  await assert.rejects(start('/wt/a'), /workspace.*(active|running)/i);
  assert.equal(starts.length, 1);
});

test('a second workspace must be an isolated worktree', async () => {
  const {start, starts} = make({limit: 3});
  await start('/owned');
  await assert.rejects(start('/plain'), /worktree|workspace/i);
  assert.equal(starts.length, 1);
});

test('owner limit is clamped: invalid values fall back to 1, 3 is the maximum', async () => {
  for (const bad of [99, 0, -1, 2.5, '2', null]) {
    const {start} = make({limit: bad});
    await start('/owned');
    // Falls back to 1: a second workspace is refused (old app-workspace rule or the limit).
    await assert.rejects(start('/wt/b'), /limit|app workspace/i, 'limit ' + bad);
  }
  const {start} = make({limit: 3});
  await start('/wt/a'); await start('/wt/b'); await start('/wt/c');
  await assert.rejects(start('/wt/d'), /limit/i);
});

test('race: concurrent starts never exceed the limit or share a workspace', async () => {
  const {start, starts} = make({limit: 2});
  const spread = await Promise.allSettled(['/wt/a', '/wt/b', '/wt/c', '/wt/d', '/wt/e'].map(start));
  assert.equal(spread.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(starts.length, 2);
  const same = make({limit: 3});
  const sameRuns = await Promise.allSettled([1, 2, 3, 4].map(() => same.start('/wt/a')));
  assert.equal(sameRuns.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(same.starts.length, 1);
});

test('finishing a run frees its slot and its workspace', async () => {
  const {ctl, start} = make({limit: 2});
  const a = await start('/wt/a'); await start('/wt/b');
  const runA = randomUUID();
  ctl.observe({type: 'start', id: runA, workspace: abs('/wt/a')});
  ctl.observe({type: 'finish', runId: runA, status: 'done'});
  assert.equal((await ctl.execute('operation', {operationId: a.operationId})).status, 'done');
  assert.equal((await start('/wt/c')).status, 'running');
  await assert.rejects(start('/wt/d'), /limit/i);
  await assert.rejects(start('/wt/a'), /limit/i);
});

test('a single active run keeps the old attribution without workspace on events', async () => {
  const {ctl, start} = make();
  const a = await start('/owned');
  const runA = randomUUID();
  ctl.observe({type: 'start', id: runA});
  ctl.observe({type: 'approval', id: 'p1', tool: 'write_file', args: {path: 'a.txt', content: 'x', expectedHash: null}, expiresAt: Date.now() + 10000});
  assert.equal((await ctl.execute('operation', {operationId: a.operationId})).runId, runA);
  assert.deepEqual((await ctl.execute('approvals', {})).map(r => [r.id, r.operationId]), [['p1', a.operationId]]);
});

test('events, approvals, result and stop are attributed per operationId', async () => {
  const runs = new Map();
  const {ctl, start, stops, resolved} = make({limit: 2, runs});
  const a = await start('/wt/a'), b = await start('/wt/b');
  const runA = randomUUID(), runB = randomUUID();
  ctl.observe({type: 'start', id: runB, workspace: abs('/wt/b')});
  ctl.observe({type: 'start', id: runA, workspace: abs('/wt/a')});
  assert.equal((await ctl.execute('operation', {operationId: a.operationId})).runId, runA);
  assert.equal((await ctl.execute('operation', {operationId: b.operationId})).runId, runB);
  const exp = Date.now() + 10000;
  ctl.observe({type: 'approval', id: 'pa', runId: runA, tool: 'write_file', args: {path: 'a.txt', content: 'x', expectedHash: null}, expiresAt: exp});
  ctl.observe({type: 'approval', id: 'pb', workspace: abs('/wt/b'), tool: 'write_file', args: {path: 'b.txt', content: 'y', expectedHash: null}, expiresAt: exp});
  // Ambiguous: two active runs and no run or workspace on the event; the owner decides in the app.
  ctl.observe({type: 'approval', id: 'px', tool: 'write_file', args: {path: 'x.txt', content: 'z', expectedHash: null}, expiresAt: exp});
  const all = await ctl.execute('approvals', {});
  assert.deepEqual(all.map(r => [r.id, r.operationId, r.workspace]).sort(),
    [['pa', a.operationId, abs('/wt/a')], ['pb', b.operationId, abs('/wt/b')]]);
  const onlyB = await ctl.execute('approvals', {operationId: b.operationId});
  assert.deepEqual(onlyB.map(r => r.id), ['pb']);
  const pa = all.find(r => r.id === 'pa');
  await assert.rejects(ctl.execute('decide', {id: 'pa', digest: pa.digest, yes: true, expectedWorkspace: abs('/wt/b')}), /workspace/i);
  await assert.rejects(ctl.execute('decide', {id: 'pa', digest: pa.digest, yes: true, expectedWorkspace: abs('/wt/a'), operationId: b.operationId}), /operation/i);
  assert.deepEqual(resolved, []);
  assert.deepEqual(await ctl.execute('decide', {id: 'pa', digest: pa.digest, yes: true, expectedWorkspace: abs('/wt/a'), operationId: a.operationId}), {resolved: true, approved: true});
  assert.deepEqual(resolved, [['pa', true]]);
  runs.set(runA, {id: runA, status: 'done', workspace: abs('/wt/a'), final: 'hasil A'});
  runs.set(runB, {id: runB, status: 'done', workspace: abs('/wt/a'), final: 'salah tempat'});
  assert.equal((await ctl.execute('result', {operationId: a.operationId})).run.final, 'hasil A');
  await assert.rejects(ctl.execute('result', {operationId: b.operationId}), /workspace/i);
  await assert.rejects(ctl.execute('stop', {operationId: b.operationId, expectedWorkspace: abs('/wt/a')}), /workspace/i);
  assert.deepEqual(await ctl.execute('stop', {operationId: b.operationId, expectedWorkspace: abs('/wt/b')}), {stopped: true});
  assert.deepEqual(stops, [{operationId: b.operationId, runId: runB, workspace: abs('/wt/b')}]);
  ctl.observe({type: 'finish', runId: runA, status: 'done'});
  assert.deepEqual(await ctl.execute('stop', {operationId: a.operationId, expectedWorkspace: abs('/wt/a')}), {stopped: false, status: 'done'});
});
