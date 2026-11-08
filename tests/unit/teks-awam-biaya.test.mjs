import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

// UX spec 29 Oct 2026, section 2 (U5): one plain sentence about cost, details behind "Rincian".
const src = await readFile(new URL("../../ui/teks-awam.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(src, { window });
const T = window.miganTeksAwam;

test("spec examples, Indonesian", () => {
  assert.equal(T.usageText({ state: "known", usd: 0, running: true }, "id"), "Perkiraan biaya sejauh ini US$0.00.");
  assert.equal(T.usageText({ state: "known", usd: 0.0123, running: true }, "id"), "Perkiraan biaya sejauh ini US$0.0123.");
  assert.equal(T.usageText({ state: "price-unknown", usd: null }, "id"), "Harga AI ini belum tersedia; biaya belum diketahui.");
  assert.equal(T.usageText({ state: "usage-unavailable", usd: null }, "id"), "Pemakaian belum dilaporkan; biaya belum diketahui.");
});

test("English texts and the finished sentence", () => {
  assert.equal(T.usageText({ state: "known", usd: 1.25, running: true }, "en"), "Estimated cost so far: US$1.25.");
  assert.equal(T.usageText({ state: "known", usd: 1.25, running: false }, "en"), "Estimated task cost: US$1.25.");
  assert.equal(T.usageText({ state: "known", usd: 1.25, running: false }, "id"), "Perkiraan biaya tugas ini US$1.25.");
  assert.equal(T.usageText({ state: "price-unknown" }, "en"), "Model price unavailable; cost unknown.");
  assert.equal(T.usageText({ state: "usage-unavailable" }, "en"), "Usage not reported; cost unknown.");
  assert.equal(T.usageText({ state: "pending" }, "en"), "Cost not known yet.");
  assert.equal(T.usageText({ state: "pending" }, "id"), "Biaya belum diketahui.");
  assert.equal(T.usageText({ state: "local" }, "id"), "Tanpa biaya layanan AI.");
  assert.equal(T.usageText({ state: "local" }, "en"), "No AI service charge.");
});

test("no reason means unknown, never zero", () => {
  assert.equal(T.usageText({}, "id"), "Biaya belum diketahui.");
  assert.equal(T.usageText(undefined, "en"), "Cost not known yet.");
  for (const usd of [null, undefined, NaN, -1, "x", Infinity])
    assert.equal(T.usageText({ state: "known", usd, running: true }, "id"), "Biaya belum diketahui.", String(usd));
});

test("money: 2 to 4 decimals, tiny amounts, US$ with a dot", () => {
  assert.equal(T.money(0, "id"), "US$0.00");
  assert.equal(T.money(0.07, "id"), "US$0.07");
  assert.equal(T.money(1.23456, "id"), "US$1.2346");
  assert.equal(T.money(0.00004, "id"), "kurang dari US$0.0001");
  assert.equal(T.money(0.00004, "en"), "under US$0.0001");
  assert.equal(T.usageText({ state: "known", usd: 0.00004, running: false }, "en"), "Estimated task cost: under US$0.0001.");
});

test("Migan-only cost says team costs are excluded", () => {
  assert.equal(T.usageText({ state: "known", usd: 0.5, running: true, teamExcluded: true }, "id"), "Perkiraan biaya sejauh ini US$0.50; belum termasuk tim.");
  assert.equal(T.usageText({ state: "known", usd: 0.5, running: false, teamExcluded: true }, "en"), "Estimated task cost: US$0.50; team costs excluded.");
});

test("usageState maps a receipt to a reason without reading the sentence", () => {
  assert.equal(T.usageState({ cost: 0.01, inputTokens: 5, outputTokens: 2 }, "kimi"), "known");
  assert.equal(T.usageState({ cost: null, costNote: "x", inputTokens: 5, outputTokens: 2 }, "ollama"), "local");
  assert.equal(T.usageState({ cost: null, inputTokens: 0, outputTokens: 0 }, "kimi"), "usage-unavailable");
  assert.equal(T.usageState({ cost: null, inputTokens: 9, outputTokens: 3 }, "kimi"), "price-unknown");
  assert.equal(T.usageState(null, "kimi"), "pending");
});

test("wiring: renderUsage uses the sentence and a closed Rincian; footnote no longer mentions API", async () => {
  const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../../ui/app.js", import.meta.url), "utf8");
  const f = app.slice(app.indexOf("function renderUsage"), app.indexOf("async function browserLayout"));
  assert.match(f, /miganTeksAwam\.usageText/);
  assert.match(f, /createElement\("details"\)/);
  assert.match(f, /Rincian|Details/);
  assert.doesNotMatch(f, /details\.open\s*=\s*true/);
  assert.match(html, /Periksa hasil sebelum dipakai\./);
  assert.doesNotMatch(html, /API menggunakan kuota/);
  assert.match(app, /Review results before using\./);
  assert.doesNotMatch(app, /API calls use your provider quota/);
});
