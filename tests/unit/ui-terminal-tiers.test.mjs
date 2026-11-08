import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

// Penjelasan tingkat terminal A/B/C/X di panel "Komputer & terminal" (baca saja).
async function load() {
  const window = {};
  const source = await fs.readFile(new URL("../../ui/terminal-tiers.js", import.meta.url), "utf8");
  vm.runInNewContext(source, { window });
  const t = window.miganTerminalTiers;
  // Copy vm-realm values into this realm before deep comparisons.
  return { ...t, tiers: JSON.parse(JSON.stringify(t.tiers)) };
}
const html = () => fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");

test("empat tingkat A/B/C/X dengan penjelasan dan aturan izin", async () => {
  const t = await load();
  assert.deepEqual(t.tiers.map((x) => x.id), ["A", "B", "C", "X"]);
  for (const tier of t.tiers) {
    assert.ok(tier.title.length > 3, tier.id);
    assert.ok(tier.meaning.length > 10, tier.id);
    assert.ok(tier.permission.length > 5, tier.id);
  }
  assert.match(t.tiers[3].permission, /ditolak/i);
  assert.match(t.tiers[1].permission, /izin/i);
  assert.match(t.tiers[2].permission, /izin/i);
});

test("status auto-A: MATI kecuali pengaturan persis true, dan hanya baca", async () => {
  const t = await load();
  for (const value of [undefined, null, false, 0, "true", "on", 1, {}, []]) {
    const s = t.autoStatus({ shellAutoTierA: value });
    assert.equal(s.on, false, String(value));
    assert.match(s.label, /MATI/);
  }
  assert.equal(t.autoStatus(undefined).on, false);
  assert.equal(t.autoStatus(null).on, false);
  const on = t.autoStatus({ shellAutoTierA: true });
  assert.equal(on.on, true);
  assert.match(on.label, /NYALA/);
  assert.match(t.autoStatus({}).note, /pemilik/i);
});

test("index.html: panel tingkat ada di Komputer & terminal, tanpa tombol ubah auto-A", async () => {
  const text = await html();
  assert.match(text, /id="terminalTiers"/);
  assert.match(text, /id="terminalAutoA"/);
  assert.match(text, /<script src="terminal-tiers.js"><\/script>[\s\S]*<script src="app.js">/);
  const pane = text.slice(text.indexOf('id="computerPane"'), text.indexOf('id="recoveryPane"'));
  assert.ok(pane.includes('id="terminalTiers"') && pane.includes('id="terminalAutoA"'));
  assert.ok(pane.indexOf('id="terminalTiers"') < pane.indexOf('id="terminalForm"'));
  assert.doesNotMatch(text, /id="shellAutoTierA"/);
  assert.doesNotMatch(text, /type="checkbox"[^>]*terminalAutoA/);
});

test("app.js memanggil penggambar tingkat dengan keadaan galat", async () => {
  const app = await fs.readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  assert.match(app, /miganTerminalTiers/);
  assert.match(app, /terminalAutoA/);
});
