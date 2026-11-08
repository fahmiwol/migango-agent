import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 06xc: the HOLD card must tell the owner what to inspect in plain words, not only raw JSON.
const src = await readFile(new URL("../../ui/kartu-hold.js", import.meta.url), "utf8");
const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
const sandbox = { window: {} };
vm.runInNewContext(src, sandbox);
const { describe } = sandbox.window.miganKartuHold;

const base = {
  tugas: { judul: "Perbaiki tombol simpan", tujuan: "Tombol simpan harus aktif" },
  langkahTerakhir: "Menjalankan tes unit",
  perintahTerputus: { alat: "shell", dimulai: true, selesaiTerbukti: false },
  berkasBerubah: ["src/a.mjs", "src/b.mjs", "ui/c.js"],
  prosesSisa: 0,
  rekomendasi: "periksa-dulu",
  alasan: ["3 berkas berubah", "perintah sudah jalan tanpa bukti selesai"],
  catatan: "Diperiksa otomatis untuk Perbaiki tombol simpan. Rekomendasi: periksa dulu.",
};

test("card shows title, goal, last step, tool, files, processes and recommendation", () => {
  const k = describe(base);
  assert.equal(k.judul, "Perbaiki tombol simpan");
  assert.equal(k.tujuan, "Tombol simpan harus aktif");
  assert.match(k.langkah, /Menjalankan tes unit/);
  assert.match(k.alat, /shell/);
  assert.match(k.alat, /tanpa bukti selesai/);
  assert.deepEqual([...k.berkas], ["src/a.mjs", "src/b.mjs", "ui/c.js"]);
  assert.match(k.proses, /Tidak ada proses/);
  assert.equal(k.aman, false);
  assert.match(k.rekomendasiTeks, /Periksa dulu/);
  assert.match(k.rekomendasiTeks, /3 berkas berubah/);
  assert.equal(k.catatan, base.catatan);
});

test("safe recommendation is shown only when periksaHold said so", () => {
  const k = describe({ ...base, berkasBerubah: [], alasan: [], rekomendasi: "aman-diakui",
    perintahTerputus: { alat: "shell", dimulai: false, selesaiTerbukti: false } });
  assert.equal(k.aman, true);
  assert.match(k.rekomendasiTeks, /Aman diakui/);
  assert.match(k.berkasTeks, /Tidak ada berkas berubah/);
});

test("missing or broken inspection fails closed to periksa dulu", () => {
  for (const bad of [undefined, null, {}, { rekomendasi: "aman-diakui" }]) {
    const k = describe(bad);
    assert.equal(k.aman, false, JSON.stringify(bad));
    assert.match(k.rekomendasiTeks, /Periksa dulu/);
  }
  const unknown = describe({ ...base, berkasBerubah: null, prosesSisa: null });
  assert.match(unknown.berkasTeks, /tidak bisa dibaca/);
  assert.match(unknown.proses, /tidak terverifikasi/);
  assert.match(describe({ ...base, prosesSisa: 2 }).proses, /2 proses masih hidup/);
});

test("refreshRecovery renders the plain card, keeps JSON in a closed detail, prefills the note", () => {
  const at = app.indexOf("async function refreshRecovery(");
  const f = app.slice(at, app.indexOf("\n}\n", at));
  assert.match(f, /window\.miganKartuHold\.describe\(job\.periksa\)/);
  assert.match(f, /note\.value = kartu\.catatan/);
  assert.match(f, /raw\.open = false/);
  // Acknowledge stays a click by the owner: only inside the confirm button handler.
  const calls = f.match(/api\.recoveryResolve\(/g) || [];
  assert.equal(calls.length, 1);
  assert.match(f, /actionButton\("Konfirmasi efek sudah diperiksa", \(\) =>\s*recoveryAction\(\(\) => api\.recoveryResolve\(job\.id, note\.value\)\)/);
  assert.doesNotMatch(app.replace(f, ""), /recoveryResolve\(/);
});

test("kartu-hold.js loads before app.js", () => {
  assert.match(html, /<script src="kartu-hold.js"><\/script>[\s\S]*<script src="app.js">/);
});
