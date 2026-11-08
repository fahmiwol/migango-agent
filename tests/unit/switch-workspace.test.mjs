import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/core/storage.mjs";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// 000b2: the existing switch guard (src/core/folder-kerja.mjs) is wired into the app.
// devRoots is an owner setting; switchWorkspace is a bridge method, never a model tool.
const here = path.resolve(import.meta.dirname);
const repo = path.resolve(here, "../..");
const abs = (name) => path.join(os.tmpdir(), "migango-devroot-" + name);

async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-devroots-"));
  const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const s = new Store(root, crypto);
  await s.init();
  return { s, root, base: { ...s.publicSettings(), keys: {}, credentials: [] } };
}

test("devRoots is validated in settings and kept when omitted", async () => {
  const { s, root, base } = await store();
  try {
    assert.deepEqual(s.settings.devRoots, [], "default is empty: switching is off");
    await s.saveSettings({ ...base, devRoots: [abs("a")] });
    assert.deepEqual(s.settings.devRoots, [path.resolve(abs("a"))]);
    await s.saveSettings({ ...s.publicSettings(), keys: {}, credentials: [], devRoots: undefined });
    assert.deepEqual(s.settings.devRoots, [path.resolve(abs("a"))], "omitted keeps the old value");
    for (const bad of [["relatif/folder"], [abs("a"), abs("a")], [1, 2, 3, 4, 5, 6].map((n) => abs(String(n))), "C:/x", [""]])
      await assert.rejects(s.saveSettings({ ...base, devRoots: bad }), /devRoots/, JSON.stringify(bad));
    assert.deepEqual(s.settings.devRoots, [path.resolve(abs("a"))], "a refused save changes nothing");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const WS = path.resolve(os.tmpdir(), "migango-app-ws");
const TO = path.resolve(os.tmpdir(), "migango-dev", "wt-1");
function bridge(extra = {}) {
  const calls = [];
  const c = createBridgeController({
    workspace: () => WS,
    status: () => ({}),
    start: () => new Promise(() => {}),
    stop: () => {},
    loadRun: async () => null,
    resolveApproval: () => true,
    canGrantWrites: () => ({ ok: true }),
    switchWorkspace: async (to) => {
      calls.push(to);
      return { ok: true, workspace: to, branch: "cdx/x" };
    },
    ...extra,
  });
  return { c, calls };
}

test("switchWorkspace calls the guarded switcher with the target", async () => {
  const { c, calls } = bridge();
  const r = await c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS });
  assert.deepEqual(r, { ok: true, workspace: TO, branch: "cdx/x" });
  assert.deepEqual(calls, [TO]);
});

test("switchWorkspace checks expectedWorkspace and the target shape", async () => {
  const { c, calls } = bridge();
  await assert.rejects(c.execute("switchWorkspace", { to: TO, expectedWorkspace: TO }), /Expected workspace/);
  await assert.rejects(c.execute("switchWorkspace", { to: TO }), /Expected workspace/);
  for (const to of [undefined, "", "relatif", 5, "C:/" + "x".repeat(600)])
    await assert.rejects(c.execute("switchWorkspace", { to, expectedWorkspace: WS }), /absolute/, String(to));
  assert.deepEqual(calls, []);
});

test("switchWorkspace is refused while a bridge run is active", async () => {
  const { c, calls } = bridge();
  await c.execute("start", { expectedWorkspace: WS, requestId: "11111111-1111-4111-8111-111111111111", prompt: "kerjakan", mode: "ask" });
  await assert.rejects(c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS }), (e) => e.code === "ERR_SWITCH_BUSY");
  assert.deepEqual(calls, []);
});

test("switchWorkspace is refused while an approval is pending, allowed after it expires", async () => {
  let t = 1000;
  const { c, calls } = bridge({ now: () => t });
  await c.execute("start", { expectedWorkspace: WS, requestId: "22222222-2222-4222-8222-222222222222", prompt: "kerjakan", mode: "ask" });
  c.observe({ type: "start", id: "run-1" });
  c.observe({ type: "approval", id: "ap-1", tool: "write_file", args: {}, expiresAt: 5000 });
  c.observe({ type: "finish", runId: "run-1", status: "finished" });
  await assert.rejects(c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS }), (e) => e.code === "ERR_SWITCH_BUSY");
  t = 6000;
  await c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS });
  assert.deepEqual(calls, [TO]);
});

test("without a switcher the method is off", async () => {
  const { c } = bridge({ switchWorkspace: undefined });
  await assert.rejects(c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS }), /not available/);
});

test("switcher errors keep their code and are redacted", async () => {
  const { c } = bridge({
    redact: (s) => s.replace("RAHASIA", "[x]"),
    switchWorkspace: async () => {
      throw Object.assign(new Error("Target RAHASIA ditolak"), { code: "ERR_SWITCH_DENIED" });
    },
  });
  await assert.rejects(c.execute("switchWorkspace", { to: TO, expectedWorkspace: WS }),
    (e) => e.code === "ERR_SWITCH_DENIED" && !e.message.includes("RAHASIA"));
});

test("main.mjs wires the guard: devRoots, live and data folders forbidden, busy includes approvals", async () => {
  const main = await fs.readFile(path.join(repo, "src/desktop/main.mjs"), "utf8");
  // includes() keeps a failure message short (no source dump).
  for (const needle of [
    'switchWorkspace: (to) => workspaceSwitcher.switchTo(to, { actor: "bridge" })',
    "devRoots: store.settings.devRoots || []",
    "forbidden: [app.getAppPath(), store.root]",
    "repoCommonDir: appRepoCommonDir()",
    "approvals.pending.size",
    "apply: (root) => useWorkspace(root)",
  ])
    assert.ok(main.includes(needle), "main.mjs missing: " + needle);
});

test("switchWorkspace is not a model tool", async () => {
  const dir = path.join(repo, "src/tools");
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith(".mjs")) continue;
    const text = await fs.readFile(path.join(dir, name), "utf8");
    assert.doesNotMatch(text, /switch_?workspace|folder-kerja\.mjs.*switch|createWorkspaceSwitcher/i, name);
  }
});
