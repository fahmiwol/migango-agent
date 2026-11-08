import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";
import { Approvals } from "../../src/core/approvals.mjs";

// Markas, 27 Oct 2026 (option b): the bridge grants write_file/edit_file on its own ONLY for a
// bridge build run, ONLY inside that run's buildTarget (checked per file), at most 50 writes /
// 5 MB per run; shell and every other tool still need the owner; each grant is marked
// "otomatis-bridge-build" so it shows in the run trace.
const target = process.platform === "win32" ? "C:\\qa\\build-kimi" : "/qa/build-kimi";
function setup({ mode = "build" } = {}) {
  const decided = [];
  let n = 0;
  const c = createBridgeController({
    workspace: () => target, status: () => ({}), start: () => {}, stop: () => {}, loadRun: async () => null,
    canGrantWrites: () => ({ ok: false, reason: "not an isolated worktree" }),
    checkBuildWrite: async (t, file) => { if (String(file).startsWith("..")) throw Object.assign(new Error("berkas tulis di luar buildTarget"), { code: "ERR_BUILD_TARGET_DENIED" }); return { root: t }; },
    resolveApproval: (id, yes, decision) => { decided.push({ id, yes, decision }); return true; },
  });
  const start = () => c.execute("start", { requestId: randomUUID(), expectedWorkspace: target, prompt: "bangun", mode, ...(mode === "build" ? { buildTarget: target } : {}) });
  const ask = (tool, args) => {
    const id = "a" + ++n;
    c.observe({ type: "approval", id, tool, args, expiresAt: Date.now() + 60000 });
    return id;
  };
  const decide = async (id) => {
    const [row] = (await c.execute("approvals")).filter((r) => r.id === id);
    return c.execute("decide", { id, digest: row.digest, yes: true, expectedWorkspace: target });
  };
  return { c, start, ask, decide, decided };
}

test("a bridge build run gets file writes inside its target granted and marked otomatis-bridge-build", async () => {
  const s = setup();
  await s.start();
  const id = s.ask("write_file", { path: "index.html", content: "<html></html>" });
  await s.decide(id);
  assert.deepEqual(s.decided.at(-1), { id, yes: true, decision: { via: "otomatis-bridge-build" } });
  const e = s.ask("edit_file", { path: "index.html", before: "a", after: "b" });
  await s.decide(e);
  assert.equal(s.decided.at(-1).decision.via, "otomatis-bridge-build");
});

test("a write outside the target is refused even in a bridge build run", async () => {
  const s = setup();
  await s.start();
  const id = s.ask("write_file", { path: "..\\build-sonnet\\index.html", content: "x" });
  await assert.rejects(s.decide(id), /di luar buildTarget|refused/);
  assert.equal(s.decided.length, 0);
});

test("outside a bridge build run nothing changes: no write grants without an isolated worktree", async () => {
  const s = setup({ mode: "work" });
  await s.start();
  const id = s.ask("write_file", { path: "index.html", content: "x" });
  await assert.rejects(s.decide(id), /isolated git worktree/);
});

test("shell and other tools still need the owner inside a bridge build run", async () => {
  const s = setup();
  await s.start();
  for (const [tool, args] of [["shell", { command: "node index.js" }], ["delete_file", { path: "index.html" }], ["browser_open", { url: "http://x" }]]) {
    const id = s.ask(tool, args);
    await assert.rejects(s.decide(id));
  }
  assert.equal(s.decided.length, 0);
});

test("at most 50 automatic writes per run; beyond that the owner approves", async () => {
  const s = setup();
  await s.start();
  for (let i = 0; i < 50; i++) await s.decide(s.ask("write_file", { path: `f${i}.txt`, content: "x" }));
  await assert.rejects(s.decide(s.ask("write_file", { path: "f50.txt", content: "x" })), /50/);
  // The 5 MB per-run byte limit cannot bind today: a write is only approvable up to 20000
  // characters, so 50 writes stay near 1 MB. The byte check stays as defence in depth.
});

test("Approvals passes the automatic marker to the waiting tool call", async () => {
  const events = [];
  const a = new Approvals((e) => events.push(e));
  const ctrl = new AbortController();
  const waiting = a.request("write_file", { path: "x" }, ctrl.signal);
  const id = events.find((e) => e.type === "approval").id;
  a.resolve(id, true, { via: "otomatis-bridge-build" });
  assert.deepEqual(await waiting, { approved: true, via: "otomatis-bridge-build" });
  const plain = a.request("write_file", { path: "y" }, ctrl.signal);
  a.resolve(events.filter((e) => e.type === "approval").at(-1).id, true);
  assert.equal(await plain, true);
});

test("the tool result carries the marker into the run trace", async () => {
  const src = await readFile(new URL("../../src/tools/registry.mjs", import.meta.url), "utf8");
  assert.match(src, /persetujuan: approvedVia/);
  const main = await readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  assert.match(main, /checkBuildWrite: \(target, file\) =>\s*checkBuildWriteTarget\(target, file, \{/);
});
