// F1 PRD-003 / ARS-004 §12: "Bangun aplikasi" writes into a new project folder, never into the
// active repo unless the owner chose it. Every refusal happens before any provider call.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const tmp = (p) => fs.mkdtemp(path.join(os.tmpdir(), p));
const reply = () => ({
  text: "ok",
  calls: [],
  finishReason: "completed",
  usage: { input: 1, output: 1, cached: 0, available: true },
  message: { role: "assistant", content: "ok", calls: [] },
});
function context(workspaceRoot) {
  let calls = 0;
  const store = {
    settings: {
      active: "ollama",
      profiles: { ollama: { model: "test", baseURL: "http://127.0.0.1" } },
      routes: {},
      maxTurns: 2,
      internalMemory: false,
    },
    keys: {},
    redact: (s) => s,
    saveRun: async () => {},
  };
  const tools = {
    workspace: { root: workspaceRoot },
    execute: async () => ({ ok: true }),
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    provider: async () => {
      calls++;
      return reply();
    },
  });
  return { runtime, calls: () => calls };
}
const build = (c, target) =>
  c.runtime.start({ prompt: "buatin aplikasi calculator", mode: "build", target });

test("checkBuildTarget exists as a pure guard in src/agents", async () => {
  const { checkBuildTarget } = await import("../../src/agents/build-target.mjs");
  assert.equal(typeof checkBuildTarget, "function");
});

test("build mode without a target folder is refused before the provider", async () => {
  const active = await tmp("mg-active-");
  const c = context(active);
  await assert.rejects(() => build(c, undefined), /folder proyek|project folder/i);
  assert.equal(c.calls(), 0);
});

test("the active repo, or a folder inside it, is refused without owner confirmation", async () => {
  const active = await tmp("mg-active-");
  const inside = path.join(active, "calc");
  await fs.mkdir(inside);
  for (const [kind, root] of [
    ["existing", active],
    ["new", active],
    ["new", inside],
    ["existing", inside],
    ["existing", active.toUpperCase()],
  ]) {
    const c = context(root);
    await assert.rejects(
      () => build(c, { kind, root, activeRoot: active, confirmedByOwner: false }),
      /repo aktif|active (repo|workspace)/i,
      kind + " " + root,
    );
    assert.equal(c.calls(), 0);
  }
});

test("owner-confirmed existing active repo is accepted", async () => {
  const active = await tmp("mg-active-");
  const c = context(active);
  const result = await build(c, { kind: "existing", root: active, activeRoot: active, confirmedByOwner: true });
  assert.notEqual(result.status, "failed");
  assert.equal(c.calls(), 1);
});

test("a new empty folder outside the active repo is accepted; a non-empty 'new' folder is refused", async () => {
  const active = await tmp("mg-active-");
  const fresh = await tmp("mg-fresh-");
  const ok = context(fresh);
  const result = await build(ok, { kind: "new", root: fresh, activeRoot: active, confirmedByOwner: false });
  assert.notEqual(result.status, "failed");
  const used = await tmp("mg-used-");
  await fs.writeFile(path.join(used, "index.html"), "<p>old</p>");
  const bad = context(used);
  await assert.rejects(
    () => build(bad, { kind: "new", root: used, activeRoot: active, confirmedByOwner: false }),
    /kosong|empty/i,
  );
  assert.equal(bad.calls(), 0);
});

test("the write guard must already point at the target folder", async () => {
  const active = await tmp("mg-active-");
  const fresh = await tmp("mg-fresh-");
  const c = context(active);
  await assert.rejects(
    () => build(c, { kind: "new", root: fresh, activeRoot: active, confirmedByOwner: false }),
    /ruang kerja|workspace/i,
  );
  assert.equal(c.calls(), 0);
});

test("ask and work modes ignore target and keep working as before", async () => {
  const active = await tmp("mg-active-");
  for (const mode of ["ask", "work"]) {
    const c = context(active);
    const result = await c.runtime.start({ prompt: "periksa folder ini", mode });
    assert.notEqual(result.status, "failed", mode);
  }
});
