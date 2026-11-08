// Task 06u8a: host verification events describe real checks, never timers or guesses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

const write = () =>
  reply("", [
    {
      id: "w1",
      name: "write_file",
      args: { path: "src/agents/foo.mjs", content: "x", expectedHash: null },
    },
  ]);
const verifyTypes = (f) =>
  f.events
    .filter((e) => e.type === "verify-start" || e.type === "verify-result")
    .map((e) => e.type);

function setup(script) {
  const f = fixture({ provider: async () => script.shift() || reply("selesai") });
  const calls = [];
  f.runtime.verifier = {
    daftarBerkas: async () => ["tests/unit/foo.test.mjs"],
    bacaBerkas: async () => 'import "../../src/agents/foo.mjs";',
    jalankan: async (cmd, args) => {
      calls.push({ cmd, args, eventsBeforeCheck: verifyTypes(f) });
      return { code: 0, termination: "exit", output: "ok\n" };
    },
  };
  return { f, calls };
}

test("a validated run emits verify-start immediately before its real check, then verify-result", async () => {
  const { f, calls } = setup([write(), reply("sudah")]);
  await f.runtime.start({ prompt: "ubah foo dan uji", mode: "work" });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].eventsBeforeCheck, ["verify-start"]);
  assert.deepEqual(verifyTypes(f), ["verify-start", "verify-result"]);
  assert.equal(f.parent().validation.status, "passed");
});

test("a run without validation emits no verify-start", async () => {
  const { f, calls } = setup([reply("hanya membaca")]);
  await f.runtime.start({ prompt: "jelaskan isi folder", mode: "work" });

  assert.equal(calls.length, 0);
  assert.equal(f.parent().validation.status, "not-applicable");
  assert.deepEqual(verifyTypes(f), []);
});

test("ask mode emits no verify-start because validation is skipped", async () => {
  const { f, calls } = setup([reply("halo")]);
  await f.runtime.start({ prompt: "halo apa kabar", mode: "ask" });

  assert.equal(calls.length, 0);
  assert.deepEqual(verifyTypes(f), []);
});
