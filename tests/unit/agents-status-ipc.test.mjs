// F1 PRD-003 / ARS-004 §2, D-005: behaviour of the read-only agentStatus IPC handler, without Electron.
// main.mjs delegates its `agentStatus` case to this handler, so sender check and read-only rules live here.
import { test } from "node:test";
import assert from "node:assert/strict";

const load = () => import("../../src/desktop/agent-status-channel.mjs");
const trusted = { sender: "main-window" };
const untrusted = { sender: "remote-tab" };
const ipc = async (snapshot) => {
  const { createAgentStatusIpc } = await load();
  let calls = 0;
  const handler = createAgentStatusIpc({
    snapshot: () => {
      calls++;
      return snapshot;
    },
    isTrusted: (event) => event.sender === "main-window",
  });
  return { handler, calls: () => calls };
};

test("untrusted sender is refused before the snapshot is read", async () => {
  const { handler, calls } = await ipc([{ agentId: "migan", state: "siaga" }]);
  assert.throws(() => handler.handle(untrusted, "agentStatus"), /Untrusted IPC sender/);
  assert.equal(calls(), 0);
});

test("trusted agentStatus returns a deep copy of the snapshot", async () => {
  const source = [{ agentId: "migan", state: "siaga", seq: 1 }];
  const { handler } = await ipc(source);
  const data = handler.handle(trusted, "agentStatus");
  assert.deepEqual(data, source);
  data[0].state = "gagal";
  assert.equal(source[0].state, "siaga");
  assert.equal(handler.handle(trusted, "agentStatus")[0].state, "siaga");
});

test("the handler is read-only: payloads and any other method are refused", async () => {
  const { handler, calls } = await ipc([]);
  assert.deepEqual(handler.methods, ["agentStatus"]);
  assert.ok(Object.isFrozen(handler.methods));
  assert.throws(
    () => handler.handle(trusted, "agentStatus", { state: "selesai" }),
    /read-only|payload/i,
  );
  for (const method of ["agentStatusSet", "setAgentStatus", "agentCommand", "run"])
    assert.throws(() => handler.handle(trusted, method), /unknown|read-only/i, method);
  assert.equal(calls(), 0);
});
