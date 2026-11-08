// CLI benchmark backbone (RISET-013): argumen, penjaga plafon dan pagu biaya, alur run dengan fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { bacaArgumen, estimasiPlafon, PAGU_PLAFON_USD, jalankanBenchmark } from "../../scripts/backbone.mjs";

const set = { tugas: [
  { id: "a", kategori: "data", prompt: "Berapa 2+2? Jawab angka.", nilai: { jawabanCocok: ["^4$"] } },
  { id: "b", kategori: "konten", prompt: "Tulis kata halo.", nilai: { wajibKata: ["halo"] } },
] };

test("bawaan: ollama, 3 ulangan, plafon mati", () => {
  const a = bacaArgumen(["--model", "kecil"]);
  assert.equal(a.penyedia, "ollama");
  assert.equal(a.model, "kecil");
  assert.equal(a.ulangan, 3);
  assert.equal(a.plafon, false);
});

test("argumen salah ditolak, tidak ditebak", () => {
  assert.throws(() => bacaArgumen([]), /--model/);
  assert.throws(() => bacaArgumen(["--model", "m", "--ulangan", "0"]), /ulangan/);
  assert.throws(() => bacaArgumen(["--model", "m", "--ulangan", "11"]), /ulangan/);
  assert.throws(() => bacaArgumen(["--model", "m", "--asing"]), /tidak dikenal/);
});

test("plafon butuh izin eksplisit dan harga dari pemilik", () => {
  assert.throws(() => bacaArgumen(["--model", "m", "--plafon-model", "sonnet"]), /--izinkan-plafon/);
  assert.throws(() => bacaArgumen(["--model", "m", "--plafon-model", "sonnet", "--izinkan-plafon"]), /harga/);
  const a = bacaArgumen(["--model", "m", "--plafon-model", "sonnet", "--izinkan-plafon", "--harga-input", "3", "--harga-output", "15"]);
  assert.equal(a.plafon, true);
  assert.deepEqual(a.harga, { input: 3, output: 15 });
  assert.throws(() => bacaArgumen(["--model", "m", "--plafon-model", "s", "--izinkan-plafon", "--harga-input", "-1", "--harga-output", "15"]), /harga/);
});

test("estimasi plafon terburuk dihitung dari byte dan maxTokens; pagu US$1", () => {
  assert.equal(PAGU_PLAFON_USD, 1);
  const tugas = [{ prompt: "x".repeat(2997), berkas: {} }];
  // ceil((2997 + 200) / 3) = 1066 token masuk, 512 keluar.
  assert.equal(estimasiPlafon(tugas, { input: 1, output: 1 }, 512), (1066 + 512) / 1e6);
  assert.ok(estimasiPlafon(tugas, { input: 1e6, output: 0 }, 512) > PAGU_PLAFON_USD);
});

test("jalankanBenchmark menilai kedua lengan per ulangan dan menolak plafon di atas pagu", async () => {
  const panggil = async (req) => ({ text: req.tools?.length || req.system.includes("JSON satu baris") ? "{\"jawaban\":\"4\",\"sumber\":[]}" : "4", calls: [], usage: { input: 1, output: 1 } });
  const out = await jalankanBenchmark({ set, ulangan: 2, panggilKecil: panggil, penyedia: "ollama" });
  assert.equal(out.hasil.length, 2 * 2 * 2);
  assert.ok(out.hasil.every((h) => h.biaya === 0));
  assert.equal(out.laporan.total.n, 2);
  await assert.rejects(() => jalankanBenchmark({ set, ulangan: 1, panggilKecil: panggil, penyedia: "ollama", plafon: { ids: ["a"], panggil, harga: { input: 1e9, output: 1e9 }, maxTokens: 512 } }), /pagu/);
});
