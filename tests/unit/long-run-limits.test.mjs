import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/core/storage.mjs";
import { fixture, reply } from "./team-fixture.mjs";

// 27 Oct 2026: real runtime tasks on 56 KB files ended at 24 model turns or at the 2 MB
// cumulative input budget before they could write anything. The owner may now allow longer runs
// (maxTurns up to 60, inputBudgets up to 8 MB per mode). Defaults stay 12 turns and the old
// budgets, the team fan-out budget stays capped at 2 MB, and dollars stay capped by the meter.
async function store() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-limits-"));
  const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const s = new Store(root, crypto);
  await s.init();
  return { s, root, base: { ...s.publicSettings(), keys: {}, credentials: [] } };
}

test("the owner can allow up to 60 turns and 8 MB of input per mode", async () => {
  const { s, root, base } = await store();
  try {
    await s.saveSettings({ ...base, maxTurns: 60, inputBudgets: { work: 8_000_000, build: 8_000_000 } });
    assert.equal(s.settings.maxTurns, 60);
    assert.deepEqual(s.settings.inputBudgets, { work: 8_000_000, build: 8_000_000 });
    await s.saveSettings({ ...base, maxTurns: 500 });
    assert.equal(s.settings.maxTurns, 60, "larger values clamp to 60");
    await assert.rejects(s.saveSettings({ ...base, inputBudgets: { work: 8_000_001 } }), /inputBudgets/);
    await assert.rejects(s.saveSettings({ ...base, teamInputBudgets: { work: 2_000_001 } }), /teamInputBudgets/);
    await s.saveSettings({ ...base, maxTurns: undefined });
    assert.equal(s.settings.maxTurns, 12, "the default stays 12");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the runtime accepts an input budget above 2 MB and refuses one above 8 MB", async () => {
  const ok = fixture({ settings: { internalMemory: false, inputBudgets: { work: 3_000_000 } }, provider: async () => reply("Selesai.") });
  await ok.runtime.start({ prompt: "Kerjakan tugas", mode: "work" });
  assert.notEqual(ok.parent().status, "failed", ok.parent().error);
  const bad = fixture({ settings: { internalMemory: false, inputBudgets: { work: 9_000_000 } }, provider: async () => reply("x") });
  await assert.rejects(bad.runtime.start({ prompt: "Kerjakan tugas", mode: "work" }), /inputBudgets/);
});
