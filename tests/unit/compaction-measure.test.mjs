import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Markas (26 Oct 2026): do not raise childSteps; measure how often child compaction fires in real
// team runs and propose a number from data. The tool reads saved runs and prints aggregates only
// (no prompt, task or file text).
const measure = await import("../../scripts/ukur-compaction-anak.mjs").catch(() => ({}));

const child = (over = {}) => ({
  id: over.id || "c1",
  parentRunId: "p1",
  agentId: "koda",
  prompt: "TUGAS_RAHASIA tidak boleh tampil",
  status: "needs-validation",
  budget: { steps: 2, inputBytes: 24000, inputBytesUsed: 9000, preludeBytes: 1200 },
  events: [{ type: "thinking", turn: 1 }, { type: "thinking", turn: 2 }],
  ...over,
});

test("aggregates child runs: steps used, compactions and why each child stopped", () => {
  const runs = [
    { id: "p1", status: "needs-validation", events: [] },
    child(),
    child({ id: "c2", status: "failed", error: "Child model step budget exhausted" }),
    child({ id: "c3", status: "failed", error: "Child input byte budget exhausted" }),
    child({ id: "c4", status: "failed", error: "Child context window exhausted" }),
    child({
      id: "c5",
      budget: { steps: 8, inputBytes: 200000, inputBytesUsed: 50000, preludeBytes: 1200 },
      events: [1, 2, 3, 4, 5].map((t) => ({ type: "thinking", turn: t })).concat([{ type: "context-compacted", turn: 4 }]),
    }),
  ];
  const r = measure.measureChildRuns(runs);
  assert.equal(r.children, 5);
  assert.equal(r.withCompaction, 1);
  assert.equal(r.compactions, 1);
  assert.deepEqual(r.stops, { selesai: 2, "batas-langkah": 1, "batas-input": 1, "jendela-konteks": 1 });
  assert.deepEqual(r.stepsUsed, { 2: 4, 5: 1 });
  assert.deepEqual(r.stepBudgets, { 2: 4, 8: 1 });
  assert.ok(!JSON.stringify(r).includes("TUGAS_RAHASIA"), "aggregates only, no task text");
});

test("the proposal follows the data and never invents a number without runs", () => {
  assert.match(measure.measureChildRuns([]).proposal, /belum ada data/i);
  const many = Array.from({ length: 10 }, (_, i) =>
    child({ id: "s" + i, ...(i < 4 ? { status: "failed", error: "Child model step budget exhausted" } : {}) }),
  );
  const r = measure.measureChildRuns(many);
  assert.equal(r.stops["batas-langkah"], 4);
  assert.match(r.proposal, /childSteps 3/);
  const few = Array.from({ length: 10 }, (_, i) => child({ id: "f" + i }));
  assert.match(measure.measureChildRuns(few).proposal, /tetap 2/);
  const tiny = [child({ status: "failed", error: "Child model step budget exhausted" })];
  assert.match(measure.measureChildRuns(tiny).proposal, /terlalu sedikit/i, "fewer than 10 children is not enough data");
});

test("the command reads a runs folder, skips unreadable files, and prints JSON", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-measure-"));
  try {
    await fs.writeFile(path.join(dir, "11111111-1111-1111-1111-111111111111.json"), JSON.stringify(child()));
    await fs.writeFile(path.join(dir, "rusak.json"), "{bukan json");
    await fs.writeFile(path.join(dir, "catatan.txt"), "abaikan");
    const script = new URL("../../scripts/ukur-compaction-anak.mjs", import.meta.url);
    const r = spawnSync(process.execPath, [script.pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--dir", dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.children, 1);
    assert.equal(out.unreadable, 1);
    assert.equal(out.files, 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
