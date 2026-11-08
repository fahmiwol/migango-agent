// Round runner (task 06b1): every round is a fresh run built from the goal and progress.md;
// the host commits after each round and stops hard. All dependencies are fakes.
import test from "node:test";
import assert from "node:assert/strict";
import { jalankanPutaran, bangunPrompt, tujuanTercapai, potongEkor } from "../../src/runflow/putaran.mjs";

const SELESAI = "## Selesai\n- semua\nSTATUS: SELESAI\n";

// script: one entry per round { status, usd, progress, throws }
function rig(script, { awal = "", anggaranUsd = 10, maksPutaran = 5, commitThrows = false } = {}) {
  let progress = awal;
  const prompts = [];
  const commits = [];
  let i = 0;
  const deps = {
    tujuan: "Bangun fitur X dengan tes hijau",
    maksPutaran,
    anggaranUsd,
    sekarang: () => new Date("2026-10-27T00:00:00Z"),
    bacaProgress: async () => progress,
    mulaiRun: async ({ prompt, ke }) => {
      prompts.push({ prompt, ke });
      const s = script[i++];
      if (!s) throw new Error("script habis");
      if (s.progress !== undefined) progress = s.progress;
      if (s.throws) throw new Error("runtime mati");
      return { id: "run-" + i, status: s.status, usd: s.usd };
    },
    hargaRun: (run) => run.usd,
    commitPutaran: async (ke, ringkasan) => {
      if (commitThrows) throw new Error("git gagal");
      commits.push({ ke, ringkasan });
      return "sha" + ke;
    },
  };
  return { deps, prompts, commits, get dipanggil() { return i; } };
}

test("goal reached stops with tujuan-tercapai after the round that wrote STATUS: SELESAI", async () => {
  const r = rig([
    { status: "responded", usd: 1, progress: "## Sisa\n- banyak\n" },
    { status: "responded", usd: 1, progress: SELESAI },
    { status: "responded", usd: 1 },
  ]);
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "tujuan-tercapai");
  assert.equal(out.putaran.length, 2);
  assert.deepEqual(out.putaran.map((p) => p.ke), [1, 2]);
  assert.equal(out.putaran[1].runId, "run-2");
  assert.equal(out.putaran[1].commit, "sha2");
  assert.equal(out.putaran[1].usd, 1);
});

test("STATUS: SELESAI with verification-failed is not goal reached", async () => {
  const r = rig([
    { status: "verification-failed", usd: 1, progress: SELESAI },
    { status: "responded", usd: 1 },
  ], { maksPutaran: 2 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.putaran[0].status, "verification-failed");
  assert.equal(out.alasanBerhenti, "tujuan-tercapai");
  assert.equal(out.putaran.length, 2);
});

test("STATUS: SELESAI with a failed run is not goal reached", async () => {
  const r = rig([
    { status: "failed", usd: 1, progress: SELESAI },
    { status: "responded", usd: 1 },
  ]);
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.putaran.length, 2);
  assert.equal(out.alasanBerhenti, "tujuan-tercapai");
});

test("goal needs an exact STATUS line, not a mention inside text", () => {
  assert.equal(tujuanTercapai("STATUS: SELESAI\n", "responded"), true);
  assert.equal(tujuanTercapai("x\n  STATUS: SELESAI  \ny", "needs-validation"), true);
  assert.equal(tujuanTercapai("tulis 'STATUS: SELESAI' nanti", "responded"), false);
  assert.equal(tujuanTercapai("STATUS: BELUM", "responded"), false);
  assert.equal(tujuanTercapai(SELESAI, "verification-failed"), false);
  assert.equal(tujuanTercapai(SELESAI, "failed"), false);
  assert.equal(tujuanTercapai(null, "responded"), false);
});

test("max rounds stops with maks-putaran and never starts an extra run", async () => {
  const r = rig([
    { status: "responded", usd: 1 },
    { status: "responded", usd: 1 },
    { status: "responded", usd: 1 },
    { status: "responded", usd: 1 },
  ], { maksPutaran: 3 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "maks-putaran");
  assert.equal(out.putaran.length, 3);
  assert.equal(r.dipanggil, 3);
});

test("budget: stops before a round whose average estimate would exceed the budget", async () => {
  // 3 + 3 = 6; next estimate 3 -> 9 > 8, so round 3 never starts.
  const r = rig([
    { status: "responded", usd: 3 },
    { status: "responded", usd: 3 },
    { status: "responded", usd: 1 },
  ], { anggaranUsd: 8 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "anggaran");
  assert.equal(out.putaran.length, 2);
  assert.equal(r.dipanggil, 2);
  assert.equal(out.totalUsd, 6);
  assert.match(out.alasan, /rata-rata/);
});

test("budget: an estimate exactly at the budget is still allowed", async () => {
  const r = rig([
    { status: "responded", usd: 2 },
    { status: "responded", usd: 2, progress: SELESAI },
  ], { anggaranUsd: 4 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "tujuan-tercapai");
  assert.equal(out.putaran.length, 2);
});

test("budget: an actual overshoot stops at once", async () => {
  const r = rig([
    { status: "responded", usd: 12 },
    { status: "responded", usd: 1 },
  ], { anggaranUsd: 10 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "anggaran");
  assert.equal(out.putaran.length, 1);
  assert.equal(out.putaran[0].commit, "sha1");
});

test("budget: an overshoot in the last round reports anggaran, not maks-putaran", async () => {
  const r = rig([{ status: "responded", usd: 12 }], { anggaranUsd: 10, maksPutaran: 1 });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "anggaran");
  assert.match(out.alasan, /melewati anggaran/);
});

test("budget: unknown cost fails closed", async () => {
  const r = rig([{ status: "responded", usd: undefined }, { status: "responded", usd: 1 }]);
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "anggaran");
  assert.equal(out.putaran.length, 1);
});

test("two run errors in a row stop with galat", async () => {
  const r = rig([
    { status: "failed", usd: 1 },
    { throws: true },
    { status: "responded", usd: 1 },
  ]);
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "galat");
  assert.equal(out.putaran.length, 2);
  assert.equal(out.putaran[1].status, "galat");
  assert.equal(out.putaran[1].runId, null);
  assert.equal(r.commits.length, 2);
});

test("one error followed by success resets the error streak", async () => {
  const r = rig([
    { status: "failed", usd: 1 },
    { status: "responded", usd: 1 },
    { status: "failed", usd: 1 },
    { status: "responded", usd: 1, progress: SELESAI },
  ]);
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "tujuan-tercapai");
  assert.equal(out.putaran.length, 4);
});

test("host commits after every round with round number and summary", async () => {
  const r = rig([
    { status: "responded", usd: 1 },
    { status: "responded", usd: 1, progress: SELESAI },
  ]);
  await jalankanPutaran(r.deps);
  assert.deepEqual(r.commits.map((c) => c.ke), [1, 2]);
  assert.match(r.commits[0].ringkasan, /putaran 1/);
  assert.match(r.commits[0].ringkasan, /responded/);
});

test("a failing host commit stops with galat", async () => {
  const r = rig([{ status: "responded", usd: 1 }, { status: "responded", usd: 1 }], { commitThrows: true });
  const out = await jalankanPutaran(r.deps);
  assert.equal(out.alasanBerhenti, "galat");
  assert.equal(out.putaran.length, 1);
  assert.equal(out.putaran[0].commit, null);
});

test("each round gets a fresh prompt with goal, round number and the latest progress", async () => {
  const r = rig([
    { status: "responded", usd: 1, progress: "## Langkah berikut\n- tulis tes Y\n" },
    { status: "responded", usd: 1, progress: SELESAI },
  ], { awal: "kosong-awal" });
  await jalankanPutaran(r.deps);
  assert.match(r.prompts[0].prompt, /kosong-awal/);
  assert.match(r.prompts[1].prompt, /tulis tes Y/);
  assert.doesNotMatch(r.prompts[1].prompt, /kosong-awal/);
  assert.match(r.prompts[1].prompt, /Bangun fitur X/);
  assert.equal(r.prompts[1].ke, 2);
});

test("prompt carries the update and STATUS instructions", () => {
  const p = bangunPrompt({ tujuan: "T", progress: "", ke: 2, maksPutaran: 4 });
  assert.match(p, /Putaran 2 dari 4/);
  assert.match(p, /progress\.md/);
  assert.match(p, /selesai/i);
  assert.match(p, /sisa/i);
  assert.match(p, /langkah berikut/i);
  assert.match(p, /STATUS: SELESAI/);
  assert.match(p, /tes hijau/);
});

test("long progress is cut to the last 8000 characters", () => {
  const long = "AWAL" + "x".repeat(9000) + "EKOR";
  const cut = potongEkor(long, 8000);
  assert.ok(cut.endsWith("EKOR"));
  assert.ok(!cut.includes("AWAL"));
  assert.ok(cut.length <= 8000 + 40);
  assert.equal(potongEkor("pendek", 8000), "pendek");
  const p = bangunPrompt({ tujuan: "T", progress: long, ke: 1, maksPutaran: 1 });
  assert.ok(!p.includes("AWAL"));
  assert.ok(p.includes("EKOR"));
});

test("invalid options are rejected before any run", async () => {
  const r = rig([{ status: "responded", usd: 1 }]);
  await assert.rejects(jalankanPutaran({ ...r.deps, tujuan: "" }), TypeError);
  await assert.rejects(jalankanPutaran({ ...r.deps, maksPutaran: 0 }), TypeError);
  await assert.rejects(jalankanPutaran({ ...r.deps, anggaranUsd: -1 }), TypeError);
  await assert.rejects(jalankanPutaran({ ...r.deps, mulaiRun: null }), TypeError);
  assert.equal(r.dipanggil, 0);
});
