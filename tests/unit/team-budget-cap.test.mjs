import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fixture, reply, single, council } from "./team-fixture.mjs";
import { Store } from "../../src/core/storage.mjs";

// Markas cost decision (25 Oct 2026): the WORK default rose to 400 KB for the parent, but a team
// fan-out multiplies cost, so the team cap keeps the previous default (120 KB for ask/work,
// 600 KB for build) unless the owner sets teamInputBudgets explicitly.
async function teamRun(settings = {}, delegation = single) {
  const c = fixture({
    settings,
    provider: async () => reply("ok"),
  });
  await c.runtime.start({ prompt: "Periksa proyek", mode: "work", delegation });
  return c;
}

test("a WORK parent at 400 KB keeps the team at the previous 120 KB cap", async () => {
  const c = await teamRun();
  assert.equal(c.parent().teamBudget.cap.inputBytes, 120000);
  assert.ok(c.parent().teamBudget.remaining.inputBytes <= 120000);
});

test("raising the parent's inputBudgets does not raise the team cap", async () => {
  const c = await teamRun({ inputBudgets: { work: 800000 } }, council);
  assert.equal(c.parent().teamBudget.cap.inputBytes, 120000);
});

test("an explicit teamInputBudgets is the only way to raise the team cap", async () => {
  const c = await teamRun({ teamInputBudgets: { work: 300000 } }, council);
  assert.equal(c.parent().teamBudget.cap.inputBytes, 300000);
});

test("teamInputBudgets is saved and validated like inputBudgets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-team-budget-"));
  try {
    const store = new Store(root, { isEncryptionAvailable: () => false });
    await store.init();
    await store.saveSettings({ ...store.publicSettings(), teamInputBudgets: { work: 300000 } });
    assert.deepEqual(store.settings.teamInputBudgets, { work: 300000 });
    await store.saveSettings({ ...store.publicSettings(), teamInputBudgets: undefined });
    assert.deepEqual(store.settings.teamInputBudgets, { work: 300000 });
    await assert.rejects(
      store.saveSettings({ ...store.publicSettings(), teamInputBudgets: { work: 9 } }),
      /teamInputBudgets/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
