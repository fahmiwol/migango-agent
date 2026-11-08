// 06u4: the photo fixture must have the same shape as the real IPC answers, otherwise the photo
// shows stub artefacts (06u3: missing profiles; 06u4: periksa.tugas as a string).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { FIXTURE, STATES } from "../../scripts/foto-fitur.mjs";

function kartuHold() {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(new URL("../../ui/kartu-hold.js", import.meta.url), "utf8"), sandbox);
  return sandbox.window.miganKartuHold.describe;
}

test("fixture HOLD memakai bentuk periksaHold nyata dan judul tugas tampil", () => {
  const describe = kartuHold();
  const judul = FIXTURE.recovery.map((j) => describe(j.periksa).judul);
  assert.deepEqual(judul, ["Tulis ringkasan rapat", "Bangun situs contoh"]);
  const tujuan = FIXTURE.recovery.map((j) => describe(j.periksa).tujuan);
  assert.ok(tujuan.every((t) => t !== "Tujuan tidak tercatat."));
  for (const j of FIXTURE.recovery) {
    assert.equal(typeof j.periksa.tugas, "object");
    assert.ok(Array.isArray(j.periksa.berkasBerubah));
    assert.ok(Number.isInteger(j.periksa.prosesSisa));
    assert.equal(typeof j.periksa.perintahTerputus, "object");
  }
  // Safe card really is safe; the other really asks for a check (no fake verdicts).
  assert.equal(describe(FIXTURE.recovery[0].periksa).aman, true);
  assert.equal(describe(FIXTURE.recovery[1].periksa).aman, false);
});

test("keadaan kartu HOLD menggulir daftar ke viewport seperti pemilik menggulir", () => {
  const b = STATES.find((s) => s.name === "b-kartu-hold");
  assert.ok(b.nav.includes("open:recoveryList"));
});

test("fixture whatsNew sebentuk balasan whats-new-ipc nyata", () => {
  const w = FIXTURE.whatsNew;
  assert.equal(typeof w.versiApp, "string");
  assert.ok(Array.isArray(w.bagian) && w.bagian.length >= 2);
  assert.equal(w.bagian.filter((b) => b.saatIni).length, 1);
  assert.equal(w.bagian.find((b) => b.saatIni).versi, w.versiApp);
});
