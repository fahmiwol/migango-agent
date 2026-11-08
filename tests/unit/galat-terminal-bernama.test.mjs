// P01 (RISET-066): a terminal operation that is not a success must carry a named, safe
// { code, message } in the Local Bridge `operation` and `result` responses. Fakes only; no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, reply } from "./team-fixture.mjs";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";
import { TERMINAL_CODES, nameTerminal, isKnownCode } from "../../src/core/galat-terminal.mjs";

const root = process.platform === "win32" ? "C:\\ws" : "/ws";
const KEY = "sk-" + "ant-api03-" + "ABCDEFGH12345678";
const CLOSED = new Set(Object.keys(TERMINAL_CODES));

function ctl(over = {}) {
  return createBridgeController({ workspace: () => root, status: () => ({}), start: () => {}, stop: () => {},
    loadRun: async () => null, resolveApproval: () => true, redact: (s) => s, ...over });
}
const begin = (c) => c.execute("start", { requestId: randomUUID(), expectedWorkspace: root, prompt: "kerjakan", mode: "work" });
const tick = () => new Promise((r) => setImmediate(r));
// The invariant: non-success => known code + non-empty safe message, on the operation and the run.
function assertNamed(view, label) {
  assert.ok(isKnownCode(view.code), label + " code " + view.code);
  assert.equal(typeof view.error, "string", label);
  assert.ok(view.error.length > 0 && view.error.length <= 2000, label + " message");
  assert.equal(view.error.includes(KEY), false, label + " leaks a key");
}

test("start that throws synchronously ends failed with ERR_NOT_STARTED and a safe message", async () => {
  const c = ctl({ start: () => { throw new Error("boom " + KEY); }, redact: (s) => s.replaceAll(KEY, "[REDACTED]") });
  const op = await begin(c);
  assert.equal(op.status, "failed");
  assert.equal(op.code, "ERR_NOT_STARTED");
  assertNamed(op, "sync throw");
  assert.match(op.error, /boom/);
});

test("a thrown error with an empty message still gets a code and a non-empty message", async () => {
  for (const thrown of [new Error(""), Object.assign(new Error("x"), { message: undefined }), "", undefined]) {
    const c = ctl({ start: () => { throw thrown; } });
    const op = await begin(c);
    assert.equal(op.status, "failed");
    assertNamed(op, "empty throw");
  }
});

test("start that rejects asynchronously before any run record is ERR_NOT_STARTED", async () => {
  const c = ctl({ start: () => Promise.reject(new Error("A task is already running")) });
  const op = await begin(c);
  await tick();
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.status, "failed");
  assert.equal(seen.code, "ERR_NOT_STARTED");
  assertNamed(seen, "async reject");
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.operation.code, "ERR_NOT_STARTED");
  assert.equal(result.run, null);
});

test("a recovery HOLD refusal keeps ERR_HOLD", async () => {
  const hold = Object.assign(new Error("Tool teardown failed. process job unconfirmed"), { code: "ERR_HOLD" });
  const c = ctl({ start: () => Promise.reject(hold) });
  const op = await begin(c);
  await tick();
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.code, "ERR_HOLD");
  assertNamed(seen, "hold");
});

test("a finish event with status failed and no error is ERR_RUN_THREW on operation and result", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}),
    loadRun: async () => ({ id: runId, status: "failed", workspace: root, error: "" }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "failed" });
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.status, "failed");
  assert.equal(seen.code, "ERR_RUN_THREW");
  assertNamed(seen, "operation");
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run.status, "failed");
  assert.equal(result.run.errorCode, "ERR_RUN_THREW");
  assertNamed({ code: result.run.errorCode, error: result.run.error }, "result.run");
});

test("a stop ends cancelled with ERR_STOPPED", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}),
    loadRun: async () => ({ id: runId, status: "cancelled", workspace: root, error: "" }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  await c.execute("stop", { operationId: op.operationId, expectedWorkspace: root });
  c.observe({ type: "finish", runId, status: "cancelled" });
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.status, "cancelled");
  assert.equal(seen.code, "ERR_STOPPED");
  assertNamed(seen, "stop");
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run.errorCode, "ERR_STOPPED");
  assertNamed({ code: result.run.errorCode, error: result.run.error }, "stop result");
});

test("a provider error keeps its specific code and a redacted message", async () => {
  const runId = randomUUID();
  const message = "anthropic stream cut before message_stop " + KEY;
  const c = ctl({ start: () => new Promise(() => {}), redact: (s) => s.replaceAll(KEY, "[REDACTED]"),
    loadRun: async () => ({ id: runId, status: "failed", workspace: root, error: message, errorCode: "ERR_PROVIDER_STREAM_CUT" }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "failed", error: message, errorCode: "ERR_PROVIDER_STREAM_CUT" });
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.code, "ERR_PROVIDER_STREAM_CUT");
  assertNamed(seen, "provider operation");
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run.errorCode, "ERR_PROVIDER_STREAM_CUT");
  assertNamed({ code: result.run.errorCode, error: result.run.error }, "provider result");
});

test("an unknown error code from outside is replaced, never passed through", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}),
    loadRun: async () => ({ id: runId, status: "failed", workspace: root, error: "x", errorCode: "ERR_MADE_UP_BY_A_MODEL" }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "failed", error: "x", errorCode: "ERR_MADE_UP_BY_A_MODEL" });
  assert.equal((await c.execute("operation", { operationId: op.operationId })).code, "ERR_RUN_THREW");
  assert.equal((await c.execute("result", { operationId: op.operationId })).run.errorCode, "ERR_RUN_THREW");
});

test("a missing run record after a failed finish: run is null but the operation says why", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}), loadRun: async () => null });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "failed" });
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run, null);
  assert.equal(result.operation.status, "failed");
  assertNamed(result.operation, "failed, no record");
});

test("a finish that claims success but has no run record becomes failed with ERR_NO_RUN_RECORD", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}), loadRun: async () => null });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "responded" });
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run, null);
  assert.equal(result.operation.status, "failed");
  assert.equal(result.operation.code, "ERR_NO_RUN_RECORD");
  assertNamed(result.operation, "success without record");
});

test("a run whose finish event was never attributed is still reported by the start promise", async () => {
  // The queue saw run.status undefined: no runId on the operation, so result returned run:null.
  const runId = randomUUID();
  const c = ctl({ start: () => Promise.resolve({ id: runId, status: "failed" }),
    loadRun: async (id) => (id === runId ? { id: runId, status: "failed", workspace: root, error: "" } : null) });
  const op = await begin(c);
  await tick();
  const result = await c.execute("result", { operationId: op.operationId });
  assert.ok(result.run, "run must not be null once the start promise gave the run id");
  assert.equal(result.run.status, "failed");
  assert.equal(result.operation.status, "failed");
  assertNamed(result.operation, "unattributed");
  assert.equal(result.run.errorCode, "ERR_RUN_THREW");
});

test("a finish event without any status is ERR_UNKNOWN, not a silent finished", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId });
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.code, "ERR_UNKNOWN");
  assertNamed(seen, "no status");
});

test("a loaded run with no status is reported as unknown with ERR_UNKNOWN", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}), loadRun: async () => ({ id: runId, workspace: root }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "failed" });
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(typeof result.run.status, "string");
  assert.ok(result.run.status.length > 0);
  assert.equal(result.run.errorCode, "ERR_UNKNOWN");
});

test("successes carry no code and no error", async () => {
  const runId = randomUUID();
  const c = ctl({ start: () => new Promise(() => {}),
    loadRun: async () => ({ id: runId, status: "responded", workspace: root, final: "ok" }) });
  const op = await begin(c);
  c.observe({ type: "start", id: runId });
  c.observe({ type: "finish", runId, status: "responded" });
  const seen = await c.execute("operation", { operationId: op.operationId });
  assert.equal(seen.error, null);
  assert.equal(seen.code ?? null, null);
  const result = await c.execute("result", { operationId: op.operationId });
  assert.equal(result.run.error, "");
  assert.equal(result.run.errorCode ?? null, null);
});

test("nameTerminal: closed set, bounded and scrubbed", () => {
  assert.equal(nameTerminal({ status: "responded" }), null);
  const t = nameTerminal({ status: "failed", message: "x".repeat(5000) + KEY });
  assert.ok(CLOSED.has(t.code));
  assert.ok(t.message.length <= 2000);
  const k = nameTerminal({ status: "failed", message: "bad " + KEY });
  assert.equal(k.message.includes(KEY), false);
  assert.ok(nameTerminal({ status: "weird" }).message.length > 0);
});

// ---- Runtime-level fixtures: the real AgentRuntime feeds the real controller. ----
function wired(provider, settings = {}) {
  const f = fixture({ settings: { internalMemory: false, maxTurns: 20, ...settings }, provider });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "x" });
  const c = createBridgeController({ workspace: () => f.tools.workspace.root, status: () => ({}),
    start: (payload, meta) => f.runtime.start({ ...payload, origin: meta.origin }),
    stop: () => f.runtime.stop(), loadRun: (id) => f.store.loadRun(id), resolveApproval: () => true });
  f.runtime.emit = (e) => c.observe(e);
  const settle = async (op) => {
    for (let i = 0; i < 300 && ["starting", "running"].includes((await c.execute("operation", { operationId: op.operationId })).status); i++) await tick();
    return { op, seen: await c.execute("operation", { operationId: op.operationId }), result: await c.execute("result", { operationId: op.operationId }) };
  };
  const begin2 = (extra = {}) => c.execute("start", { requestId: randomUUID(), expectedWorkspace: f.tools.workspace.root, prompt: "kerjakan tugas", mode: "work", ...extra });
  return { f, c, settle, begin2, run: async (extra) => settle(await begin2(extra)) };
}

test("runtime: hitting the turn limit ends with ERR_TURN_LIMIT in the bridge result", async () => {
  let n = 0;
  const { run } = wired(async () => (n++, reply("", [{ id: "l" + n, name: "list_files", args: {} }])));
  const { seen, result } = await run({ maxTurns: 2 });
  assert.equal(seen.status, "failed");
  assert.equal(seen.code, "ERR_TURN_LIMIT");
  assert.equal(result.run.errorCode, "ERR_TURN_LIMIT");
  assertNamed(seen, "turn limit");
});

test("runtime: a model call that throws with an empty message ends ERR_RUN_THREW", async () => {
  const { run } = wired(async () => { throw new Error(""); });
  const { seen, result } = await run();
  assert.equal(seen.status, "failed");
  assert.equal(seen.code, "ERR_RUN_THREW");
  assertNamed(seen, "empty throw");
  assert.equal(result.run.errorCode, "ERR_RUN_THREW");
  assert.ok(result.run.error.length > 0);
});

test("runtime: a provider stream cut keeps ERR_PROVIDER_STREAM_CUT", async () => {
  const { run } = wired(async () => { throw Object.assign(new Error("gemini stream cut before finishReason. No automatic retry."), { code: "ERR_PROVIDER_STREAM_CUT" }); });
  const { seen, result } = await run();
  assert.equal(seen.code, "ERR_PROVIDER_STREAM_CUT");
  assert.equal(result.run.errorCode, "ERR_PROVIDER_STREAM_CUT");
  assertNamed(seen, "provider");
});

test("runtime: a provider error without a code is classified ERR_PROVIDER", async () => {
  const { run } = wired(async () => { throw Object.assign(new Error("kimi HTTP 400: request failed. No automatic retry."), { status: 400 }); });
  const { seen } = await run();
  assert.equal(seen.code, "ERR_PROVIDER");
  assertNamed(seen, "http 400");
});

test("runtime: a spend cap keeps ERR_COST_CAP", async () => {
  const { run } = wired(async () => { throw Object.assign(new Error("Pagu biaya harian tercapai"), { code: "ERR_COST_CAP" }); });
  const { seen, result } = await run();
  assert.equal(seen.code, "ERR_COST_CAP");
  assert.equal(result.run.errorCode, "ERR_COST_CAP");
});

test("runtime: Stop during a model call ends cancelled with ERR_STOPPED", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const w = wired(async (req) => {
    release();
    await new Promise((_, rej) => req.signal?.addEventListener("abort", () => rej(new Error("aborted")), { once: true }));
    return reply();
  });
  const op = await w.begin2();
  await gate;
  await w.c.execute("stop", { operationId: op.operationId, expectedWorkspace: w.f.tools.workspace.root });
  const { seen } = await w.settle(op);
  assert.equal(seen.status, "cancelled");
  assert.equal(seen.code, "ERR_STOPPED");
  assertNamed(seen, "stop");
});

test("runtime: a recovery hold refuses the next start with ERR_HOLD", async () => {
  const { f, run } = wired(async () => reply());
  f.runtime.locked = "Tool teardown failed. process job unconfirmed";
  const { seen } = await run();
  assert.equal(seen.status, "failed");
  assert.equal(seen.code, "ERR_HOLD");
  assertNamed(seen, "hold");
});
