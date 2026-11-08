import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// UX spec 29 Oct 2026, section 5: a one-line hint for the selected mode only.
const src = await readFile(new URL("../../ui/teks-awam.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(src, { window });
const T = window.miganTeksAwam;

test("hint per mode, Indonesian", () => {
  assert.equal(T.modeHint("ask", "", "id"), "AI membaca dan menjawab, tanpa mengubah berkas.");
  assert.equal(T.modeHint("work", "", "id"), "AI mengusulkan perubahan; kamu memberi izin sebelum diterapkan.");
  assert.equal(T.modeHint("build", "new", "id"), "AI membuat aplikasi di folder baru pilihanmu.");
  assert.equal(T.modeHint("build", "current", "id"), "AI membuat aplikasi di folder ini sesuai izinmu.");
});

test("hint per mode, English", () => {
  assert.equal(T.modeHint("ask", "", "en"), "AI reads and answers without changing files.");
  assert.equal(T.modeHint("work", "", "en"), "AI proposes changes; you approve before they are applied.");
  assert.equal(T.modeHint("build", "new", "en"), "AI builds an app in a new folder you choose.");
  assert.equal(T.modeHint("build", "current", "en"), "AI builds an app here with your permission.");
});

test("unknown mode gives no text; busy note in both languages", () => {
  assert.equal(T.modeHint("zzz", "", "id"), "");
  assert.equal(T.modeBusyHint("id"), "Sedang bekerja. Mode bisa diganti setelah tugas berhenti.");
  assert.equal(T.modeBusyHint("en"), "Working. Change mode after the task stops.");
});

test("wiring: hint element, aria, and refresh on mode/language/busy", async () => {
  const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(html, /id="modeHint"/);
  assert.match(html, /role="group"\s+aria-label="Mode pekerjaan"\s+aria-describedby="modeHint"/);
  assert.match(app, /miganTeksAwam\.modeHint/);
  assert.match(app, /aria-pressed/);
  const lang = app.slice(app.indexOf('$("langBtn").onclick'), app.indexOf('document.addEventListener("keydown"'));
  assert.match(lang, /renderModeHint\(\)/);
});

test("the bottom note says review, not API", async () => {
  const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /class="footnote" data-i18n="footnote">\s*Periksa hasil sebelum dipakai\.\s*<\/div>/);
});
