// Daftar pekerjaan: label Otomatis, filter "Pekerjaan saya", banner HOLD sebagai kartu (tugas 0002b).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";

const repo = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFile(path.join(repo, p), "utf8");

async function filterApi() {
  const window = {};
  vm.runInNewContext(await read("ui/runs-filter.js"), { window });
  const f = window.miganRunsFilter;
  // Arrays from the vm realm have another prototype; copy them into this realm before comparing.
  return { ...f, filterRuns: (...a) => Array.from(f.filterRuns(...a), (r) => r) };
}
const runs = [
  { id: "a", title: "Tugas saya", status: "completed" },
  { id: "b", title: "Runner", status: "failed", origin: "bridge" },
  { id: "c", title: "Lain", status: "completed", origin: "ui" },
];

test("isAutomatic hanya untuk origin bridge", async () => {
  const f = await filterApi();
  assert.equal(f.isAutomatic(runs[1]), true);
  assert.equal(f.isAutomatic(runs[0]), false);
  assert.equal(f.isAutomatic(runs[2]), false);
  assert.equal(f.isAutomatic(null), false);
  assert.equal(f.label, "Otomatis");
});

test("bawaan Pekerjaan saya menyembunyikan Otomatis; Semua menampilkan semua", async () => {
  const f = await filterApi();
  assert.equal(f.DEFAULT_MODE, "mine");
  assert.deepEqual(f.filterRuns(runs).map((r) => r.id), ["a", "c"]);
  assert.deepEqual(f.filterRuns(runs, "mine").map((r) => r.id), ["a", "c"]);
  assert.deepEqual(f.filterRuns(runs, "all").map((r) => r.id), ["a", "b", "c"]);
  assert.deepEqual(f.filterRuns(runs, "aneh").map((r) => r.id), ["a", "c"], "mode tak dikenal = bawaan");
  assert.deepEqual(f.filterRuns(undefined, "all"), []);
});

test("keadaan kosong: tanpa pekerjaan, atau semua tersembunyi", async () => {
  const f = await filterApi();
  assert.match(f.emptyText("mine", 0, 0), /pertama/);
  const hidden = f.emptyText("mine", 3, 0);
  assert.match(hidden, /3/);
  assert.match(hidden, /Semua/);
  assert.equal(f.emptyText("mine", 3, 2), "");
  assert.equal(f.emptyText("all", 0, 0).includes("pertama"), true);
});

test("html dan app.js memakai filter serta label", async () => {
  const html = await read("ui/index.html");
  assert.ok(html.includes('src="runs-filter.js"'));
  assert.ok(html.includes('id="historyFilter"'));
  assert.ok(html.includes("Pekerjaan saya"));
  const app = await read("ui/app.js");
  for (const needle of ["miganRunsFilter", "historyFilter", "isAutomatic", "emptyText"])
    assert.ok(app.includes(needle), "app.js tanpa: " + needle);
});

test("banner HOLD berbentuk kartu peringatan dengan tombol utama", async () => {
  const html = await read("ui/index.html");
  const i = html.indexOf('id="holdBanner"');
  const block = html.slice(i - 120, i + 700);
  assert.match(block, /hold-card/);
  assert.match(block, /id="holdBannerIcon"/);
  assert.match(block, /id="holdBannerAction"[^>]*class="primary"|class="primary"[^>]*id="holdBannerAction"/);
  const css = await read("ui/style.css");
  assert.match(css, /\.hold-card\b/);
  assert.match(css, /\.hold-card[^{]*\{[^}]*(--warn|--amber|#f)/);
});

test("riwayat membawa field origin dari penyimpanan run", async () => {
  const main = await read("src/desktop/main.mjs");
  assert.ok(main.includes("withRunOrigin"));
});
