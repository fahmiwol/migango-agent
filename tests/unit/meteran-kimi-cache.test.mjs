import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// Kimi chat completions: "usage.prompt_tokens is always the total number of input tokens" and
// "cached_tokens, cache_write_tokens, and the uncached remainder are mutually exclusive and sum to
// prompt_tokens" (platform.kimi.ai/docs/api/chat, read 27 Oct 2026). The adapter billed cached
// tokens twice and never reported writes. Real evidence: the mode QA of 27 Oct (live b46bf05)
// reported 512 cached of 1944 input (Tanya) and 5632 of 11703 (Kerjakan) for kimi-k2.6. The raw
// response is not stored by the app, so the fixtures are the docs' own usage example plus the
// documented field layout; the QA counts are cited above.
const signal = new AbortController().signal;
const call = (usage) =>
  invokeModel({
    profile: { provider: "kimi", model: "kimi-k2.6" },
    key: "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "Halo" }],
    tools: [],
    signal,
    fetchImpl: async () => new Response(JSON.stringify({ model: "kimi-k2.6", choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage }), { status: 200 }),
  });

test("docs example: 256 of 373 input tokens were cache writes", async () => {
  const r = await call({ completion_tokens: 112, prompt_tokens: 373, total_tokens: 485, completion_tokens_details: { reasoning_tokens: 90 }, prompt_tokens_details: { cache_write_tokens: 256 } });
  assert.deepEqual([r.usage.input, r.usage.cacheCreated, r.usage.output], [117, 256, 112]);
});

test("cached tokens inside prompt_tokens are not billed twice (QA shape: 512 of 1944)", async () => {
  const r = await call({ prompt_tokens: 1944, completion_tokens: 623, total_tokens: 2567, prompt_tokens_details: { cached_tokens: 512 } });
  assert.deepEqual([r.usage.input, r.usage.cached], [1432, 512]);
});

test("cached_tokens at the top level of usage (listed in Kimi's schema) is read too", async () => {
  const r = await call({ prompt_tokens: 11703, completion_tokens: 707, total_tokens: 12410, cached_tokens: 5632 });
  assert.deepEqual([r.usage.input, r.usage.cached], [6071, 5632]);
});

test("Kimi without cache details keeps prompt_tokens as input", async () => {
  const r = await call({ prompt_tokens: 717, completion_tokens: 164, total_tokens: 881 });
  assert.deepEqual([r.usage.input, r.usage.cached], [717, null]);
});

test("a negative or fractional cache counter from Kimi is refused, never billed", async () => {
  for (const usage of [
    { prompt_tokens: 100, completion_tokens: 1, cached_tokens: -5 },
    { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cache_write_tokens: 2.5 } },
  ])
    await assert.rejects(call(usage), /Invalid provider usage counters/);
});
