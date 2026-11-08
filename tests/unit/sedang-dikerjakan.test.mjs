import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 06xc step 3: "Sedang dikerjakan" panel on Beranda. Pure logic in ui/sedang-dikerjakan.js.
// UX spec 29 Oct 2026, section 3 (U2): plain-language cards, Indonesian by default, English on request.
const src = await readFile(new URL("../../ui/sedang-dikerjakan.js", import.meta.url), "utf8");
const awam = await readFile(new URL("../../ui/teks-awam.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../../ui/workspace.css", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(awam, { window });
vm.runInNewContext(src, { window });
const S = window.miganSedangDikerjakan;
const plain = (v) => JSON.parse(JSON.stringify(v));

const run = (events, extra = {}) => ({
  id: "r1",
  title: "Bench v2 run 12",
  origin: "bridge",
  status: "running",
  prompt: "ATURAN TETAP (berlaku untuk tugas ini):\n- Jangan push.\n\nTUGAS: hitung median kolom harga di data.csv lalu tulis hasilnya.",
  events,
  ...extra,
});
const tool = (name, id = "a", args) => ({ type: "tool-start", name, id, args });
const done = (name, id = "a") => ({ type: "tool-result", name, id });

test("card texts: title, origin, goal without the rule prefix, automatic badge", () => {
  const k = plain(S.kartu(run([])));
  assert.equal(k.judul, "Bench v2 run 12");
  assert.equal(k.asal, "Asal: Otomatis");
  assert.equal(k.otomatis, true);
  assert.equal(k.tujuan, "Tujuan: hitung median kolom harga di data.csv lalu tulis hasilnya.");
  assert.doesNotMatch(k.tujuan, /ATURAN TETAP|TUGAS/);
  assert.equal(plain(S.kartu(run([]), "en")).asal, "From: Automatic");
  assert.equal(plain(S.kartu(run([]), "en")).tujuan, "Goal: hitung median kolom harga di data.csv lalu tulis hasilnya.");
});

test("origin: empty is You, bridge or runner is Automatic, anything else is unknown", () => {
  assert.equal(plain(S.kartu(run([], { origin: undefined }))).asal, "Asal: Kamu");
  assert.equal(plain(S.kartu(run([], { origin: undefined }), "en")).asal, "From: You");
  assert.equal(plain(S.kartu(run([], { origin: "bridge" }))).asal, "Asal: Otomatis");
  assert.equal(plain(S.kartu(run([], { origin: "runner" }))).asal, "Asal: Otomatis");
  assert.equal(plain(S.kartu(run([], { origin: "mystery" }))).asal, "Asal: Belum diketahui");
  assert.equal(plain(S.kartu(run([], { origin: "mystery" }), "en")).asal, "From: Unknown");
  assert.equal(plain(S.kartu(run([], { origin: "mystery" }))).otomatis, false);
});

test("goal is cut at a word boundary: at most 12 words or 160 characters, then an ellipsis", () => {
  const words = plain(S.kartu(run([], { prompt: "satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua-belas tiga-belas empat-belas", origin: undefined })));
  assert.equal(words.tujuan, "Tujuan: satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas dua-belas…");
  const spaced = plain(S.kartu(run([], { prompt: ("kata ").repeat(60), origin: undefined })));
  assert.ok(spaced.tujuan.length <= "Tujuan: ".length + 160 + 1, "characters are capped");
  assert.ok(spaced.tujuan.endsWith("…"));
  const solid = plain(S.kartu(run([], { prompt: "x".repeat(500), origin: undefined })));
  assert.ok(solid.tujuan.length <= "Tujuan: ".length + 160 + 1);
  assert.ok(solid.tujuan.endsWith("…"));
  assert.equal(plain(S.kartu(run([], { prompt: "Rapikan laporan", origin: undefined }))).tujuan, "Tujuan: Rapikan laporan");
  assert.equal(plain(S.kartu(run([], { prompt: "", origin: undefined }))).tujuan, "Tujuan belum tercatat.");
  assert.equal(plain(S.kartu(run([], { prompt: "", origin: undefined }), "en")).tujuan, "Goal not recorded yet.");
});

test("current step is plain; raw tool names and arguments stay out of the card", () => {
  const now = (events, lang) => plain(S.kartu(run(events), lang)).langkah;
  assert.equal(now([]), "Sekarang: Menyiapkan jawaban.");
  assert.equal(now([tool("read_file", "a", { path: "data.csv" })]), "Sekarang: Membaca berkas.");
  assert.equal(now([tool("write_file")]), "Sekarang: Menulis perubahan.");
  assert.equal(now([tool("edit_file")]), "Sekarang: Menulis perubahan.");
  assert.equal(now([tool("shell", "b", { command: "node secret.mjs" })]), "Sekarang: Menjalankan perintah yang diizinkan.");
  assert.equal(now([tool("web_search")]), "Sekarang: Mengerjakan langkah berikutnya.");
  assert.equal(now([tool("read_file"), done("read_file")]), "Sekarang: Menyiapkan langkah berikutnya.");
  assert.equal(now([tool("shell"), { type: "approval", id: "ap1", tool: "shell" }]), "Sekarang: Menunggu izinmu.");
  assert.equal(now([tool("shell"), { type: "approval", id: "ap1" }, { type: "approval-closed", id: "ap1" }]), "Sekarang: Menjalankan perintah yang diizinkan.");
  assert.equal(now([], "en"), "Now: Preparing an answer.");
  assert.equal(now([tool("read_file")], "en"), "Now: Reading a file.");
  assert.equal(now([tool("write_file")], "en"), "Now: Writing changes.");
  assert.equal(now([tool("shell")], "en"), "Now: Running an approved command.");
  assert.equal(now([tool("shell"), { type: "approval", id: "x" }], "en"), "Now: Waiting for your approval.");
  assert.equal(now([tool("read_file"), done("read_file")], "en"), "Now: Preparing the next step.");
  assert.equal(now([tool("zzz")], "en"), "Now: Working on the next step.");
  const k = plain(S.kartu(run([tool("shell", "b", { command: "node secret.mjs" })])));
  const { rincian, ...visible } = k;
  assert.doesNotMatch(JSON.stringify(visible), /secret|shell/);
});

test("raw tool name and path are kept only in the Rincian data", () => {
  const k = plain(S.kartu(run([tool("read_file", "a", { path: "data.csv" })])));
  assert.equal(k.rincian.alat, "read_file");
  assert.equal(k.rincian.berkas, "data.csv");
  assert.equal(k.rincian.catatanGiliran, "Batas giliran bukan perkiraan waktu selesai.");
  assert.equal(plain(S.kartu(run([]), "en")).rincian.catatanGiliran, "The turn limit does not predict completion time.");
});

test("turns: N from the actual turn, M from the limit attached to the task", () => {
  const turns = (events, extra, lang) => plain(S.kartu(run(events, extra), lang)).giliran;
  assert.equal(turns([tool("read_file"), { type: "turn-usage", turn: 2 }], { turnLimit: 10 }), "Giliran ke-2 dari 10");
  assert.equal(turns([{ type: "turn-usage", turn: 2 }], { turnLimit: 10 }, "en"), "Turn 2 of 10");
  assert.equal(turns([{ type: "thinking", turn: 3, limit: 8 }]), "Giliran ke-3 dari 8");
  assert.equal(turns([{ type: "turn-usage", turn: 2 }]), "Giliran ke-2; batas belum diketahui.");
  assert.equal(turns([{ type: "turn-usage", turn: 2 }], {}, "en"), "Turn 2; limit unknown.");
  assert.equal(turns([]), "Giliran belum tercatat.");
  assert.equal(turns([], {}, "en"), "Turn not recorded yet.");
});

test("cost uses the U5 sentence; unknown cost is never zero", () => {
  const cost = (events, extra, lang) => plain(S.kartu(run(events, extra), lang)).biaya;
  assert.equal(cost([{ type: "agen.pemakaian", cost: 0.0123, inputTokens: 5, outputTokens: 2 }, { type: "agen.pemakaian", cost: 0.0456, inputTokens: 9, outputTokens: 4 }]), "Perkiraan biaya sejauh ini US$0.0456.");
  assert.equal(cost([{ type: "agen.pemakaian", cost: 0.5, inputTokens: 1, outputTokens: 1 }], { status: "responded" }, "en"), "Estimated task cost: US$0.50.");
  assert.equal(cost([{ type: "agen.pemakaian", cost: null, inputTokens: 9, outputTokens: 3 }]), "Harga AI ini belum tersedia; biaya belum diketahui.");
  assert.equal(cost([{ type: "agen.pemakaian", cost: null, inputTokens: 0, outputTokens: 0 }]), "Pemakaian belum dilaporkan; biaya belum diketahui.");
  assert.equal(cost([]), "Biaya belum diketahui.");
  assert.equal(cost([], {}, "en"), "Cost not known yet.");
});

test("a missing title falls back to a plain label", () => {
  assert.equal(plain(S.kartu(run([], { title: "" }))).judul, "Tugas tanpa judul");
  assert.equal(plain(S.kartu(run([], { title: "" }), "en")).judul, "Untitled task");
});

test("only running runs are picked, automatic ones first", () => {
  const ids = plain(S.pilihBerjalan([
    { id: "1", status: "responded", origin: "bridge" },
    { id: "2", status: "running" },
    { id: "3", status: "running", origin: "runner" },
    { id: "4", status: "failed" },
  ])).map((r) => r.id);
  assert.deepEqual(ids, ["3", "2"]);
  assert.deepEqual(plain(S.pilihBerjalan(null)), []);
});

test("Beranda renders the panel from loaded runs; scripts are included", () => {
  assert.match(html, /sedang-dikerjakan\.js/);
  assert.match(html, /id="sedangDikerjakan"/);
  assert.match(app, /miganSedangDikerjakan\.pilihBerjalan/);
  assert.match(app, /miganSedangDikerjakan\.kartu/);
  assert.match(app, /loadRun\(/);
  assert.match(html, /<script src="teks-awam\.js"><\/script>/);
  assert.ok(html.indexOf("teks-awam.js") < html.indexOf("sedang-dikerjakan.js"), "helper loads first");
});

test("cards are articles on a tidy grid; wide text wraps; narrow screens relax the padding", () => {
  assert.match(app, /createElement\("article"\)/);
  assert.match(css, /\.sedang-dikerjakan\s*\{[^}]*display:\s*grid;[^}]*gap:\s*12px/);
  const card = css.match(/\.sedang-kartu\s*\{([^}]*)\}/);
  assert.ok(card, ".sedang-kartu rule");
  for (const need of [/background:\s*var\(--surface\)/, /border:\s*1px solid var\(--line\)/, /border-radius:\s*var\(--radius\)/, /padding:\s*16px/, /display:\s*grid/, /gap:\s*8px/])
    assert.match(card[1], need);
  assert.doesNotMatch(card[1], /(^|[\s;])(height|max-height):/);
  assert.match(css, /\.sedang-kartu\s*>\s*\*[^{]*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width: 599px\)\s*\{[^@]*\.sedang-kartu\s*\{[^}]*padding:\s*12px/);
  assert.match(css, /\.sedang-lencana\s*\{[^}]*background:\s*var\(--accent\);[^}]*color:\s*#[0-9a-f]{3,6}/i);
});
