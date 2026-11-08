import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// OpenAI Responses API: cached_tokens and cache_write_tokens are PART of input_tokens.
// Source: https://developers.openai.com/api/docs/guides/prompt-caching (read 27 Oct 2026): "In this
// usage example, 1,000 input tokens are ordinary input: 12000 - 4000 - 7000". The usage object below
// is that page's example. Before this fix the adapter billed the 4000 cached tokens twice (as input
// and as cached) and never reported the 7000 written tokens. Kimi follows the same rule since its docs
// were read and the mode QA saw real cache hits (meteran-kimi-cache.test.mjs).
const signal = new AbortController().signal;
const DOCS_USAGE = {
  input_tokens: 12000,
  input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } },
  output_tokens: 50,
};

const call = (provider, body, profile = {}) =>
  invokeModel({
    profile: { provider, model: "m", ...profile },
    key: "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "Halo" }],
    tools: [],
    signal,
    fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
  });

test("OpenAI: ordinary input excludes cached and written tokens (docs example)", async () => {
  const r = await call("openai", { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: DOCS_USAGE });
  assert.equal(r.usage.input, 1000);
  assert.equal(r.usage.cached, 4000);
  assert.equal(r.usage.cacheCreated, 7000);
  assert.equal(r.usage.output, 50);
});

test("OpenAI: a provider reporting more cache than input never gives negative input", async () => {
  const r = await call("openai", { status: "completed", output: [], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 150 }, output_tokens: 1 } });
  assert.equal(r.usage.input, 0);
});

test("OpenAI without cache details keeps the input as reported", async () => {
  const r = await call("openai", { status: "completed", output: [], usage: { input_tokens: 321, output_tokens: 2 } });
  assert.equal(r.usage.input, 321);
});

test("Kimi with zero cached tokens keeps its input (Kimi rules: meteran-kimi-cache.test.mjs)", async () => {
  const r = await call("kimi", { choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 717, completion_tokens: 164, prompt_tokens_details: { cached_tokens: 0 } } }, { baseURL: "https://api.moonshot.ai/v1" });
  assert.equal(r.usage.input, 717);
});

test("Anthropic is unchanged: its input_tokens already exclude cache", async () => {
  const r = await call("anthropic", { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } });
  assert.deepEqual([r.usage.input, r.usage.cached, r.usage.cacheCreated], [2, 900, 50]);
});
