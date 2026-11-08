import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 06xc2: Panel Kendali + Riwayat pekerjaan. Pure logic in ui/panel-kendali.js, tested in a vm.
const src = await readFile(new URL("../../ui/panel-kendali.js", import.meta.url), "utf8");
function load() {
  const window = {};
  vm.runInNewContext(src, { window });
  return window.miganPanelKendali;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const P = load();

const report = (usd, capUsd) => ({
  date: "2026-10-28",
  providers: [
    { provider: "kimi", usd, capUsd, tokens: 1000, capTokens: 100000000 },
    { provider: "anthropic", usd: 0.5, capUsd: 5, tokens: 10, capTokens: 2000000 },
  ],
});

test("US$ vs daily cap comes from the meter report, not a fixed number", () => {
  const a = plain(P.budgetLine(report(1.25, 5), "kimi"));
  assert.equal(a.usd, 1.25);
  assert.equal(a.capUsd, 5);
  assert.equal(a.percent, 25);
  assert.match(a.text, /US\$1\.25 dari US\$5\.00/);
  const b = plain(P.budgetLine(report(3, 4), "kimi"));
  assert.equal(b.percent, 75, "changes when the meter changes");
  assert.match(b.text, /US\$3\.00 dari US\$4\.00/);
});

test("an unreadable meter or unpriced usage is said honestly, never shown as zero", () => {
  const none = plain(P.budgetLine(null, "kimi"));
  assert.equal(none.usd, null);
  assert.match(none.text, /belum terbaca/);
  const unpriced = plain(P.budgetLine(report(null, 5), "kimi"));
  assert.equal(unpriced.usd, null);
  assert.doesNotMatch(unpriced.text, /US\$0\.00/);
  const nocap = plain(P.budgetLine(report(2, null), "kimi"));
  assert.equal(nocap.percent, null);
  assert.match(nocap.text, /tanpa pagu/);
  const missing = plain(P.budgetLine(report(1, 5), "openai"));
  assert.equal(missing.usd, null);
});

test("every number is a clickable metric that opens a plain explanation with per-step detail", () => {
  const steps = [
    { turn: 1, tool: "read_file", inputTokens: 1000, outputTokens: 50, cachedTokens: 500, usd: 0.01 },
    { turn: 2, tool: "edit_file", inputTokens: 3000, outputTokens: 150, cachedTokens: 1500, usd: 0.02 },
  ];
  for (const kind of ["inputTokens", "outputTokens", "cacheRead", "usd", "turns"]) {
    const m = plain(P.metric(kind, steps, { maxTurns: 25 }));
    assert.equal(m.clickable, true, kind);
    assert.ok(m.ariaLabel.length > 5, kind + " has an accessible label");
    const e = plain(P.explain(kind, steps, { maxTurns: 25 }));
    assert.ok(e.apa && e.kenapa, kind + " explains what and why");
    assert.equal(e.rincian.length, 2, kind + " lists each step");
  }
  assert.equal(plain(P.metric("inputTokens", steps)).value, 4000);
  assert.equal(plain(P.metric("cacheRead", steps)).value, 50, "cache-read % of input");
  assert.match(plain(P.metric("turns", steps, { maxTurns: 25 })).text, /2 dari 25/);
  assert.throws(() => P.explain("rahasia", steps), /metrik/);
});

test("steps without trace numbers say 'belum dicatat' instead of inventing values", () => {
  const steps = P.stepsFromEvents([
    { type: "tool-start", name: "read_file" },
    { type: "tool-result", name: "read_file" },
    { type: "tool-start", name: "shell" },
  ]);
  assert.deepEqual(plain(steps).map((s) => s.tool), ["read_file", "shell"]);
  const e = plain(P.explain("inputTokens", steps));
  assert.match(e.rincian[0].nilai, /belum dicatat/);
  assert.equal(plain(P.metric("inputTokens", steps)).value, null);
});

test("status is plain language; raw error codes stay in the detail only", () => {
  const s = plain(P.plainStatus({ status: "failed", errorCode: "ERR_COST_CAP", error: "ERR_COST_CAP: Pagu biaya harian kimi tercapai" }));
  assert.doesNotMatch(s.text, /ERR_/);
  assert.match(s.text, /pagu/i);
  assert.match(s.detail, /ERR_COST_CAP/);
  const unknown = plain(P.plainStatus({ status: "failed", errorCode: "ERR_XYZ", error: "ERR_XYZ boom" }));
  assert.doesNotMatch(unknown.text, /ERR_|boom/);
  assert.equal(plain(P.plainStatus({ status: "running" })).text, "Sedang dikerjakan");
});

const runs = [
  { id: "1", title: "Perbaiki login", status: "responded", origin: undefined },
  { id: "2", title: "Bench v2 run", status: "failed", origin: "bridge" },
  { id: "3", title: "Runner putaran", status: "responded", origin: "runner" },
  { id: "4", title: "Login gagal", status: "interrupted" },
];
test("Riwayat filters: pemilik, otomatis (bridge/runner), gagal, and title search", () => {
  const ids = (f, q) => plain(P.filterRiwayat(runs, f, q)).map((r) => r.id);
  assert.deepEqual(ids("semua"), ["1", "2", "3", "4"]);
  assert.deepEqual(ids("pemilik"), ["1", "4"]);
  assert.deepEqual(ids("otomatis"), ["2", "3"]);
  assert.deepEqual(ids("gagal"), ["2", "4"]);
  assert.deepEqual(ids("semua", "LOGIN"), ["1", "4"]);
  assert.deepEqual(ids("gagal", "login"), ["4"]);
});

test("a Riwayat row shows title, goal, model, start, duration, US$ and plain status", () => {
  const row = plain(
    P.riwayatRow({
      id: "9", title: "Tulis laporan", prompt: "Buat laporan mingguan dari data penjualan",
      profile: { provider: "kimi", model: "kimi-k2.6" }, created: "2026-10-28T01:00:00Z",
      updated: "2026-10-28T01:02:05Z", status: "failed", errorCode: "ERR_COST_CAP", usage: { cost: 0.123 },
    }),
  );
  assert.equal(row.judul, "Tulis laporan");
  assert.match(row.tujuan, /laporan mingguan/);
  assert.equal(row.model, "kimi / kimi-k2.6");
  assert.equal(row.durasi, "2 m 5 d");
  assert.equal(row.usd, "US$0.12");
  assert.doesNotMatch(row.status, /ERR_/);
  assert.equal(plain(P.riwayatRow({ title: "x", status: "responded" })).usd, "belum tercatat");
});

test("the active panel lists model, step n of the limit, tool, duration, budget, queue and last result", () => {
  const view = plain(
    P.describeActive({
      run: { title: "Bangun app", profile: { provider: "kimi", model: "kimi-k2.6" }, created: "2026-10-28T01:00:00Z", status: "running" },
      steps: [{ turn: 1, tool: "read_file" }, { turn: 2, tool: "edit_file" }],
      maxTurns: 25,
      now: Date.parse("2026-10-28T01:01:30Z"),
      report: report(1, 4),
      queue: [{ title: "Run berikutnya" }],
      last: { title: "Run kemarin", status: "failed", errorCode: "ERR_COST_CAP" },
    }),
  );
  assert.equal(view.model, "kimi / kimi-k2.6");
  assert.match(view.langkah, /Langkah 2 dari 25/);
  assert.equal(view.alat, "edit_file");
  assert.equal(view.durasi, "1 m 30 d");
  assert.match(view.biaya.text, /US\$1\.00 dari US\$4\.00/);
  assert.equal(view.antrean, "Run berikutnya");
  assert.equal(view.terakhir.lulus, false);
  assert.doesNotMatch(view.terakhir.text, /ERR_/);
  assert.equal(view.trace.length, 2);
  const idle = plain(P.describeActive({ run: null, report: null }));
  assert.equal(idle.aktif, false);
  assert.match(idle.text, /Tidak ada pekerjaan/);
});
