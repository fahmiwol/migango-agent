import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: a real miganGO task ended because read_file hit a path that does not exist (ENOENT):
// any tool error ended the whole run. Errors from read-only tools now go back to the model as an
// error tool result so it can correct itself; errors from tools with side effects (writes, shell)
// still stop the run, so recovery never has to guess what happened.
const enoent = () => Object.assign(new Error("ENOENT: no such file or directory, lstat 'src/core/runtime.mjs'"), { code: "ENOENT" });

test("a read-only tool error goes back to the model as an error result and the run continues", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async (req) => {
      turn++;
      if (turn === 1) return reply("", [{ id: "r1", name: "read_file", args: { path: "src/core/runtime.mjs" } }]);
      const tool = req.messages.find((m) => m.role === "tool");
      assert.ok(tool, "the error reaches the model");
      assert.equal(tool.error, true);
      assert.match(tool.content, /ENOENT/);
      return reply("Berkasnya tidak ada; saya pakai src/agents/runtime.mjs.");
    },
  });
  f.tools.execute = async (call) => {
    if (call.name === "read_file") throw enoent();
    return { ok: true };
  };
  await f.runtime.start({ prompt: "Baca berkas runtime", mode: "work" });
  assert.equal(f.parent().status, "needs-validation", f.parent().error);
  assert.match(f.parent().final, /tidak ada/);
  assert.ok(f.events.some((e) => e.type === "tool-result" && e.error === true));
});

test("an error from a tool with side effects still stops the run", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "w1", name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } }]),
  });
  f.tools.execute = async () => {
    throw new Error("disk penuh");
  };
  await f.runtime.start({ prompt: "Tulis berkas", mode: "work" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /disk penuh/);
});

test("owner rejection is never turned into a retryable error result", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "s1", name: "search_files", args: { query: "x" } }]),
  });
  let calls = 0;
  f.tools.execute = async () => {
    calls++;
    throw new Error("Owner rejected this action. Do not retry or substitute another tool.");
  };
  await f.runtime.start({ prompt: "Cari", mode: "work" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /Owner rejected/);
  assert.equal(calls, 1, "the rejected call is not retried");
});

// 27 Oct 2026: a bridge runner refused a shell command outside its allowlist and the whole run
// ended. A refusal by automatic policy (not by the owner) now goes back to the model as an error
// result with code ERR_POLICY_DENIED, at most 5 times per run; the 6th ends the run.
const policyDenied = (reason = "perintah di luar daftar-izin") =>
  Object.assign(new Error("Policy denied this action: " + reason), { code: "ERR_POLICY_DENIED", reason });

test("a policy denial goes back to the model as an ERR_POLICY_DENIED error result and the run continues", async () => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false },
    provider: async (req) => {
      turn++;
      if (turn === 1) return reply("", [{ id: "w1", name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } }]);
      const tool = req.messages.find((m) => m.role === "tool");
      assert.ok(tool, "the denial reaches the model");
      assert.equal(tool.error, true);
      const body = JSON.parse(tool.content);
      assert.equal(body.code, "ERR_POLICY_DENIED");
      assert.match(body.error, /daftar-izin/);
      return reply("Ditolak kebijakan; saya pakai cara lain.");
    },
  });
  f.tools.execute = async () => {
    throw policyDenied();
  };
  await f.runtime.start({ prompt: "Tulis berkas", mode: "work" });
  assert.equal(f.parent().status, "needs-validation", f.parent().error);
  assert.match(f.parent().final, /cara lain/);
  assert.ok(f.events.some((e) => e.type === "tool-result" && e.error === true && /ERR_POLICY_DENIED/.test(e.result)));
});

const deniedRun = async (denials) => {
  let turn = 0;
  const f = fixture({
    settings: { internalMemory: false, maxTurns: 12 },
    provider: async () => {
      turn++;
      if (turn <= denials) return reply("", [{ id: "w" + turn, name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } }]);
      return reply("selesai");
    },
  });
  let calls = 0;
  f.tools.execute = async () => {
    calls++;
    throw policyDenied();
  };
  await f.runtime.start({ prompt: "Tulis berkas", mode: "work" });
  return { f, calls };
};

test("five policy denials in one run are tolerated", async () => {
  const { f, calls } = await deniedRun(5);
  assert.equal(calls, 5);
  assert.equal(f.parent().status, "needs-validation", f.parent().error);
});

test("the sixth policy denial in one run ends the run", async () => {
  const { f, calls } = await deniedRun(6);
  assert.equal(calls, 6);
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /Policy denial limit/);
});

test("an owner rejection carrying a policy-looking code is still fatal", async () => {
  const f = fixture({
    settings: { internalMemory: false },
    provider: async () => reply("", [{ id: "w1", name: "write_file", args: { path: "a.txt", content: "x", expectedHash: null } }]),
  });
  f.tools.execute = async () => {
    throw Object.assign(new Error("Owner rejected this action. Do not retry or substitute another tool."), { code: "ERR_POLICY_DENIED" });
  };
  await f.runtime.start({ prompt: "Tulis", mode: "work" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /Owner rejected/);
});
