import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// 27 Oct 2026, live ab59e97: HOLD 3cd848bb was still in the journal but the Beranda banner was
// gone, and the banner is the owner's only way to release it. The banner was computed only at
// startup, after a workspace change and after its own button, and an IPC error hid it silently.
// Markas: recompute it after startup, every time Beranda opens and when the window gets focus; an
// unreadable HOLD status shows "Status HOLD tidak terbaca" with "Muat ulang" instead of hiding.
const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
const bannerSrc = await readFile(new URL("../../ui/recovery-banner.js", import.meta.url), "utf8");
const body = (name) => {
  const at = app.indexOf("async function " + name + "(");
  assert.ok(at >= 0, name);
  return app.slice(at, app.indexOf("\n}\n", at));
};
function banner() {
  const window = {};
  vm.runInNewContext(bannerSrc, { window });
  return window.miganHoldBanner;
}

test("an unreadable HOLD status has its own visible view with a reload button", () => {
  const view = JSON.parse(JSON.stringify(banner().describeError()));
  assert.match(view.text, /Status HOLD tidak terbaca/);
  assert.equal(view.button, "Muat ulang");
  assert.equal(view.reload, true);
  assert.equal(view.needsSwitch, false);
});

test("refreshHoldBanner shows the error view instead of hiding the banner on an IPC error", () => {
  const f = body("refreshHoldBanner");
  const i = f.indexOf("catch");
  assert.ok(i >= 0, "IPC errors are caught");
  const catchBlock = f.slice(i, f.indexOf("}", i));
  assert.doesNotMatch(catchBlock, /hidden = true/, "an error must not hide the banner silently");
  assert.match(catchBlock, /describeError\(\)/);
  assert.match(app, /dataset\.reload = view\.reload \? "1" : ""/);
});

test("the reload button only reloads the banner, it never switches folders", () => {
  const at = app.indexOf('$("holdBannerAction").onclick');
  const handler = app.slice(at, app.indexOf("\n  });\n", at));
  const reload = handler.indexOf("button.dataset.reload");
  assert.ok(reload >= 0, "reload branch exists");
  assert.ok(reload < handler.indexOf("recoveryHoldSwitch"), "reload is checked before any folder switch");
  assert.match(handler.slice(reload, handler.indexOf("recoveryHoldSwitch")), /await refreshHoldBanner\(\);\s*return;/);
});

test("opening Beranda recomputes the banner", () => {
  const f = body("switchTab");
  assert.match(f, /next === "home"[\s\S]{0,80}refreshHoldBanner\(\)/);
});

test("window focus recomputes the banner", () => {
  assert.match(app, /window\.addEventListener\("focus",[^\n]*refreshHoldBanner\(\)/);
});

test("startup checks the banner again after the first render, not only once", () => {
  const at = app.indexOf("safe(async () => {\n  settings = await api.settings();");
  assert.ok(at >= 0, "startup block");
  const block = app.slice(at, app.indexOf("\n})", at));
  assert.match(block, /setTimeout\(\(\) => void refreshHoldBanner\(\), \d+\)/);
});
