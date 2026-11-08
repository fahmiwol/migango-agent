import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { invokeModel } from "../../src/core/providers.mjs";
import { CostMeter, PAID_PROVIDERS, DEFAULT_CAPS, BUILTIN_PRICES, validateCaps, mergeCaps, validatePrices } from "../../src/core/cost-meter.mjs";

// Gemini through the cost meter (task 07c part 2, markas 28 Oct 2026). The owner's account is
// prepaid and this path can charge their card, so every guard is proved with a counting fake fetch.
// Source: tmp-migan/riset-gemini/RINGKASAN-GEMINI-API.md (official docs, read 2026-10-28):
// - section 7: https://ai.google.dev/gemini-api/docs/pricing was opened but the summary quotes NO
//   price numbers, so there is no built-in Gemini row; every Gemini model needs the owner's price.
// - section 8, https://ai.google.dev/gemini-api/docs/billing#am-i-charged-for-failed-requests:
//   "400/500 tidak ditagih"; billing on 403/429, timeouts and cut streams is "belum terverifikasi",
//   so those keep the worst-case reservation.
const KEY = ["AI", "za"].join("") + "FixtureOnly-meter-not-a-real-key-0000";
const signal = new AbortController().signal;
const sse = (frames) => frames.map((f) => `data: ${JSON.stringify(f)}\r\n\r\n`).join("");
const done = (extra = {}) => ({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], ...extra });

async function setup(settings) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gemini-meter-"));
  const meter = new CostMeter({ root, settings: () => settings });
  const seen = [];
  const run = (reply = { body: sse([done()]), status: 200 }, opts = {}) =>
    meter
      .call(
        { profile: { provider: "gemini", model: "fixture-gemini" }, key: KEY, system: "s", messages: [{ role: "user", content: "x" }], tools: [], signal, maxOutput: 100, ...opts },
        (req) =>
          invokeModel({
            ...req,
            fetchImpl: async (url, init) => {
              seen.push({ url, init });
              return new Response(reply.body, { status: reply.status });
            },
          }),
      )
      .catch((e) => e);
  const gemini = async () => (await meter.report()).providers.find((p) => p.provider === "gemini");
  return { meter, seen, run, gemini };
}
const PRICE = { "gemini/fixture-gemini": { input: 2, output: 10, cached: 0.5 } };

test("gemini is a paid provider with a US$3/day default cap and no guessed built-in price", () => {
  assert.ok(PAID_PROVIDERS.includes("gemini"));
  assert.equal(DEFAULT_CAPS.gemini.usd, 3);
  assert.equal(validateCaps(undefined).gemini.usd, 3);
  assert.equal(mergeCaps({ kimi: { usd: 3 } }, undefined).gemini.usd, 3, "an old stored cap table still gets the Gemini cap");
  assert.deepEqual(Object.keys(BUILTIN_PRICES).filter((k) => k.startsWith("gemini/")), [], "the summary quotes no Gemini numbers");
  assert.deepEqual(validatePrices(PRICE)["gemini/fixture-gemini"], { input: 2, output: 10, cached: 0.5, cacheCreated: 2 });
});

test("no owner price: refused with ERR_COST_PRICE before any fetch", async () => {
  const { seen, run } = await setup({});
  const e = await run();
  assert.equal(e.code, "ERR_COST_PRICE");
  assert.equal(seen.length, 0);
});

test("cap spent: refused before fetch, the default US$3 applies even when stored caps lack gemini", async () => {
  const dear = { "gemini/fixture-gemini": { input: 1, output: 1000 } };
  for (const dailyCaps of [undefined, { kimi: { usd: 3 } }]) {
    const { seen, run } = await setup({ modelPrices: dear, dailyCaps });
    const e = await run(undefined, { maxOutput: 3001 });
    assert.equal(e.code, "ERR_COST_CAP");
    assert.equal(seen.length, 0, "worst case above US$3 is refused before fetch");
  }
  // Worst case is reserved before fetch: an answer without usage keeps it, so the 2nd call is refused.
  const { seen, run, gemini } = await setup({ modelPrices: dear });
  const first = await run({ body: sse([done()]), status: 200 }, { maxOutput: 2000 });
  assert.equal(first.text, "ok");
  assert.equal(seen.length, 1);
  assert.ok((await gemini()).usd >= 2);
  const second = await run({ body: sse([done()]), status: 200 }, { maxOutput: 2000 });
  assert.equal(second.code, "ERR_COST_CAP");
  assert.equal(seen.length, 1, "no fetch once the cap would be passed");
});

test("settled cost: input = prompt - cached, cached at its own rate once, thoughts as output", async () => {
  const { run, gemini } = await setup({ modelPrices: PRICE });
  const usageMetadata = { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 30 };
  const reply = await run({ body: sse([done({ usageMetadata })]), status: 200 });
  assert.equal(reply.text, "ok");
  const g = await gemini();
  assert.equal(g.tokens, 400 + 600 + 80);
  assert.ok(Math.abs(g.usd - (400 * 2 + 600 * 0.5 + 80 * 10) / 1e6) < 1e-12, String(g.usd));
  assert.equal(g.capUsd, 3);
});

test("saldo habis: ERR_GEMINI_SALDO, one fetch, no retry, worst case kept (429/403 billing unverified)", async () => {
  const quota = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, check your plan and billing details." } });
  const credit = JSON.stringify({ error: { code: 403, message: "Prepaid credit balance is depleted" } });
  for (const [body, status] of [[quota, 429], [credit, 403]]) {
    const { seen, run, gemini } = await setup({ modelPrices: PRICE });
    const e = await run({ body, status });
    assert.equal(e.code, "ERR_GEMINI_SALDO");
    assert.match(e.message, /^saldo Gemini habis/);
    assert.equal(seen.length, 1, "never retried");
    const g = await gemini();
    assert.deepEqual([g.calls, g.failed, g.reserved], [1, 1, 0]);
    assert.ok(g.usd > 0, "billing unverified for " + status + ": the worst case stays counted");
  }
  // 400 is documented as not billed: the reservation is released.
  const { run, gemini } = await setup({ modelPrices: PRICE });
  const e = await run({ body: JSON.stringify({ error: { code: 400, message: "Invalid argument" } }), status: 400 });
  assert.equal(e.status, 400);
  assert.equal((await gemini()).usd, 0);
});

test("through the meter the key stays in the header, never in the URL", async () => {
  const { seen, run } = await setup({ modelPrices: PRICE });
  await run();
  assert.equal(seen[0].init.headers["x-goog-api-key"], KEY);
  assert.ok(!seen[0].url.includes(KEY) && !/[?&]key=/.test(seen[0].url));
});
