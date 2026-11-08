// F1 PRD-003 / ARS-004 §2: minimal read-only IPC bridge for agen.status.
// The preload runs against a fake `electron` module, so no Electron binary is needed.
// Live proof in the real app belongs to the desktop integration suite (phase 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import Module, { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const preloadPath = require.resolve("../../src/desktop/preload.cjs");

function loadPreload() {
  const listeners = new Map();
  const invoked = [];
  let exposed;
  const fake = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed = { name, api }) },
    ipcRenderer: {
      invoke: async (channel, method, payload) => {
        invoked.push({ channel, method, payload });
        return { ok: true, data: [{ agentId: "migan", state: "siaga" }] };
      },
      on: (channel, fn) => listeners.set(fn, channel),
      removeListener: (channel, fn) => listeners.delete(fn),
    },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? fake : original.call(this, request, ...rest);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = original;
  }
  const fire = (event) => {
    for (const [fn, channel] of listeners)
      if (channel === "workbench-event") fn({}, event);
  };
  return { exposed, invoked, listeners, fire };
}

test("preload exposes agentStatus() as a read-only IPC request", async () => {
  const { exposed, invoked } = loadPreload();
  assert.equal(exposed.name, "workbench");
  assert.ok(Object.isFrozen(exposed.api));
  assert.equal(typeof exposed.api.agentStatus, "function");
  const data = await exposed.api.agentStatus();
  assert.deepEqual(invoked.at(-1), {
    channel: "workbench",
    method: "agentStatus",
    payload: undefined,
  });
  assert.equal(data[0].agentId, "migan");
  const writers = Object.keys(exposed.api).filter((k) =>
    /^(set|save|write|update|emit|push)AgentStatus|^agentStatus(Set|Write|Update)/i.test(k),
  );
  assert.deepEqual(writers, []);
});

test("preload exposes agentCatalog() as a read-only IPC request", async () => {
  const { exposed, invoked } = loadPreload();
  assert.equal(typeof exposed.api.agentCatalog, "function");
  await exposed.api.agentCatalog();
  assert.deepEqual(invoked.at(-1), { channel: "workbench", method: "agentCatalog", payload: undefined });
  const writers = Object.keys(exposed.api).filter((k) => /agent(Catalog)?(Add|Remove|Save|Set|Update|Delete)|(add|remove|save|set|delete)Agent/i.test(k));
  assert.deepEqual(writers, []);
});

test("onAgentStatus forwards only agen.status events and can unsubscribe", () => {
  const { exposed, listeners, fire } = loadPreload();
  assert.equal(typeof exposed.api.onAgentStatus, "function");
  const got = [];
  const before = listeners.size;
  const stop = exposed.api.onAgentStatus((e) => got.push(e));
  fire({ type: "tool-start", name: "read_file", args: { path: "a" } });
  fire({ type: "agen.status", v: 1, seq: 1, agentId: "migan", state: "berpikir" });
  fire({ type: "finish", status: "responded" });
  assert.deepEqual(got.map((e) => e.type), ["agen.status"]);
  stop();
  assert.equal(listeners.size, before);
  fire({ type: "agen.status", v: 1, seq: 2, agentId: "migan", state: "selesai" });
  assert.equal(got.length, 1);
});

test("static wiring guard: main.mjs wraps emit and delegates agentStatus to the read-only handler", async () => {
  // Static guard only, not behaviour proof: main.mjs needs Electron to import. Behaviour is covered by
  // agents-status-ipc.test.mjs (handler) and tests/integration/agent-status.test.mjs (real Electron).
  const source = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(source, /from "\.\/agent-status-channel\.mjs"/);
  assert.match(source, /new AgentStatusChannel\(\{\s*root:/);
  assert.match(source, /\.wrap\(/);
  assert.match(source, /case "agentStatus":/);
  assert.match(source, /createReadOnlyIpc\(/);
  assert.match(source, /announceStatus\(\)/);
  assert.match(source, /case "agentCatalog":/);
  assert.match(source, /openCatalog\(\{\s*root:/);
});
