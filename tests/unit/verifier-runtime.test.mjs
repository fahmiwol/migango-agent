// Task 06a2: the mandatory verifier is wired into the runtime. Fixture provider and an injected
// check runner only; no network, no real process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";
import { stateFromRunEvent } from "../../src/agents/status.mjs";

const write = (id, p = "src/agents/foo.mjs") =>
  reply("", [{ id, name: "write_file", args: { path: p, content: "x", expectedHash: null } }]);
const PASS = "ok\n";
const FAIL = "\nFailed tests:\n\n✖ foo works (1.2ms)\n";

function setup(script, results) {
  const f = fixture({ provider: async () => script.shift() || reply("selesai") });
  const calls = [];
  f.runtime.verifier = {
    daftarBerkas: async () => ["tests/unit/foo.test.mjs", "tests/unit/other.test.mjs"],
    bacaBerkas: async (p) => (p.endsWith("foo.test.mjs") ? 'import "../../src/agents/foo.mjs";' : ""),
    jalankan: async (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      const r = results.shift();
      return { code: r === PASS ? 0 : 1, termination: "exit", output: r };
    },
  };
  return { f, calls };
}
const run = (f) => f.parent();
const verifyEvents = (f) => f.events.filter((e) => e.type === "verify-result");

test("changed file and passing tests give validation passed", async () => {
  const { f, calls } = setup([write("w1"), reply("sudah")], [PASS]);
  await f.runtime.start({ prompt: "ubah foo dan uji", mode: "work" });
  const r = run(f);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 2), ["--test", "--test-reporter=dot"]);
  assert.ok(calls[0].args.includes("tests/unit/foo.test.mjs"));
  assert.ok(calls[0].opts.timeout <= 120000);
  assert.equal(r.validation.status, "passed");
  assert.equal(r.validation.accepted, true);
  assert.deepEqual(r.validation.cek, ["tests/unit/foo.test.mjs"]);
  assert.equal(typeof r.validation.keluaranRingkas, "string");
  assert.equal(typeof r.validation.durasiMs, "number");
  assert.equal(r.status, "needs-validation");
  const ev = verifyEvents(f);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].status, "passed");
});

test("failing tests give verification-failed after exactly one repair turn", async () => {
  const { f, calls } = setup([write("w1"), reply("sudah"), write("w2"), reply("diperbaiki")], [FAIL, FAIL]);
  await f.runtime.start({ prompt: "ubah foo dan uji", mode: "work" });
  const r = run(f);
  assert.equal(calls.length, 2, "verify once, repair, verify again");
  assert.equal(r.status, "verification-failed");
  assert.notEqual(r.status, "needs-validation");
  assert.equal(r.validation.status, "failed");
  assert.equal(r.validation.accepted, false);
  assert.ok(r.validation.keluaranRingkas.includes("foo works"));
  // The repair turn tells the model what failed.
  const repair = f.seen[2].messages.at(-1);
  assert.equal(repair.role, "user");
  assert.ok(String(repair.content).includes("foo works"));
  assert.equal(f.seen.length, 4, "no second repair turn");
  assert.equal(verifyEvents(f).length, 2);
  const fin = f.events.find((e) => e.type === "finish");
  assert.equal(fin.status, "verification-failed");
  assert.equal(fin.validation.status, "failed");
  assert.equal(stateFromRunEvent(fin), "gagal");
});

test("a repair that makes tests pass ends with validation passed", async () => {
  const { f, calls } = setup([write("w1"), reply("sudah"), write("w2"), reply("diperbaiki")], [FAIL, PASS]);
  await f.runtime.start({ prompt: "ubah foo dan uji", mode: "work" });
  const r = run(f);
  assert.equal(calls.length, 2);
  assert.equal(r.status, "needs-validation");
  assert.equal(r.validation.status, "passed");
});

test("no changed files gives not-applicable and keeps needs-validation", async () => {
  const { f, calls } = setup([reply("hanya membaca")], []);
  await f.runtime.start({ prompt: "jelaskan isi folder", mode: "work" });
  const r = run(f);
  assert.equal(calls.length, 0);
  assert.equal(r.status, "needs-validation");
  assert.equal(r.validation.status, "not-applicable");
  assert.equal(r.validation.accepted, false);
  assert.ok(r.validation.reason.length > 0);
});

test("ask mode never runs the verifier", async () => {
  const { f, calls } = setup([reply("halo")], []);
  await f.runtime.start({ prompt: "halo apa kabar", mode: "ask" });
  assert.equal(calls.length, 0);
  assert.equal(run(f).status, "responded");
});

// PIC review (27 Oct): a verifier that cannot run (no native helper, process error) is not a test
// failure. The model cannot repair it, so there is no repair turn; the run is not "done" either:
// it stays needs-validation with validation.status "error" and an accepted=false record.
test("a verifier that cannot run gives no repair turn and no false 'gagal'", async () => {
  const f = fixture({ provider: async () => script.shift() || reply("selesai") });
  const script = [write("w1"), reply("sudah"), reply("tidak boleh dipakai")];
  let runs = 0;
  f.runtime.verifier = {
    daftarBerkas: async () => ["tests/unit/foo.test.mjs"],
    bacaBerkas: async () => 'import "../../src/agents/foo.mjs";',
    jalankan: async () => {
      runs++;
      throw new Error("Native helper unavailable");
    },
  };
  await f.runtime.start({ prompt: "ubah foo dan uji", mode: "work" });
  const r = f.parent();
  assert.equal(runs, 1, "no second verification");
  assert.equal(r.validation.status, "error");
  assert.equal(r.validation.accepted, false);
  assert.equal(r.status, "needs-validation");
  assert.equal(script.length, 1, "no repair turn was spent");
});
