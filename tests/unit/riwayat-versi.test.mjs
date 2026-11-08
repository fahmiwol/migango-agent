// 06xg part 1: user-facing version history parser and the alpha bump script.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { uraiRiwayat, cariVersi, versiBerikutnya, formatTanggalWIB, kerangkaBagian } from "../../src/core/riwayat-versi.mjs";
import { rencanaNaikVersi, naikVersi } from "../../scripts/naik-versi.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const SAMPEL = [
  "# Riwayat versi",
  "",
  "Pengantar.",
  "",
  "## 0.2.0-alpha.20 — 27 Oktober 2026",
  "",
  "### Yang baru",
  "- Banner.",
  "",
  "### Yang diperbaiki",
  "- Pemulihan.",
  "",
  "### Cara kembali ke versi sebelumnya",
  "- Commit b6322ee.",
  "",
  "## 0.2.0-alpha.19 — 27 Oktober 2026",
  "",
  "### Yang baru",
  "- Harga.",
  "",
].join("\n");

const pkgText = (v) => JSON.stringify({ name: "migan-workbench", version: v, private: true }, null, 2) + "\n";
const lockText = (v, rootV = v) =>
  JSON.stringify({ name: "migan-workbench", version: v, lockfileVersion: 3, packages: { "": { name: "migan-workbench", version: rootV } } }, null, 2) + "\n";
const NOW = new Date("2026-10-27T18:00:00Z"); // 28 Oct 01:00 WIB

test("uraiRiwayat: bagian per versi berurutan, tanggal dan subjudul", () => {
  const d = uraiRiwayat(SAMPEL);
  assert.deepEqual(d.map((b) => b.versi), ["0.2.0-alpha.20", "0.2.0-alpha.19"]);
  assert.equal(d[0].tanggal, "27 Oktober 2026");
  assert.deepEqual(d[0].subjudul, ["Yang baru", "Yang diperbaiki", "Cara kembali ke versi sebelumnya"]);
  assert.match(d[0].isi, /Commit b6322ee/);
  assert.doesNotMatch(d[0].isi, /Harga/);
  assert.equal(SAMPEL.slice(d[1].mulai, d[1].akhir), d[1].teks);
});

test("uraiRiwayat: heading di dalam blok kode diabaikan", () => {
  const t = "## 1.0.0-alpha.2 — 1 Januari 2027\n```\n## 1.0.0-alpha.1 — palsu\n```\nisi\n";
  const d = uraiRiwayat(t);
  assert.equal(d.length, 1);
  assert.match(d[0].isi, /palsu/);
});

test("uraiRiwayat: versi ganda dan heading versi rusak ditolak", () => {
  assert.throws(() => uraiRiwayat(SAMPEL + "## 0.2.0-alpha.19 — lagi\n"), { code: "RIWAYAT_VERSI_GANDA" });
  assert.throws(() => uraiRiwayat("## 0.2.0-alpha.07 — x\n"), { code: "RIWAYAT_HEADING_TIDAK_SAH" });
  assert.throws(() => uraiRiwayat(42), { code: "RIWAYAT_BUKAN_TEKS" });
});

test("cariVersi: versi saat ini ditemukan, versi asing null", () => {
  const d = uraiRiwayat(SAMPEL);
  assert.equal(cariVersi(d, "0.2.0-alpha.19").versi, "0.2.0-alpha.19");
  assert.equal(cariVersi(d, "0.2.0-alpha.99"), null);
});

test("docs/RIWAYAT-VERSI.md: versi package.json ada, tiga subjudul, rollback nyata, tanpa istilah internal", () => {
  const versi = JSON.parse(read("package.json")).version;
  const teks = read("docs/RIWAYAT-VERSI.md");
  const d = uraiRiwayat(teks);
  assert.equal(d[0].versi, versi, "bagian teratas = versi app saat ini");
  const b = cariVersi(d, "0.2.0-alpha.20");
  assert.ok(b, "alpha.20 harus ada");
  assert.equal(b.tanggal, "27 Oktober 2026");
  assert.deepEqual(b.subjudul, ["Yang baru", "Yang diperbaiki", "Cara kembali ke versi sebelumnya"]);
  assert.match(b.isi, /b6322ee/, "commit yang menetapkan alpha.19");
  assert.match(b.isi, /e8b5058/, "commit naik versi alpha.20");
  for (const t of [/ERR_[A-Z_]+/, /\bD-\d{3}\b/, /\bPMO\b/, /\bHOMESRV\b/, /\bIPC\b/, /[A-Za-z]:[\\/]/, /sk-[A-Za-z0-9]/, /\(isi sebelum rilis\)/]) {
    assert.doesNotMatch(b.isi, t);
  }
});

test("versiBerikutnya dan formatTanggalWIB", () => {
  assert.equal(versiBerikutnya("0.2.0-alpha.20"), "0.2.0-alpha.21");
  assert.equal(versiBerikutnya("0.2.0-alpha.9"), "0.2.0-alpha.10");
  for (const v of ["0.2.0", "0.2.0-alpha.09", "0.2.0-beta.1", "", null]) {
    assert.throws(() => versiBerikutnya(v), { code: "VERSI_BUKAN_ALPHA" });
  }
  assert.equal(formatTanggalWIB(NOW), "28 Oktober 2026");
  assert.equal(formatTanggalWIB(new Date("2027-01-05T03:00:00Z")), "5 Januari 2027");
});

test("kerangkaBagian: tiga subjudul dan versi sebelumnya", () => {
  const k = kerangkaBagian("0.2.0-alpha.21", "28 Oktober 2026", "0.2.0-alpha.20");
  assert.match(k, /^## 0\.2\.0-alpha\.21 — 28 Oktober 2026\n/);
  const d = uraiRiwayat(k);
  assert.deepEqual(d[0].subjudul, ["Yang baru", "Yang diperbaiki", "Cara kembali ke versi sebelumnya"]);
  assert.match(d[0].isi, /0\.2\.0-alpha\.20/);
});

test("rencanaNaikVersi: pkg + lock naik, bagian baru di atas, isi lama utuh", () => {
  const r = rencanaNaikVersi({ packageText: pkgText("0.2.0-alpha.20"), lockText: lockText("0.2.0-alpha.20"), riwayatText: SAMPEL, now: NOW });
  assert.equal(r.versiLama, "0.2.0-alpha.20");
  assert.equal(r.versiBaru, "0.2.0-alpha.21");
  assert.equal(JSON.parse(r.files["package.json"]).version, "0.2.0-alpha.21");
  const lock = JSON.parse(r.files["package-lock.json"]);
  assert.equal(lock.version, "0.2.0-alpha.21");
  assert.equal(lock.packages[""].version, "0.2.0-alpha.21");
  const baru = r.files["docs/RIWAYAT-VERSI.md"];
  assert.deepEqual(uraiRiwayat(baru).map((b) => b.versi), ["0.2.0-alpha.21", "0.2.0-alpha.20", "0.2.0-alpha.19"]);
  const pos = SAMPEL.indexOf("## 0.2.0-alpha.20");
  assert.equal(baru.slice(0, pos), SAMPEL.slice(0, pos), "pengantar utuh");
  assert.ok(baru.endsWith(SAMPEL.slice(pos)), "bagian lama utuh byte demi byte");
});

test("rencanaNaikVersi: penolakan sebelum menulis", () => {
  const base = { packageText: pkgText("0.2.0-alpha.20"), lockText: lockText("0.2.0-alpha.20"), riwayatText: SAMPEL, now: NOW };
  const sudah = kerangkaBagian("0.2.0-alpha.21", "28 Oktober 2026", "0.2.0-alpha.20") + "\n" + SAMPEL;
  assert.throws(() => rencanaNaikVersi({ ...base, riwayatText: sudah }), { code: "RIWAYAT_VERSI_SUDAH_ADA" });
  assert.throws(() => rencanaNaikVersi({ ...base, lockText: lockText("0.2.0-alpha.19") }), { code: "VERSI_TIDAK_SAMA" });
  assert.throws(() => rencanaNaikVersi({ ...base, lockText: lockText("0.2.0-alpha.20", "0.2.0-alpha.19") }), { code: "VERSI_TIDAK_SAMA" });
  assert.throws(() => rencanaNaikVersi({ ...base, lockText: lockText("0.2.0-alpha.19", "0.2.0-alpha.20") }), { code: "VERSI_TIDAK_SAMA" });
  assert.throws(() => rencanaNaikVersi({ ...base, riwayatText: SAMPEL.replace("## 0.2.0-alpha.20 — 27 Oktober 2026", "## 0.2.0-alpha.18 — x") }), { code: "RIWAYAT_VERSI_SAAT_INI_HILANG" });
  assert.throws(() => rencanaNaikVersi({ ...base, packageText: pkgText("0.2.0"), lockText: lockText("0.2.0") }), { code: "VERSI_BUKAN_ALPHA" });
  assert.throws(() => rencanaNaikVersi({ ...base, packageText: "{" }), { code: "JSON_TIDAK_SAH" });
});

function siapkanFolder(riwayat = SAMPEL) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "naik-versi-"));
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "package.json"), pkgText("0.2.0-alpha.20"));
  fs.writeFileSync(path.join(dir, "package-lock.json"), lockText("0.2.0-alpha.20"));
  fs.writeFileSync(path.join(dir, "docs", "RIWAYAT-VERSI.md"), riwayat);
  return dir;
}
const snapshot = (dir) => ["package.json", "package-lock.json", "docs/RIWAYAT-VERSI.md"].map((n) => fs.readFileSync(path.join(dir, n), "utf8"));
const sisaTemp = (dir) => [...fs.readdirSync(dir), ...fs.readdirSync(path.join(dir, "docs"))].filter((n) => n.endsWith(".tmp"));

test("naikVersi: dry-run tidak menulis; apply menulis tiga berkas tanpa sisa temp", async () => {
  const dir = siapkanFolder();
  try {
    const before = snapshot(dir);
    const dry = await naikVersi({ root: dir, now: NOW });
    assert.equal(dry.versiBaru, "0.2.0-alpha.21");
    assert.deepEqual(snapshot(dir), before);
    await naikVersi({ root: dir, now: NOW, apply: true });
    const [p, l, r] = snapshot(dir);
    assert.equal(JSON.parse(p).version, "0.2.0-alpha.21");
    assert.equal(JSON.parse(l).packages[""].version, "0.2.0-alpha.21");
    assert.equal(uraiRiwayat(r)[0].versi, "0.2.0-alpha.21");
    assert.deepEqual(sisaTemp(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("naikVersi: rename gagal -> galat diteruskan, temp dibersihkan, ulangan berhenti aman", async () => {
  const dir = siapkanFolder();
  try {
    const gagalRename = {
      readFile: fs.promises.readFile,
      writeFile: fs.promises.writeFile,
      rm: fs.promises.rm,
      rename: (from, to) => (path.basename(to) === "package.json" ? Promise.reject(Object.assign(new Error("disk penuh"), { code: "EIO" })) : fs.promises.rename(from, to)),
    };
    await assert.rejects(naikVersi({ root: dir, now: NOW, apply: true, fsImpl: gagalRename }), { code: "EIO" });
    assert.deepEqual(sisaTemp(dir), []);
    const [p, , r] = snapshot(dir);
    assert.equal(JSON.parse(p).version, "0.2.0-alpha.20");
    assert.equal(uraiRiwayat(r)[0].versi, "0.2.0-alpha.21", "riwayat ditulis lebih dulu");
    await assert.rejects(naikVersi({ root: dir, now: NOW, apply: true }), { code: "RIWAYAT_VERSI_SUDAH_ADA" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("naikVersi: gagal tanpa mengubah byte bila bagian versi baru sudah ada (idempoten-gagal)", async () => {
  const dir = siapkanFolder();
  try {
    await naikVersi({ root: dir, now: NOW, apply: true });
    // Simulate a half-reverted bump: package files back to alpha.20, history already has alpha.21.
    fs.writeFileSync(path.join(dir, "package.json"), pkgText("0.2.0-alpha.20"));
    fs.writeFileSync(path.join(dir, "package-lock.json"), lockText("0.2.0-alpha.20"));
    const before = snapshot(dir);
    await assert.rejects(naikVersi({ root: dir, now: NOW, apply: true }), { code: "RIWAYAT_VERSI_SUDAH_ADA" });
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(sisaTemp(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
