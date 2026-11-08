import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pilihCek,
  jalankanCek,
  ambilTesGagal,
  BATAS_BERKAS,
  BATAS_KELUARAN,
} from "../../src/agents/verifier.mjs";

// Real dot-reporter output shape (node --test --test-reporter=dot), trimmed.
const DOT_GAGAL = [
  ".XX.X",
  "",
  "Failed tests:",
  "",
  "✖ gagal atas (1.2321ms)",
  "  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
  "  ✖ bukan nama tes (1ms)",
  "✖ gagal dalam (14.9653ms)",
  "  AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:",
  "✖ grup (15.3991ms)",
  "  '1 subtest failed'",
  "",
].join("\n");

const files = {
  "tests/unit/a.test.mjs": 'import { x } from "../../src/agents/runtime.mjs";',
  "tests/unit/b.test.mjs": 'import { y } from "../../src/core/other.mjs";',
  "tests/unit/c.test.mjs": "import { z } from '../../src/agents/runtime.mjs';",
  "tests/unit/d.test.mjs": "// mentions runtime-helper.mjs only",
  "tests/fixtures/helper.mjs": 'import "../../src/agents/runtime.mjs";',
};
const daftar = [...Object.keys(files), "src/agents/runtime.mjs", "src/core/other.mjs", "README.md"];
const baca = async (p) => files[p] ?? "";

test("pilihCek: tanpa berkas berubah memberi daftar kosong dan alasan", async () => {
  const r = await pilihCek({ berubah: [], daftarBerkas: daftar, bacaBerkas: baca });
  assert.deepEqual(r.berkas, []);
  assert.equal(r.alasan, "tidak ada berkas berubah");
});

test("pilihCek: tes yang berubah dan tes yang mengimpor src yang berubah", async () => {
  const r = await pilihCek({
    berubah: ["src\\agents\\runtime.mjs", "tests/unit/b.test.mjs", "README.md"],
    daftarBerkas: daftar,
    bacaBerkas: baca,
  });
  assert.deepEqual(r.berkas, ["tests/unit/b.test.mjs", "tests/unit/a.test.mjs", "tests/unit/c.test.mjs"]);
});

test("pilihCek: tes yang dihapus dan berkas non-tes tidak dipilih", async () => {
  const r = await pilihCek({
    berubah: ["tests/unit/hilang.test.mjs", "README.md"],
    daftarBerkas: daftar,
    bacaBerkas: baca,
  });
  assert.deepEqual(r.berkas, []);
  assert.match(r.alasan, /tidak ada tes terkait/);
});

test("pilihCek: dibatasi 12 berkas dengan urutan stabil", async () => {
  const many = Array.from({ length: 20 }, (_, i) => `tests/unit/t${String(i).padStart(2, "0")}.test.mjs`);
  const reversed = [...many].reverse();
  const r1 = await pilihCek({ berubah: reversed, daftarBerkas: many, bacaBerkas: baca });
  const r2 = await pilihCek({ berubah: many, daftarBerkas: reversed, bacaBerkas: baca });
  assert.equal(BATAS_BERKAS, 12);
  assert.equal(r1.berkas.length, 12);
  assert.deepEqual(r1.berkas, many.slice(0, 12));
  assert.deepEqual(r2.berkas, r1.berkas);
  assert.match(r1.alasan, /8/);
});

test("pilihCek: bacaBerkas yang gagal dilewati", async () => {
  const r = await pilihCek({
    berubah: ["src/agents/runtime.mjs"],
    daftarBerkas: daftar,
    bacaBerkas: async (p) => {
      if (p.endsWith("a.test.mjs")) throw new Error("EACCES");
      return files[p] ?? "";
    },
  });
  assert.deepEqual(r.berkas, ["tests/unit/c.test.mjs"]);
});

test("ambilTesGagal: nama dari ringkasan dot, tanpa suite induk", () => {
  assert.deepEqual(ambilTesGagal(DOT_GAGAL), ["gagal atas", "gagal dalam"]);
  assert.deepEqual(ambilTesGagal("....\n"), []);
});

test("jalankanCek: memanggil node --test dengan reporter dot dan lulus", async () => {
  const calls = [];
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async (cmd, args, opts) => {
      calls.push([cmd, args, opts]);
      return { code: 0, output: "..\n" };
    },
    batasMs: 5000,
  });
  assert.deepEqual(calls[0][0], "node");
  assert.deepEqual(calls[0][1], ["--test", "--test-reporter=dot", "tests/unit/a.test.mjs"]);
  assert.equal(calls[0][2].timeout, 5000);
  assert.equal(r.status, "passed");
  assert.equal(r.accepted, true);
  assert.deepEqual(r.cek, ["tests/unit/a.test.mjs"]);
  assert.equal(typeof r.durasiMs, "number");
});

test("jalankanCek: tes gagal membuat failed dan accepted false", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: 1, output: DOT_GAGAL }),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.accepted, false);
  assert.deepEqual(r.gagalBaru, ["gagal atas", "gagal dalam"]);
});

test("jalankanCek: kode keluar bukan nol tanpa nama tes tetap failed", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: 1, output: "SyntaxError\n" }),
  });
  assert.equal(r.status, "failed");
  assert.equal(r.accepted, false);
});

test("jalankanCek: kegagalan yang ada di garis dasar tidak membuat failed", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: 1, output: DOT_GAGAL }),
    garisDasar: ["gagal atas", "gagal dalam"],
  });
  assert.equal(r.status, "passed");
  assert.equal(r.accepted, true);
  assert.deepEqual(r.gagalBaru, []);
  assert.deepEqual(r.gagalLama, ["gagal atas", "gagal dalam"]);
});

test("jalankanCek: kegagalan baru di luar garis dasar membuat failed", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: 1, output: DOT_GAGAL }),
    garisDasar: ["gagal atas"],
  });
  assert.equal(r.status, "failed");
  assert.equal(r.accepted, false);
  assert.deepEqual(r.gagalBaru, ["gagal dalam"]);
});

test("jalankanCek: tanpa berkas tidak menjalankan apa pun", async () => {
  let called = false;
  const r = await jalankanCek({ berkas: [], jalankan: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(r.status, "not-applicable");
  assert.equal(r.accepted, false);
});

test("jalankanCek: jalankan melempar memberi error dan accepted false", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => { throw new Error("Command timed out"); },
  });
  assert.equal(r.status, "error");
  assert.equal(r.accepted, false);
  assert.match(r.keluaranRingkas, /timed out/);
});

test("jalankanCek: jalankan yang menggantung kena batas waktu", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: () => new Promise(() => {}),
    batasMs: 30,
  });
  assert.equal(r.status, "error");
  assert.equal(r.accepted, false);
});

test("jalankanCek: proses dihentikan sinyal memberi error", async () => {
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: null, termination: "SIGTERM", output: "..." }),
  });
  assert.equal(r.status, "error");
  assert.equal(r.accepted, false);
});

test("jalankanCek: keluaran dipotong ke ekor 4000 karakter", async () => {
  const output = "AWAL" + "x".repeat(10000) + "AKHIR";
  const r = await jalankanCek({
    berkas: ["tests/unit/a.test.mjs"],
    jalankan: async () => ({ code: 0, output }),
  });
  assert.equal(BATAS_KELUARAN, 4000);
  assert.equal(r.keluaranRingkas.length, 4000);
  assert.ok(r.keluaranRingkas.endsWith("AKHIR"));
  assert.ok(!r.keluaranRingkas.includes("AWAL"));
});
