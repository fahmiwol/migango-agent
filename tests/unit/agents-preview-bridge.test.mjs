// ARS-004 §13: preload surface for preview, project files and new projects, against a fake `electron`.
// Live behaviour in the real app is tests/integration/preview.test.mjs.
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
    contextBridge: { exposeInMainWorld: (name, api) => (exposed = api) },
    ipcRenderer: {
      invoke: async (channel, method, payload) => (invoked.push({ channel, method, payload }), { ok: true, data: null }),
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
    for (const [fn, channel] of listeners) if (channel === "workbench-event") fn({}, event);
  };
  return { api: exposed, invoked, listeners, fire };
}

test("preload exposes preview, file and project requests with exact method names", async () => {
  const { api, invoked } = loadPreload();
  const calls = [
    [() => api.previewArtifact("app/index.html"), "previewArtifact", "app/index.html"],
    [() => api.openPreview({ token: "t", rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true }), "openPreview", { token: "t", rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true }],
    [() => api.closePreview("t"), "closePreview", "t"],
    [() => api.listDirectory({ dir: "src", offset: 200 }), "listDirectory", { dir: "src", offset: 200 }],
    [() => api.createProject({ name: "Kalkulator" }), "createProject", { name: "Kalkulator" }],
  ];
  for (const [call, method, payload] of calls) {
    assert.equal(typeof call, "function");
    await call();
    assert.deepEqual(invoked.at(-1), { channel: "workbench", method, payload }, method);
  }
});

test("onPreviewInvalidated forwards only preview.invalidated and can unsubscribe", () => {
  const { api, listeners, fire } = loadPreload();
  const got = [];
  const before = listeners.size;
  const stop = api.onPreviewInvalidated((e) => got.push(e));
  fire({ type: "tool-result", name: "write_file" });
  fire({ type: "preview.invalidated", token: "t", path: "app/index.html" });
  assert.deepEqual(got.map((e) => e.type), ["preview.invalidated"]);
  stop();
  assert.equal(listeners.size, before);
});

test("static wiring guard: main registers the isolated mgpreview scheme and the IPC cases", async () => {
  // Static guard only; behaviour is covered by agents-preview/agents-project-files and the Electron test.
  const source = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(source, /registerSchemesAsPrivileged\(/);
  assert.match(source, /"mgpreview"/);
  for (const method of ["previewArtifact", "openPreview", "closePreview", "listDirectory", "createProject"])
    assert.match(source, new RegExp(`case "${method}":`), method);
  assert.match(source, /\.observe\(/);
});
