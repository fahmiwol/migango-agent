import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCall } from "../../src/tools/registry.mjs";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: a real miganGO design task ended at "Argument too long: after" — one edit_file call
// carried more than 6000 characters. Argument validation runs before approval and before any side
// effect, so such an error now goes back to the model (code ERR_TOOL_ARGS) instead of ending the run.
const edit = (after) => ({ path: "a.md", before: "x", after, expectedHash: "h" });

test("an argument validation error carries ERR_TOOL_ARGS and says how to recover", () => {
  assert.throws(() => validateCall("edit_file", edit("y".repeat(7000))), (e) => e.code === "ERR_TOOL_ARGS" && /Argument too long: after/.test(e.message) && /6000/.test(e.message));
  assert.throws(() => validateCall("edit_file", { path: "a.md" }), (e) => e.code === "ERR_TOOL_ARGS");
  assert.throws(() => validateCall("edit_file", { ...edit("y"), extra: 1 }), (e) => e.code === "ERR_TOOL_ARGS");
  assert.deepEqual(validateCall("edit_file", edit("y")), edit("y"));
});

test("a rejected argument on a side-effect tool goes back to the model and the run continues", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async (req) => {
      turn++;
      if (turn === 1) return reply("", [{ id: "e1", name: "edit_file", args: edit("y".repeat(7000)) }]);
      const tool = req.messages.find((m) => m.role === "tool");
      assert.equal(tool?.error, true);
      assert.match(tool.content, /Argument too long/);
      return reply("Saya pecah suntingannya.");
    },
  });
  let executed = 0;
  f.tools.execute = async (call) => {
    executed++;
    validateCall(call.name, call.args);
    return { ok: true };
  };
  await f.runtime.start({ prompt: "Sunting dokumen", mode: "work" });
  assert.notEqual(f.parent().status, "failed", f.parent().error);
  assert.equal(executed, 1);
});

test("other side-effect errors without ERR_TOOL_ARGS still end the run", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "e1", name: "edit_file", args: edit("y") }]),
  });
  f.tools.execute = async () => {
    throw Object.assign(new Error("Argument too long: after"), { code: "ELSE" });
  };
  await f.runtime.start({ prompt: "Sunting", mode: "work" });
  assert.equal(f.parent().status, "failed");
});
