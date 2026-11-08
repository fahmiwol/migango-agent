import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, reply } from "./team-fixture.mjs";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// Markas, 27 Oct 2026: task 06a2 ran 59 turns against a 25-turn rule, because only the owner's
// global maxTurns (60) stopped it. A per-run runTurnLimit gives the lap runner a technical hard
// stop. It can only LOWER the owner's limit, never raise it.
function looping(settings = {}) {
  let calls = 0;
  const f = fixture({ settings: { internalMemory: false, ...settings }, provider: async () => (calls++, reply("", [{ id: "l" + calls, name: "list_files", args: {} }])) });
  f.store.settings.ownerTools = ["list_files", "read_file", "search_files"];
  f.runtime.tools.execute = async () => ({ ok: true, listing: "x" });
  return { f, calls: () => calls };
}

test("a run with runTurnLimit 3 stops after 3 model turns", async () => {
  const { f, calls } = looping({ maxTurns: 20 });
  await f.runtime.start({ prompt: "telusuri terus", mode: "work", runTurnLimit: 3 }).catch(() => {});
  assert.equal(calls(), 3);
  assert.match(String(f.parent().error), /Maximum model turns/);
});

test("runTurnLimit never raises the owner's maxTurns", async () => {
  const { f, calls } = looping({ maxTurns: 2 });
  await f.runtime.start({ prompt: "telusuri terus", mode: "work", runTurnLimit: 10 }).catch(() => {});
  assert.equal(calls(), 2);
});

test("an invalid runTurnLimit is refused before any model call", async () => {
  for (const bad of [0, 61, 2.5, "3", -1]) {
    const { f, calls } = looping();
    await assert.rejects(f.runtime.start({ prompt: "telusuri", mode: "work", runTurnLimit: bad }), /runTurnLimit/);
    assert.equal(calls(), 0, String(bad));
  }
});

const root = process.platform === "win32" ? "C:\\ws" : "/ws";
function ctl() {
  const starts = [];
  const c = createBridgeController({ workspace: () => root, status: () => ({}), start: (payload) => { starts.push(payload); }, stop: () => {}, loadRun: async () => null, resolveApproval: () => true });
  return { c, starts };
}

test("the bridge passes maxTurns to the run as runTurnLimit", async () => {
  const { c, starts } = ctl();
  await c.execute("start", { requestId: randomUUID(), expectedWorkspace: root, prompt: "kerjakan", mode: "work", maxTurns: 25 });
  assert.equal(starts[0].runTurnLimit, 25);
});

test("the bridge refuses a bad maxTurns and counts it in the request fingerprint", async () => {
  const { c } = ctl();
  for (const bad of [0, 61, 1.5, "25"]) await assert.rejects(c.execute("start", { requestId: randomUUID(), expectedWorkspace: root, prompt: "kerjakan", mode: "work", maxTurns: bad }), /maxTurns/);
  const requestId = randomUUID();
  await c.execute("start", { requestId, expectedWorkspace: root, prompt: "kerjakan", mode: "work", maxTurns: 25 });
  await assert.rejects(c.execute("start", { requestId, expectedWorkspace: root, prompt: "kerjakan", mode: "work", maxTurns: 60 }), /requestId/);
});
