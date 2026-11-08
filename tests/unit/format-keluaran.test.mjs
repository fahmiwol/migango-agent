// Task 06xg2: structured output verifier. Benchmark v2 showed that about half of the failures were
// answer FORMAT (number not on the last line, thousands separators), not content. The checker
// only judges; it never rewrites the answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { periksaFormat, validasiSpek } from "../../src/agents/format-keluaran.mjs";

const BULAT = { jenis: "angka-bulat" };

test("an integer on the last line passes and returns its value", () => {
  const r = periksaFormat("Dari 16 baris totalnya sebagai berikut.\n\n8364500\n", BULAT);
  assert.deepEqual(r, { ok: true, nilai: 8364500, alasan: null });
  assert.equal(periksaFormat("-12", BULAT).nilai, -12);
});

test("thousands separators fail with a reason and are never normalised", () => {
  for (const t of ["8.364.500", "8,364,500", "8 364 500", "8_364_500"]) {
    const r = periksaFormat("Total:\n" + t, BULAT);
    assert.equal(r.ok, false, t);
    assert.equal(r.nilai, null, t);
    assert.match(r.alasan, /pemisah/, t);
  }
});

test("a number that is not on the last line fails", () => {
  for (const t of ["8364500\nItulah jawabannya.", "Jawaban: 8364500", "**8364500**", "8364500 unit"]) {
    const r = periksaFormat(t, BULAT);
    assert.equal(r.ok, false, t);
    assert.equal(r.nilai, null, t);
    assert.match(r.alasan, /baris terakhir/, t);
  }
});

test("empty or missing text fails", () => {
  for (const t of ["", "  \n ", null, undefined, 42]) assert.equal(periksaFormat(t, BULAT).ok, false);
});

test("decimals: dot passes for angka, comma fails, angka-bulat rejects fractions", () => {
  assert.deepEqual(periksaFormat("x\n12.5", { jenis: "angka" }), { ok: true, nilai: 12.5, alasan: null });
  assert.equal(periksaFormat("12,5", { jenis: "angka" }).ok, false);
  assert.equal(periksaFormat("12.5", BULAT).ok, false);
  assert.equal(periksaFormat("99999999999999999999", BULAT).ok, false, "unsafe integer");
});

test("truncated output fails even when the text looks valid", () => {
  const r = periksaFormat("8364500", BULAT, { terpotong: true });
  assert.equal(r.ok, false);
  assert.equal(r.nilai, null);
  assert.match(r.alasan, /terpotong/);
  assert.equal(periksaFormat('{"a":1}', { jenis: "json" }, { terpotong: true }).ok, false);
});

test("teks-satu-baris returns the last non-empty line and refuses empty or long lines", () => {
  assert.deepEqual(periksaFormat("penjelasan\nBandung\n", { jenis: "teks-satu-baris" }), { ok: true, nilai: "Bandung", alasan: null });
  assert.equal(periksaFormat("x\n" + "a".repeat(501), { jenis: "teks-satu-baris" }).ok, false);
});

const SKEMA = {
  type: "object",
  required: ["kota", "total"],
  properties: {
    kota: { type: "string", maxLength: 20 },
    total: { type: "integer", minimum: 0, maximum: 1000 },
    tag: { type: "array", items: { type: "string", enum: ["a", "b"] } },
  },
};
const JSON_SPEK = { jenis: "json", skema: SKEMA };

test("valid JSON passes, also inside one ```json fence", () => {
  const nilai = { kota: "Bandung", total: 10, tag: ["a"] };
  assert.deepEqual(periksaFormat(JSON.stringify(nilai), JSON_SPEK), { ok: true, nilai, alasan: null });
  assert.deepEqual(periksaFormat("```json\n" + JSON.stringify(nilai) + "\n```", JSON_SPEK).nilai, nilai);
});

test("JSON with a missing field, wrong type or out-of-range value fails with the path", () => {
  const cases = [
    [{ kota: "Bandung" }, /total/],
    [{ kota: "Bandung", total: "10" }, /total/],
    [{ kota: "Bandung", total: 10.5 }, /total/],
    [{ kota: "Bandung", total: 1001 }, /total/],
    [{ kota: "Bandung", total: -1 }, /total/],
    [{ kota: 5, total: 1 }, /kota/],
    [{ kota: "Bandung", total: 1, tag: ["c"] }, /tag/],
    [[1], /object/],
  ];
  for (const [value, path] of cases) {
    const r = periksaFormat(JSON.stringify(value), JSON_SPEK);
    assert.equal(r.ok, false, JSON.stringify(value));
    assert.equal(r.nilai, null);
    assert.match(r.alasan, path, JSON.stringify(value));
  }
});

test("truncated or surrounded JSON fails", () => {
  for (const t of ['{"kota":"Bandung","total":1', 'Berikut JSON:\n{"kota":"B","total":1}', '{"kota":"B","total":1}\nselesai']) {
    const r = periksaFormat(t, JSON_SPEK);
    assert.equal(r.ok, false, t);
    assert.equal(r.nilai, null);
  }
});

test("invalid specs are refused", () => {
  for (const bad of [null, {}, { jenis: "tanggal" }, { jenis: "json", skema: { type: "date" } }, { jenis: "angka", skema: {} }, { jenis: "json", skema: { type: "object", required: "a" } }, { jenis: "angka", ekstra: 1 }])
    assert.throws(() => validasiSpek(bad), /format/i, JSON.stringify(bad));
  assert.doesNotThrow(() => validasiSpek(JSON_SPEK));
  assert.doesNotThrow(() => validasiSpek(BULAT));
});
