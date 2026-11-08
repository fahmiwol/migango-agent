// Penjaga tambahan benchmark backbone (RISET-013), ditulis dari mutan yang selamat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { jalankanBackbone, hitungAman, biaya, laporan, POTONG_ALAT } from "../../src/eval/backbone.mjs";

test("hasil alat dipotong POTONG_ALAT karakter sebelum masuk konteks", async () => {
  const t = { id: "x", kategori: "data", prompt: "Baca besar.txt", berkas: { "besar.txt": "a".repeat(5000) }, nilai: { jawabanMemuat: ["a"] } };
  const dilihat = [];
  let n = 0;
  const panggil = async (req) => {
    n++;
    for (const m of req.messages) if (m.role === "tool") dilihat.push(String(m.content).length);
    if (n === 2) return { text: "", calls: [{ id: "c1", name: "baca_berkas", args: { path: "besar.txt" } }], usage: {} };
    return { text: "{\"jawaban\":\"a\",\"sumber\":[]}", calls: [], usage: {} };
  };
  await jalankanBackbone(t, panggil, { batas: { anggaranKonteks: 1e9 } });
  assert.ok(dilihat.length > 0);
  assert.ok(dilihat.every((x) => x <= POTONG_ALAT), "panjang " + dilihat.join(","));
});

test("kalkulator menolak karakter di luar daftar dengan pesan saringan", () => {
  assert.throws(() => hitungAman("process.exit"), /hanya angka/);
  assert.throws(() => hitungAman("2;3"), /hanya angka/);
  assert.equal(hitungAman("2^3+1"), 9);
});

test("biaya tanpa harga lengkap = null, tidak ditebak", () => {
  assert.equal(biaya("anthropic", { input: 10, output: 10 }, { input: 3 }), null);
  assert.equal(biaya("anthropic", { input: 10, output: 10 }, { output: 3 }), null);
  assert.equal(biaya("anthropic", { input: 10, output: 10 }, null), null);
  assert.equal(biaya("ollama", { input: 10, output: 10 }, null), 0);
});

const h = (id, lengan, lulus, b = 0) => ({ id, kategori: "data", lengan, ulangan: 1, lulus, ms: 10, biaya: b, panggilan: 1 });

test("ongkos lengan null bila ada biaya tak diketahui", () => {
  const L = laporan([h("a", "polos", false), h("a", "backbone", true), h("a", "plafon", true, null)], { subsetPlafon: ["a"] });
  assert.equal(L.biaya.plafon, null);
  assert.equal(L.biaya.polos, 0);
});

test("H1 butuh batas bawah CI > 0, bukan hanya kenaikan >= 0.15", () => {
  const hasil = [];
  ["a", "b", "c", "d"].forEach((id, i) => { hasil.push(h(id, "polos", false)); hasil.push(h(id, "backbone", i === 0)); });
  const L = laporan(hasil);
  assert.equal(L.total.kenaikan, 0.25);
  assert.ok(!(L.total.ci[0] > 0));
  assert.equal(L.vonis.H1, false);
});
