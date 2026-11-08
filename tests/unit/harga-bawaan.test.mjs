import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fixture, reply } from "./team-fixture.mjs";

// Markas, 26 Oct 2026 (P1-2 amended): the app ships the approved, sourced prices for its two paid
// models (ledger MiganExp 1148). The owner's table always overrides a built-in row; a paid model
// in neither table is still refused (no guessed prices); built-in prices older than 90 days are
// flagged. A refused run tells the owner where to fix it (Pengaturan › Harga model), and Settings
// shows the built-in rows with their source and lets the owner set their own, with validation.
const meterModule = await import("../../src/core/cost-meter.mjs").catch(() => ({}));
const { CostMeter, BUILTIN_PRICES, builtinPriceInfo } = meterModule;

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "migango-harga-"));
const rm = (p) => fs.rm(p, { recursive: true, force: true });
const NOW = Date.parse("2026-10-26T03:00:00Z");
const DAY = 86400000;
const req = (model, over = {}) => ({ profile: { provider: "kimi", model }, system: "s", messages: [{ role: "user", content: "halo" }], tools: [], maxOutput: 1000, ...over });
const usage = (input, output) => async () => ({ text: "ok", usage: { input, output, cached: 0, available: true } });
const ledgerOf = async (root) => JSON.parse(await fs.readFile(path.join(root, "costs", "2026-10-26.json"), "utf8"));

// The UI script runs in its own realm; results are compared as plain JSON.
const plain = (x) => JSON.parse(JSON.stringify(x));
async function priceTable() {
  const window = {};
  vm.runInNewContext(await fs.readFile(new URL("../../ui/price-table.js", import.meta.url), "utf8"), { window });
  const t = window.miganPriceTable;
  return { rowsFor: (...a) => plain(t.rowsFor(...a)), collect: (...a) => plain(t.collect(...a)), errorAction: (...a) => plain(t.errorAction(...a)) };
}

test("the built-in table holds the two approved models, each with an official source and a date", () => {
  assert.deepEqual(Object.keys(BUILTIN_PRICES).sort(), ["anthropic/claude-opus-5-5", "kimi/kimi-k2.6"]);
  const { input, output, cached, cacheCreated } = BUILTIN_PRICES["anthropic/claude-opus-5-5"];
  assert.deepEqual({ input, output, cached, cacheCreated }, { input: 4, output: 20, cached: 0.2, cacheCreated: 5 });
  const k = BUILTIN_PRICES["kimi/kimi-k2.6"];
  assert.deepEqual({ input: k.input, output: k.output, cached: k.cached }, { input: 0.95, output: 4, cached: 0.16 });
  for (const [key, row] of Object.entries(BUILTIN_PRICES)) {
    assert.match(row.sumber, /^https:\/\/platform\.(claude\.com|kimi\.ai)\/docs\//, key);
    assert.match(row.tanggal, /^\d{4}-\d{2}-\d{2}$/, key);
  }
  assert.ok(Object.isFrozen(BUILTIN_PRICES) && Object.isFrozen(BUILTIN_PRICES["kimi/kimi-k2.6"]));
});

test("the example config file carries the same numbers as the built-in table", async () => {
  const example = JSON.parse(await fs.readFile(new URL("../../config/model-prices.example.json", import.meta.url), "utf8"));
  for (const [key, row] of Object.entries(BUILTIN_PRICES)) {
    const { sumber, tanggal, ...numbers } = row;
    assert.deepEqual(example.modelPrices[key], numbers, key);
    assert.equal(example.sumber[key].url, sumber, key);
  }
});

test("a built-in price is used when the owner has set none", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({}), now: () => NOW });
    let called = 0;
    await meter.call(req("kimi-k2.6"), async () => (called++, (await usage(1_000_000, 0))()));
    assert.equal(called, 1);
    const ledger = await ledgerOf(root);
    assert.ok(Math.abs(ledger.providers.kimi.usd - 0.95) < 1e-9, String(ledger.providers.kimi.usd));
  } finally {
    await rm(root);
  }
});

test("the owner's price always overrides the built-in row for that model", async () => {
  const root = await tmp();
  try {
    const settings = { modelPrices: { "kimi/kimi-k2.6": { input: 2, output: 8 } } };
    const meter = new CostMeter({ root, settings: () => settings, now: () => NOW });
    await meter.call(req("kimi-k2.6"), usage(1_000_000, 0));
    assert.ok(Math.abs((await ledgerOf(root)).providers.kimi.usd - 2) < 1e-9);
  } finally {
    await rm(root);
  }
});

test("a paid model in neither table is still refused before the provider, with a step the owner can take", async () => {
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ modelPrices: { "kimi/kimi-k2.5": { input: 1, output: 4 } } }), now: () => NOW });
    let called = 0;
    await assert.rejects(
      meter.call(req("kimi-k3"), async () => (called++, (await usage(1, 1))())),
      (e) => e.code === "ERR_COST_PRICE" && /kimi\/kimi-k3/.test(e.message) && /Pengaturan › Harga model/.test(e.message),
    );
    assert.equal(called, 0);
    await assert.rejects(fs.access(path.join(root, "costs")));
  } finally {
    await rm(root);
  }
});

test("built-in prices older than 90 days are flagged, and an owner override is marked", async () => {
  const fresh = builtinPriceInfo({}, Date.parse("2027-01-20T00:00:00+07:00"));
  assert.ok(fresh.every((r) => r.kedaluwarsa === false && r.ditimpa === false));
  const old = builtinPriceInfo({ "kimi/kimi-k2.6": { input: 1, output: 4 } }, Date.parse("2027-02-01T00:00:00+07:00"));
  const kimi = old.find((r) => r.model === "kimi/kimi-k2.6"),
    opus = old.find((r) => r.model === "anthropic/claude-opus-5-5");
  assert.equal(opus.kedaluwarsa, true);
  assert.equal(opus.ditimpa, false);
  assert.equal(kimi.ditimpa, true);
  assert.equal(kimi.sumber, BUILTIN_PRICES["kimi/kimi-k2.6"].sumber);
  // The day report warns about stale built-in rows that are still in use.
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ modelPrices: { "kimi/kimi-k2.6": { input: 1, output: 4 } } }), now: () => NOW + 120 * DAY });
    const report = await meter.report();
    assert.deepEqual(report.peringatanHarga.map((w) => w.model), ["anthropic/claude-opus-5-5"]);
    assert.match(report.peringatanHarga[0].pesan, /90 hari/);
    const today = await new CostMeter({ root, settings: () => ({}), now: () => NOW }).report();
    assert.deepEqual(today.peringatanHarga, []);
  } finally {
    await rm(root);
  }
});

test("a refused run carries the error code to the run and the finish event, so the UI can offer the fix", async () => {
  const root = await tmp();
  try {
    let called = 0;
    const f = fixture({
      settings: { internalMemory: false, active: "kimi", profiles: { kimi: { model: "kimi-k3" } } },
      provider: async () => (called++, reply("tidak boleh terpanggil")),
    });
    f.store.keys = { kimi: "kunci-uji" };
    f.runtime.meter = new CostMeter({ root, settings: () => f.store.settings, now: () => NOW });
    await f.runtime.start({ prompt: "halo", mode: "ask" });
    const run = f.parent();
    assert.equal(run.status, "failed");
    assert.equal(run.errorCode, "ERR_COST_PRICE");
    assert.equal(called, 0);
    const finish = f.events.find((e) => e.type === "finish");
    assert.equal(finish.errorCode, "ERR_COST_PRICE");
    // Errors that are not meter refusals carry no code.
    const g = fixture({ settings: { internalMemory: false }, provider: async () => Promise.reject(new Error("putus")) });
    await g.runtime.start({ prompt: "halo", mode: "ask" });
    assert.equal(g.parent().status, "failed");
    assert.equal(g.parent().errorCode, undefined);
  } finally {
    await rm(root);
  }
});

test("Settings receives the built-in rows with source, date, override and staleness", async () => {
  const { Store } = await import("../../src/core/storage.mjs");
  const root = await tmp();
  try {
    const crypto = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
    const store = new Store(root, crypto);
    await store.init();
    const rows = store.publicSettings().builtinPrices;
    assert.deepEqual(rows.map((r) => r.model).sort(), ["anthropic/claude-opus-5-5", "kimi/kimi-k2.6"]);
    assert.ok(rows.every((r) => r.sumber && r.tanggal && r.ditimpa === false && typeof r.kedaluwarsa === "boolean"));
    assert.equal(store.settings.builtinPrices, undefined, "built-in rows are not stored as owner settings");
  } finally {
    await rm(root);
  }
});

test("the Settings price table: built-in rows shown, only owner changes saved, bad numbers rejected", async () => {
  const t = await priceTable();
  const builtin = [
    { model: "kimi/kimi-k2.6", input: 0.95, output: 4, cached: 0.16, cacheCreated: 0.95, sumber: "https://platform.kimi.ai/docs/pricing/chat", tanggal: "2026-10-26", ditimpa: false, kedaluwarsa: false },
    { model: "anthropic/claude-opus-5-5", input: 4, output: 20, cached: 0.2, cacheCreated: 5, sumber: "https://platform.claude.com/docs/en/about-claude/pricing", tanggal: "2026-10-26", ditimpa: false, kedaluwarsa: true },
  ];
  const owner = { "kimi/kimi-k2.6": { input: 1, output: 5, cached: 1, cacheCreated: 1 }, "openai/gpt-x": { input: 2, output: 6, cached: 2, cacheCreated: 2 } };
  const rows = t.rowsFor(builtin, owner);
  assert.deepEqual(rows.map((r) => r.model), ["anthropic/claude-opus-5-5", "kimi/kimi-k2.6", "openai/gpt-x"]);
  assert.equal(rows.find((r) => r.model === "kimi/kimi-k2.6").asal, "milik");
  assert.equal(rows.find((r) => r.model === "anthropic/claude-opus-5-5").asal, "bawaan");
  assert.match(rows.find((r) => r.model === "anthropic/claude-opus-5-5").catatan, /90 hari/);
  // Unchanged built-in rows are not saved as owner prices; changed and extra rows are.
  const text = (r) => ({ model: r.model, input: String(r.input), output: String(r.output), cached: "", cacheCreated: "" });
  const saved = t.collect(rows.map(text), builtin);
  assert.deepEqual(Object.keys(saved).sort(), ["kimi/kimi-k2.6", "openai/gpt-x"]);
  assert.deepEqual(saved["kimi/kimi-k2.6"], { input: 1, output: 5 });
  // Putting a built-in row back to its numbers drops the owner override.
  const reset = rows.map(text).map((r) => (r.model === "kimi/kimi-k2.6" ? { ...r, input: "0.95", output: "4", cached: "0.16" } : r));
  assert.deepEqual(Object.keys(t.collect(reset, builtin)), ["openai/gpt-x"]);
  // Validation names the row and the field.
  for (const [bad, pattern] of [
    [{ model: "kimi/kimi-k3", input: "abc", output: "4", cached: "", cacheCreated: "" }, /kimi\/kimi-k3.*input/],
    [{ model: "kimi/kimi-k3", input: "-1", output: "4", cached: "", cacheCreated: "" }, /kimi\/kimi-k3.*input/],
    [{ model: "kimi/kimi-k3", input: "1", output: "1001", cached: "", cacheCreated: "" }, /kimi\/kimi-k3.*output/],
    [{ model: "kimi/kimi-k3", input: "1", output: "", cached: "", cacheCreated: "" }, /kimi\/kimi-k3.*output/],
    [{ model: "gratis/model", input: "1", output: "1", cached: "", cacheCreated: "" }, /gratis\/model/],
    [{ model: "kimi/kimi-k3", input: "1", output: "2", cached: "x", cacheCreated: "" }, /kimi\/kimi-k3.*cache/i],
  ])
    assert.throws(() => t.collect([bad], builtin), pattern, JSON.stringify(bad));
  // A blank extra row is ignored.
  assert.deepEqual(t.collect([{ model: "", input: "", output: "", cached: "", cacheCreated: "" }], builtin), {});
});

test("a price refusal in the chat offers the step that exists: Pengaturan › Harga model", async () => {
  const t = await priceTable();
  assert.deepEqual(t.errorAction("ERR_COST_PRICE"), { label: "Buka Pengaturan › Harga model", target: "priceSettings" });
  assert.equal(t.errorAction(undefined), null);
  assert.equal(t.errorAction("ERR_COST_CAP"), null);
  const html = await fs.readFile(new URL("../../ui/index.html", import.meta.url), "utf8");
  assert.match(html, /<details id="priceSettings"[\s\S]*Harga model[\s\S]*id="priceRows"/);
  assert.match(html, /<script src="price-table.js"><\/script>[\s\S]*<script src="app.js">/);
});

test("(f) the run's cost receipt uses the meter's price key and formula, never a fixed 'not set' note", async () => {
  // the owner's Kimi run (26 Oct 2026) passed the meter with an installed price, yet the run line said
  // "Harga model belum diatur": that text was fixed in the receipt. The receipt must now report
  // the same dollars the ledger records for the same call.
  const root = await tmp();
  try {
    const f = fixture({
      settings: { internalMemory: false, active: "kimi", profiles: { kimi: { model: "kimi-k2.6" } } },
      provider: async () => ({ text: "Ibukota Indonesia adalah Jakarta.", calls: [], finishReason: "completed", usage: { input: 547, output: 179, available: true }, message: { role: "assistant", content: "Jakarta", calls: [] } }),
    });
    f.store.keys = { kimi: "kunci-uji" };
    f.runtime.meter = new CostMeter({ root, settings: () => f.store.settings, now: () => NOW });
    await f.runtime.start({ prompt: "Apa ibukota indonesia", mode: "ask" });
    assert.equal(f.parent().status, "responded");
    const ledgerUsd = (await ledgerOf(root)).models["kimi/kimi-k2.6"].usd;
    assert.ok(Math.abs(ledgerUsd - (547 * 0.95 + 179 * 4) / 1e6) < 1e-12, String(ledgerUsd));
    const receipt = f.events.filter((e) => e.type === "agen.pemakaian").at(-1);
    assert.equal(receipt.cost, Number(ledgerUsd.toFixed(6)));
    assert.match(receipt.costNote, /US\$0\.0012/);
    assert.match(receipt.costNote, /kimi\/kimi-k2\.6/);
    assert.doesNotMatch(receipt.costNote, /belum diatur/);
    // A local model costs no dollars and says so.
    const g = fixture({ settings: { internalMemory: false }, provider: async () => ({ text: "ok", calls: [], finishReason: "completed", usage: { input: 5, output: 5, available: true }, message: { role: "assistant", content: "ok", calls: [] } }) });
    await g.runtime.start({ prompt: "halo", mode: "ask" });
    const local = g.events.filter((e) => e.type === "agen.pemakaian").at(-1);
    assert.equal(local.cost, null);
    assert.match(local.costNote, /Model lokal; tidak ada biaya dolar/);
    // Usage the provider did not report is not priced as if it were zero.
    const h = fixture({
      settings: { internalMemory: false, active: "kimi", profiles: { kimi: { model: "kimi-k2.6" } } },
      provider: async () => ({ text: "ok", calls: [], finishReason: "completed", usage: { available: false }, message: { role: "assistant", content: "ok", calls: [] } }),
    });
    h.store.keys = { kimi: "kunci-uji" };
    await h.runtime.start({ prompt: "halo", mode: "ask" });
    const unreported = h.events.filter((e) => e.type === "agen.pemakaian").at(-1);
    assert.equal(unreported.cost, null);
    assert.match(unreported.costNote, /tidak dilaporkan/);
  } finally {
    await rm(root);
  }
});

test("(h) a request refused before processing (400/401/403/404/413) releases its reservation; other failures keep the worst case", async () => {
  // the owner's Opus run (26 Oct 2026) failed with HTTP 400 (key not scoped to a workspace), yet the
  // ledger kept 2850 tokens and US$0.045: the worst case was never released. A 4xx of this kind is
  // refused before the model runs, so nothing is billed; a timeout, a 5xx, a 429 or a cut connection
  // may have been processed and keeps the worst case (P1-1).
  const kinds = [
    [400, true],
    [401, true],
    [403, true],
    [404, true],
    [413, true],
    [429, false],
    [500, false],
    [529, false],
    [undefined, false],
  ];
  for (const [status, released] of kinds) {
    const root = await tmp();
    try {
      const meter = new CostMeter({ root, settings: () => ({}), now: () => NOW });
      const failure = Object.assign(new Error("anthropic HTTP " + status), status === undefined ? {} : { status });
      await assert.rejects(meter.call({ ...req("kimi-k2.6"), profile: { provider: "anthropic", model: "claude-opus-5-5" } }, async () => Promise.reject(failure)), (e) => e === failure);
      const e = (await ledgerOf(root)).providers.anthropic;
      assert.equal(e.failed, 1, String(status));
      assert.equal(e.calls, 1, String(status));
      assert.equal(e.reserved, 0, String(status));
      if (released) {
        assert.equal(e.tokens, 0, "released: " + status);
        assert.equal(e.usd, 0, "released: " + status);
      } else {
        assert.ok(e.tokens > 0 && e.usd > 0, "worst case kept: " + status);
      }
    } finally {
      await rm(root);
    }
  }
});

test("(h) provider errors carry the HTTP status the meter needs", async () => {
  const { invokeModel } = await import("../../src/core/providers.mjs");
  for (const status of [400, 401, 413, 500]) {
    const error = await invokeModel({
      profile: { provider: "kimi", model: "kimi-k2.6" },
      key: "k",
      system: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      signal: new AbortController().signal,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: "ditolak" } }), { status }),
    }).catch((e) => e);
    assert.equal(error.status, status);
  }
});

test("H11: a zero input or output price for a paid model is refused, so the dollar cap can never be switched off", async () => {
  // AYMAN alpha.19 note H11: an owner price of 0 was accepted, so that model's calls cost US$0 and
  // the daily dollar cap never applied. Paid models need input and output > 0; a cache price may be 0.
  const { validatePrices } = meterModule;
  assert.throws(() => validatePrices({ "kimi/kimi-k2.6": { input: 0, output: 4 } }), /input and output/);
  assert.throws(() => validatePrices({ "anthropic/claude-opus-5-5": { input: 4, output: 0 } }), /input and output/);
  assert.equal(validatePrices({ "kimi/kimi-k2.6": { input: 0.95, output: 4, cached: 0 } })["kimi/kimi-k2.6"].cached, 0);
  // A zero already in saved settings makes the meter refuse (fail-closed), never run uncapped.
  const root = await tmp();
  try {
    const meter = new CostMeter({ root, settings: () => ({ modelPrices: { "kimi/kimi-k2.6": { input: 0, output: 0 } } }), now: () => NOW });
    let called = 0;
    await assert.rejects(meter.call(req("kimi-k2.6"), async () => (called++, (await usage(1, 1))())), (e) => e.code === "ERR_COST_SETTINGS");
    assert.equal(called, 0);
  } finally {
    await rm(root);
  }
  // Settings shows the reason before saving.
  const t = await priceTable();
  assert.throws(() => t.collect([{ model: "kimi/kimi-k3", input: "0", output: "4", cached: "", cacheCreated: "" }], []), /kimi\/kimi-k3.*input.*lebih dari 0/);
  assert.deepEqual(t.collect([{ model: "kimi/kimi-k3", input: "1", output: "4", cached: "0", cacheCreated: "" }], []), { "kimi/kimi-k3": { input: 1, output: 4, cached: 0 } });
});

test("H10: an error raised before the request left the app is marked not sent and releases the reservation", async () => {
  // AYMAN alpha.19 note H10: a malformed workspace ID failed before fetch yet the ledger kept the
  // US$20 worst case. Markas (27 Oct 2026): mark pre-fetch failures as not sent; release them.
  const { invokeModel } = await import("../../src/core/providers.mjs");
  const base = { key: "k", system: "s", messages: [{ role: "user", content: "x" }], tools: [], signal: new AbortController().signal };
  let fetched = 0;
  const before = await invokeModel({ ...base, profile: { provider: "anthropic", model: "claude-opus-5-5", workspaceId: "bukan-id" }, fetchImpl: async () => (fetched++, new Response("{}")) }).catch((e) => e);
  assert.equal(fetched, 0);
  assert.equal(before.notSent, true);
  const network = await invokeModel({ ...base, profile: { provider: "kimi", model: "kimi-k2.6" }, fetchImpl: async () => Promise.reject(new Error("putus")) }).catch((e) => e);
  assert.notEqual(network.notSent, true, "a cut connection may have been processed");
  const server = await invokeModel({ ...base, profile: { provider: "kimi", model: "kimi-k2.6" }, fetchImpl: async () => new Response("{}", { status: 500 }) }).catch((e) => e);
  assert.notEqual(server.notSent, true);
  // The meter releases a not-sent failure and keeps the worst case otherwise.
  for (const [failure, released] of [[Object.assign(new Error("lokal"), { notSent: true }), true], [new Error("putus"), false]]) {
    const root = await tmp();
    try {
      const meter = new CostMeter({ root, settings: () => ({}), now: () => NOW });
      await assert.rejects(meter.call({ ...req("kimi-k2.6"), profile: { provider: "anthropic", model: "claude-opus-5-5" } }, async () => Promise.reject(failure)));
      const e = (await ledgerOf(root)).providers.anthropic;
      assert.equal(e.failed, 1);
      assert.equal(e.usd === 0 && e.tokens === 0, released, failure.message);
    } finally {
      await rm(root);
    }
  }
});
