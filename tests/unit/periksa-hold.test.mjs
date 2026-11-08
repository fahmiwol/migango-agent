// 06xc: plain-language HOLD inspection. The recommendation may only be "aman-diakui" when
// nothing is left to check; everything unknown fails closed to "periksa-dulu".
import test from "node:test";
import assert from "node:assert/strict";
import { periksaHold } from "../../src/recovery/periksa-hold.mjs";

const baseRow = {
  id: "11111111-2222-3333-4444-555555555555",
  kind: "shell",
  status: "hold",
  reason: "Host interrupted; external effects are unknown and will not be replayed",
  pid: null,
  started: null,
  exitCode: null,
  observation: "unbound",
};
const run = {
  title: "Rapikan folder laporan",
  prompt: "Pindahkan berkas laporan lama ke arsip lalu buat ringkasan. ".repeat(10),
  trace: [
    { label: "Membaca daftar berkas" },
    { label: "Menjalankan perintah pindah berkas" },
  ],
};

test("0 berkas + 0 proses + perintah belum dimulai => aman-diakui", () => {
  const r = periksaHold({ row: baseRow, run, git: { files: [] }, prosesHidup: 0 });
  assert.equal(r.rekomendasi, "aman-diakui");
  assert.equal(r.prosesSisa, 0);
  assert.deepEqual(r.berkasBerubah, []);
  assert.equal(r.tugas.judul, "Rapikan folder laporan");
  assert.ok(r.tugas.tujuan.length <= 161);
  assert.equal(r.langkahTerakhir, "Menjalankan perintah pindah berkas");
  assert.equal(r.perintahTerputus.alat, "shell");
  assert.equal(r.perintahTerputus.dimulai, false);
  assert.ok(r.catatan.length >= 10 && r.catatan.length <= 1000);
});

test("3 berkas berubah => periksa-dulu dengan jumlah berkas di catatan", () => {
  const r = periksaHold({
    row: baseRow,
    run,
    git: { files: ["a.txt", "b/c.md", "d.json"] },
    prosesHidup: 0,
  });
  assert.equal(r.rekomendasi, "periksa-dulu");
  assert.deepEqual(r.berkasBerubah, ["a.txt", "b/c.md", "d.json"]);
  assert.match(r.catatan, /3 berkas berubah/);
});

test("proses masih hidup => periksa-dulu", () => {
  const r = periksaHold({ row: baseRow, run, git: { files: [] }, prosesHidup: 1 });
  assert.equal(r.rekomendasi, "periksa-dulu");
  assert.equal(r.prosesSisa, 1);
  assert.match(r.catatan, /proses masih hidup/);
});

test("observasi jurnal present tanpa angka proses => periksa-dulu", () => {
  const r = periksaHold({
    row: { ...baseRow, pid: 42, started: "1", observation: "present" },
    run,
    git: { files: [] },
  });
  assert.equal(r.prosesSisa, 1);
  assert.equal(r.rekomendasi, "periksa-dulu");
});

test("perintah sudah jalan tanpa bukti selesai => periksa-dulu", () => {
  const r = periksaHold({
    row: { ...baseRow, pid: 42, started: "123", observation: "absent" },
    run,
    git: { files: [] },
    prosesHidup: 0,
  });
  assert.equal(r.perintahTerputus.dimulai, true);
  assert.equal(r.perintahTerputus.selesaiTerbukti, false);
  assert.equal(r.rekomendasi, "periksa-dulu");
  assert.match(r.catatan, /tanpa bukti selesai/);
});

test("perintah jalan dan selesai terbukti, tanpa sisa => aman-diakui", () => {
  const r = periksaHold({
    row: { ...baseRow, pid: 42, started: "123", exitCode: 0, observation: "absent" },
    run,
    git: { files: [] },
    prosesHidup: 0,
  });
  assert.equal(r.perintahTerputus.selesaiTerbukti, true);
  assert.equal(r.rekomendasi, "aman-diakui");
});

test("git tidak terbaca => periksa-dulu, bukan dianggap kosong", () => {
  const r = periksaHold({
    row: baseRow,
    run,
    git: { error: "bukan repo git" },
    prosesHidup: 0,
  });
  assert.equal(r.berkasBerubah, null);
  assert.equal(r.rekomendasi, "periksa-dulu");
});

test("proses tidak terverifikasi => periksa-dulu", () => {
  const r = periksaHold({
    row: { ...baseRow, observation: "unknown" },
    run,
    git: { files: [] },
  });
  assert.equal(r.prosesSisa, null);
  assert.equal(r.rekomendasi, "periksa-dulu");
});

test("tanpa run tetap memberi judul dan langkah yang jujur", () => {
  const r = periksaHold({ row: baseRow, git: { files: [] }, prosesHidup: 0 });
  assert.equal(typeof r.tugas.judul, "string");
  assert.ok(r.tugas.judul.length > 0);
  assert.equal(r.langkahTerakhir, null);
});
