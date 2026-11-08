import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: with the workspace on Recovery HOLD, a real miganGO task read for 1.6 million
// input tokens (about US$7) and only failed at its first write. A work or build run now checks
// the HOLD before the first model call; ask mode never writes, so it still runs.
const held = () => {
  throw new Error("Recovery HOLD: inspect and resolve previous effects before starting another consequential operation");
};

test("a work or build run on a held workspace fails before any model call", async () => {
  for (const mode of ["work", "build"]) {
    let calls = 0;
    const f = fixture({ settings: { internalMemory: false }, provider: async () => (calls++, reply("x")) });
    const checked = [];
    f.tools.recovery = { assertSafe: (root) => (checked.push(root), held()) };
    await assert.rejects(f.runtime.start({ prompt: "Sunting berkas", mode, ...(mode === "build" ? { target: "existing" } : {}) }), /Recovery HOLD/, mode);
    assert.equal(calls, 0, mode + ": no model call");
    assert.deepEqual(checked, [f.tools.workspace.root]);
  }
});

test("ask mode and an unheld workspace still run", async () => {
  const ask = fixture({ settings: { internalMemory: false }, provider: async () => reply("Jawaban.") });
  ask.tools.recovery = { assertSafe: held };
  await ask.runtime.start({ prompt: "Apa isi folder ini", mode: "ask" });
  assert.notEqual(ask.parent().status, "failed", ask.parent().error);
  const ok = fixture({ settings: { internalMemory: false }, provider: async () => reply("Selesai.") });
  ok.tools.recovery = { assertSafe: () => {} };
  await ok.runtime.start({ prompt: "Kerjakan tugas", mode: "work" });
  assert.notEqual(ok.parent().status, "failed", ok.parent().error);
});
