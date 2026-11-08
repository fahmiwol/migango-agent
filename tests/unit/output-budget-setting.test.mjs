import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: an Opus design task stopped at "Task output token budget reached" (16000 tokens per
// run in work mode, a fixed constant). The owner can now set outputBudgets per mode, validated like
// inputBudgets; the default stays 16000 and the cost meter still caps dollars per day.
const writer = (perTurn, turns) => {
  let n = 0;
  return async () => {
    n++;
    const done = n >= turns;
    return { ...reply(done ? "Selesai." : "lanjut", done ? [] : [{ id: "l" + n, name: "list_files", args: {} }]), usage: { input: 10, output: perTurn, cached: 0, available: true } };
  };
};

test("the default work output budget still stops a run at 16000 tokens", async () => {
  const f = fixture({ settings: { internalMemory: false }, provider: writer(6000, 5) });
  await f.runtime.start({ prompt: "Tulis dokumen panjang", mode: "work" });
  assert.equal(f.parent().status, "failed");
  assert.match(f.parent().error, /output token budget/);
});

test("an owner outputBudgets.work lets a long run finish", async () => {
  const f = fixture({ settings: { internalMemory: false, outputBudgets: { work: 64000 } }, provider: writer(6000, 5) });
  await f.runtime.start({ prompt: "Tulis dokumen panjang", mode: "work" });
  assert.notEqual(f.parent().status, "failed", f.parent().error);
});

test("an invalid outputBudgets value is refused, never ignored", async () => {
  for (const bad of [{ work: 0 }, { work: 500 }, { work: 5_000_000 }, { work: "64000" }, { lain: 64000 }]) {
    const f = fixture({ settings: { internalMemory: false, outputBudgets: bad }, provider: writer(10, 1) });
    await assert.rejects(f.runtime.start({ prompt: "x tugas", mode: "work" }), /outputBudgets/, JSON.stringify(bad));
  }
});
