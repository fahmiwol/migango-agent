import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Owner screenshot, 27 Oct 2026: during a run the mode choice (Tanya / Kerjakan / Bangun aplikasi)
// faded to almost unreadable (generic button:disabled opacity 0.45 on small text, dark panel) and
// gave no reason. Markas: when disabled on purpose it must stay readable and say why.
const css = await readFile(new URL("../../ui/galaxy.css", import.meta.url), "utf8");
const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
const galaxy = await readFile(new URL("../../ui/galaxy.js", import.meta.url), "utf8");

// WCAG relative luminance contrast.
const lum = (hex) => {
  const c = hex.match(/[0-9a-f]{2}/gi).map((h) => parseInt(h, 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("a disabled mode button stays fully opaque with readable text", () => {
  const rule = css.match(/\.modes button:disabled\s*\{([^}]*)\}/);
  assert.ok(rule, ".modes button:disabled rule exists");
  assert.match(rule[1], /opacity:\s*1\b/);
  const color = rule[1].match(/color:\s*(#[0-9a-f]{6})/i);
  assert.ok(color, "explicit text colour");
  assert.ok(contrast(color[1], "#0b1829") >= 4.5, "contrast >= 4.5:1 on the .modes background");
});

test("the reason is visible next to the modes while a run is active", () => {
  assert.match(html, /id="modeBusyNote"[^>]*hidden[^>]*>\s*Sedang menjalankan pekerjaan/);
  const f = galaxy.slice(galaxy.indexOf("setBusy(busy) {"), galaxy.indexOf("reset() {"));
  assert.match(f, /modeBusyNote/);
  assert.match(f, /\.hidden = !busy/);
});

test("each disabled mode button carries the reason as its title", () => {
  const f = galaxy.slice(galaxy.indexOf("setBusy(busy) {"), galaxy.indexOf("reset() {"));
  assert.match(f, /if \(busy\) button\.title = reason;/);
  assert.match(f, /Sedang menjalankan pekerjaan/);
});
