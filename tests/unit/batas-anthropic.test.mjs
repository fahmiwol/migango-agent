// Markas, 29 Oct 2026: the per-request limit follows the profile window, but Anthropic keeps the old
// 200 KB cap until its cost is assessed. One 600 KB request to Opus is hundreds of thousands of input
// tokens against a US$5 daily cap. Fixture HTTP only: the fetch counter proves no call is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel, adapterInputLimit } from "../../src/core/providers.mjs";

const KB600 = 600_000;
async function kirim(profile) {
  let fetched = 0;
  const result = await invokeModel({
    profile: { contextWindowTokens: 1_000_000, ...profile },
    key: "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "x".repeat(KB600) }],
    tools: [],
    signal: new AbortController().signal,
    maxOutput: 16000,
    inputLimit: 900_000,
    fetchImpl: async () => {
      fetched++;
      return new Response(JSON.stringify({ model: profile.model, choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
    },
  }).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));
  return { ...result, fetched };
}

test("a ~600 KB request to a 1M-window Anthropic profile is refused before any network call", async () => {
  const a = await kirim({ provider: "anthropic", model: "claude-opus-5-5" });
  assert.equal(a.ok, false);
  assert.match(a.e.message, /Context preflight rejected/);
  assert.equal(a.fetched, 0);
});

test("the same ~600 KB request to a 1M-window Kimi profile passes", async () => {
  const k = await kirim({ provider: "kimi", model: "kimi-k3.1-pro" });
  assert.equal(k.ok, true, k.e?.message);
  assert.equal(k.fetched, 1);
});

test("the runtime compaction target for Anthropic never exceeds 200 KB, whatever the mode setting", () => {
  assert.equal(adapterInputLimit("anthropic", 16000, 600_000), 200_000);
  assert.equal(adapterInputLimit("anthropic", 16000, 120_000), 120_000);
  assert.equal(adapterInputLimit("kimi", 16000, 600_000), 600_000);
});
