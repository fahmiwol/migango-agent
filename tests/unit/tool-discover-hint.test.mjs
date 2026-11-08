import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: a real miganGO UI task called shell before loading the terminal group with
// discover_tools, and the whole run ended at "Tool unavailable in this mode" after 50 turns of
// work. A tool the mode allows but the run has not loaded yet now goes back to the model with
// the group to load; a tool the mode itself refuses still ends the run.
test("a not-yet-loaded tool goes back to the model with the group to discover", async () => {
  let turn = 0;
  let executed = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async (req) => {
      turn++;
      if (turn === 1) return reply("", [{ id: "s1", name: "shell", args: { command: "node --test x.test.mjs" } }]);
      const tool = req.messages.find((m) => m.role === "tool");
      assert.equal(tool?.error, true);
      assert.match(tool.content, /discover_tools/);
      assert.match(tool.content, /terminal/);
      return reply("Saya muat grup terminal dulu.");
    },
  });
  f.tools.execute = async () => (executed++, { ok: true });
  await f.runtime.start({ prompt: "Jalankan tes", mode: "work" });
  assert.notEqual(f.parent().status, "failed", f.parent().error);
  assert.equal(executed, 0, "nothing ran");
});

test("a tool the mode refuses still ends the run", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "w1", name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } }]),
  });
  await f.runtime.start({ prompt: "Apa isi folder ini", mode: "ask" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /unavailable in this mode/);
});

test("an unknown tool name ends the run", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "x1", name: "format_disk", args: {} }]),
  });
  await f.runtime.start({ prompt: "Kerjakan", mode: "work" });
  assert.equal(f.parent().status, "failed");
});
