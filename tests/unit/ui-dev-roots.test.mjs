import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { validateDevRoots } from "../../src/core/folder-kerja.mjs";

// Pengaturan akar dev (pindah-workspace). Validasi UI harus sejalan dengan validateDevRoots.
async function load() {
  const window = {};
  const source = await fs.readFile(new URL("../../ui/dev-roots.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window });
  const d = window.miganDevRoots;
  // Objects from the vm realm have other prototypes; copy results into this realm before comparing.
  const copy = (v) => JSON.parse(JSON.stringify(v));
  return { ...d, parse: (t) => copy(d.parse(t)) };
}
const html = () => fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
const R = path.resolve(os.tmpdir());
const a = (n) => path.join(R, n);

test("parse: satu path per baris, kosong = daftar kosong", async () => {
  const d = await load();
  assert.deepEqual(d.parse(""), { roots: [], error: null });
  assert.deepEqual(d.parse("  \n \r\n"), { roots: [], error: null });
  assert.deepEqual(d.parse(a("x") + "\r\n\r\n" + a("y") + "\n").roots, [a("x"), a(path.join("y"))]);
  assert.equal(d.parse(undefined).error, null);
});

test("parse menolak yang sama dengan validateDevRoots", async () => {
  const d = await load();
  const bad = [
    "relatif/a",
    "a",
    "./a",
    a("x") + "\n" + a("x"),
    Array.from({ length: 6 }, (_, i) => a("r" + i)).join("\n"),
    a("a\u0000b"),
    a("a\u0007b"),
    "C:" + "x".repeat(600),
    "/" + "x".repeat(600),
  ];
  for (const text of bad) {
    const mine = d.parse(text);
    assert.ok(mine.error, "UI harus menolak: " + JSON.stringify(text.slice(0, 40)));
    assert.equal(mine.roots.length, 0);
    const lines = text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    assert.throws(() => validateDevRoots(lines), undefined, "server juga menolak: " + JSON.stringify(text.slice(0, 40)));
  }
});

test("parse: lima path boleh, duplikat tanpa beda huruf besar di Windows ditolak", async () => {
  const d = await load();
  const five = Array.from({ length: 5 }, (_, i) => a("r" + i));
  assert.equal(d.parse(five.join("\n")).error, null);
  assert.deepEqual(validateDevRoots(d.parse(five.join("\n")).roots), five);
  assert.ok(d.parse("C:\\Dev\\a\nc:\\dev\\A\n").error);
  assert.ok(d.parse("C:\\Dev\\a\nC:/Dev/a\n").error);
  assert.equal(d.parse("C:\\Dev\\a\nC:\\Dev\\b\n").error, null);
  assert.equal(d.parse("\\\\server\\share\\dev\n").error, null);
});

test("pesan galat memakai bahasa lazim dan menyebut nomor baris", async () => {
  const d = await load();
  assert.match(d.parse("relatif").error, /baris 1/i);
  assert.match(d.parse(a("x") + "\nrelatif").error, /baris 2/i);
  assert.match(d.parse(Array.from({ length: 6 }, (_, i) => a("r" + i)).join("\n")).error, /5/);
});

test("format menampilkan daftar tersimpan, dan keadaan kosong", async () => {
  const d = await load();
  assert.equal(d.format(undefined), "");
  assert.equal(d.format([a("x"), a("y")]), a("x") + "\n" + a("y"));
  assert.equal(d.summary([]).includes("belum"), true);
  assert.match(d.summary([a("x")]), /1 /);
  assert.match(d.summary("rusak"), /belum|tidak/i);
});

test("index.html dan app.js: kolom akar dev di Pengaturan, disimpan lewat saveSettings", async () => {
  const text = await html();
  assert.match(text, /id="devRoots"/);
  assert.match(text, /id="devRootsStatus"/);
  assert.match(text, /id="devRootsError"/);
  assert.match(text, /<script src="dev-roots.js"><\/script>[\s\S]*<script src="app.js">/);
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /miganDevRoots\.parse/);
  assert.match(app, /devRoots:/);
});
