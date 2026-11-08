import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../../ui/apa-yang-baru.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(source, { window });
const { buatModel } = window.miganApaYangBaru;

const data = {
  versiApp: "0.2.0-alpha.25",
  bagian: [
    {
      versi: "0.2.0-alpha.27",
      tanggal: "29 Oktober 2026",
      saatIni: false,
      isi: [
        "### Yang baru",
        "- Penjelasan mode lebih mudah dipahami.",
        "",
        "### Yang diperbaiki",
        "- Tombol tidak lagi terpotong.",
        "- Biaya dijelaskan dengan bahasa awam.",
        "",
        "### Cara kembali ke versi sebelumnya",
        "- Perintah teknis ini bukan isi dialog.",
      ].join("\n"),
    },
    {
      versi: "0.2.0-alpha.26",
      tanggal: "28 Oktober 2026",
      saatIni: false,
      isi: "### Yang baru\n- Ini versi lama dan tidak boleh tampil.",
    },
  ],
};

test("membentuk judul dan dua daftar hanya dari versi teratas", () => {
  const model = buatModel(data);
  assert.equal(model.judul, "0.2.0-alpha.27 — 29 Oktober 2026");
  assert.deepEqual(Array.from(model.bagian, (b) => b.judul), ["Yang baru", "Yang diperbaiki"]);
  assert.deepEqual([...model.bagian[0].butir], ["Penjelasan mode lebih mudah dipahami."]);
  assert.deepEqual([...model.bagian[1].butir], [
    "Tombol tidak lagi terpotong.",
    "Biaya dijelaskan dengan bahasa awam.",
  ]);
  assert.equal(JSON.stringify(model).includes("Perintah teknis"), false);
  assert.equal(JSON.stringify(model).includes("versi lama"), false);
});

test("bagian kosong tetap terstruktur dan butir lama tanpa subjudul tetap terbaca", () => {
  const kosong = buatModel({ bagian: [{ versi: "1.0.0-alpha.1", tanggal: "", isi: "" }] });
  assert.equal(kosong.judul, "1.0.0-alpha.1");
  assert.deepEqual(Array.from(kosong.bagian, (b) => Array.from(b.butir)), [[], []]);

  // Fixture foto lama hanya mempunyai daftar butir; perlakukan sebagai Yang baru, bukan menghilangkannya.
  const lama = buatModel({ bagian: [{ versi: "1.0.0-alpha.2", isi: "- Kartu HOLD berbahasa awam\r\n- Jejak kerja terlihat" }] });
  assert.deepEqual([...lama.bagian[0].butir], ["Kartu HOLD berbahasa awam", "Jejak kerja terlihat"]);
  assert.deepEqual([...lama.bagian[1].butir], []);
});

test("payload rusak menghasilkan galat, bukan versi karangan", () => {
  for (const value of [null, {}, { bagian: [] }, { bagian: [null] }, { bagian: [{ tanggal: "hari ini", isi: "" }] }])
    assert.throws(() => buatModel(value), /riwayat versi tidak valid/i);
});

test("riwayat nyata membentuk isi versi teratas tanpa bocoran versi berikutnya", async () => {
  const [{ muatApaYangBaru }, { fileURLToPath }, path, pkg] = await Promise.all([
    import("../../src/desktop/whats-new-ipc.mjs"),
    import("node:url"),
    import("node:path"),
    readFile(new URL("../../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const model = buatModel(await muatApaYangBaru({ appRoot: root, version: pkg.version }));
  assert.equal(model.judul, pkg.version + " — 29 Oktober 2026");
  assert.ok(model.bagian.every((b) => b.butir.length > 0));
  assert.equal(JSON.stringify(model).includes("Kembali ke 0.2.0-alpha.26"), false);
});

test("wiring memakai IPC baca-saja, dialog berlabel, dan simpul teks", async () => {
  const [html, app] = await Promise.all([
    readFile(new URL("../../ui/index.html", import.meta.url), "utf8"),
    readFile(new URL("../../ui/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="whatsNewBtn"[^>]*>\s*Apa yang baru\s*<\/button>/);
  assert.match(html, /<dialog id="whatsNewDialog" aria-labelledby="whatsNewTitle">/);
  assert.match(html, /<script src="apa-yang-baru\.js"><\/script>/);
  assert.match(app, /api\.whatsNew\(\)/);
  assert.match(app, /\$\("whatsNewDialog"\)\.showModal\(\)/);
  const render = app.slice(app.indexOf("function renderWhatsNew"), app.indexOf("async function openWhatsNew"));
  assert.match(render, /textContent/);
  assert.doesNotMatch(render, /innerHTML/);
});
