import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// 27 Oct 2026: the owner pressed the HOLD banner button and "nothing happened": with Pemulihan
// already open, switchTab changed nothing, and the HOLD card was a closed <details> in the narrow
// right panel, so the note field and "Konfirmasi efek sudah diperiksa" stayed out of sight.
const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
const body = (name) => {
  const at = app.indexOf("async function " + name + "(");
  assert.ok(at >= 0, name);
  return app.slice(at, app.indexOf("\n}\n", at));
};

test("refreshRecovery opens the HOLD card for a single HOLD or the one the banner named", () => {
  const f = body("refreshRecovery");
  assert.match(f, /async function refreshRecovery\(focusId\)/);
  assert.match(f, /card\.open = jobs\.length === 1 \|\| job\.id === focusId/);
});

test("Konfirmasi and Hentikan are disabled with a reason while a run is active", () => {
  const f = body("refreshRecovery");
  assert.match(f, /if \(busy\)/);
  assert.match(f, /\.disabled = true/);
  assert.match(f, /Hentikan pekerjaan yang sedang berjalan dulu/);
});

test("the banner button opens Pemulihan, opens the named card, scrolls to it and focuses the note", () => {
  const at = app.indexOf('$("holdBannerAction").onclick');
  const handler = app.slice(at, app.indexOf("\n  });\n", at));
  assert.match(handler, /await switchTab\("recovery"\)/);
  assert.match(handler, /await refreshRecovery\(button\.dataset\.id\)/);
  assert.match(handler, /scrollIntoView/);
  assert.match(handler, /\.focus\(\)/);
});
