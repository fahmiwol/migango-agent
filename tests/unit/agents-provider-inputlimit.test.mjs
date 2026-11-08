// ARS-004 §11, todo #26, D-005 second small exception (markas, 22 Oct 2026): the provider preflight
// accepts an optional per-call inputLimit. Additive: default 48000 for API providers is unchanged;
// Ollama keeps its num_ctx formula. Values outside 8000-200000 are refused (never clamped), and when the
// profile declares contextWindowTokens a limit that cannot fit that window is refused. Fixture HTTP only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

const big = (bytes) => [{ role: "user", content: "x".repeat(bytes) }];
const call = async (provider, messages, extra = {}, profileExtra = {}) => {
  let fetched = 0;
  const p = invokeModel({
    profile: { provider, model: "fixture", baseURL: "http://127.0.0.1:11434", ...profileExtra },
    key: provider === "ollama" ? undefined : "fixture-only",
    system: "s",
    messages,
    tools: [],
    signal: new AbortController().signal,
    fetchImpl: async () => (
      fetched++,
      new Response(
        JSON.stringify(
          provider === "ollama"
            ? { model: "fixture", message: { role: "assistant", content: "ok" }, done: true, prompt_eval_count: 1, eval_count: 1 }
            : { model: "fixture", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
        ),
        { status: 200 },
      )
    ),
    ...extra,
  });
  return { p, fetched: () => fetched };
};

test("default API preflight stays at 48000 bytes", async () => {
  const over = await call("anthropic", big(60000));
  await assert.rejects(() => over.p, /Context preflight rejected \d+ UTF-8 bytes \(limit 48000\)/);
  assert.equal(over.fetched(), 0);
});

test("a larger inputLimit lets a 60 KB request through; above it is refused before HTTP", async () => {
  const ok = await call("anthropic", big(60000), { inputLimit: 160000 });
  assert.equal((await ok.p).text, "ok");
  assert.equal(ok.fetched(), 1);
  const over = await call("anthropic", big(170000), { inputLimit: 160000 });
  await assert.rejects(() => over.p, /\(limit 160000\)/);
  assert.equal(over.fetched(), 0);
});

test("inputLimit outside 8000-200000 is refused, not clamped", async () => {
  for (const inputLimit of [7999, 200001, 10_000_000, 1.5, "160000", -1]) {
    const r = await call("anthropic", big(100), { inputLimit });
    await assert.rejects(() => r.p, /inputLimit/, String(inputLimit));
    assert.equal(r.fetched(), 0, String(inputLimit));
  }
  const edge = await call("anthropic", big(100), { inputLimit: 200000 });
  assert.equal((await edge.p).text, "ok");
});

test("inputLimit that cannot fit the profile's declared context window is refused", async () => {
  // 160000 bytes is up to ~53k tokens at 3 bytes/token, plus maxOutput; a 32k window cannot hold it.
  const small = await call("anthropic", big(100), { inputLimit: 160000, maxOutput: 8192 }, { contextWindowTokens: 32000 });
  await assert.rejects(() => small.p, /context window|jendela konteks/i);
  assert.equal(small.fetched(), 0);
  const large = await call("anthropic", big(100), { inputLimit: 160000, maxOutput: 8192 }, { contextWindowTokens: 200000 });
  assert.equal((await large.p).text, "ok");
});

test("Ollama ignores inputLimit and keeps its num_ctx preflight", async () => {
  // num_ctx 16384 since 8 Nov 2026 (home server): preflight 16384 - output - 512 bytes; 20000 is over it.
  const local = await call("ollama", big(20000), { inputLimit: 160000 });
  await assert.rejects(() => local.p, /Context preflight rejected/);
  assert.equal(local.fetched(), 0);
});
