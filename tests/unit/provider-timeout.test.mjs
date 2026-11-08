import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel, providerTimeoutMs } from "../../src/core/providers.mjs";

// Requests are not streamed, so the whole reply must arrive inside the timeout. A flat 90 s cut a
// 05f Opus turn (work mode, 4096 output tokens) and billed it; the wait now grows with maxOutput.
const KEY = "fixture-only";
const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
const call = (maxOutput) =>
  invokeModel({
    profile: { provider: "anthropic", model: "claude-opus-5-5" },
    key: KEY,
    system: "s",
    messages: [{ role: "user", content: "halo" }],
    tools: [],
    signal: new AbortController().signal,
    ...(maxOutput ? { maxOutput } : {}),
    fetchImpl: async () => Promise.reject(timeout),
  }).catch((x) => x);

test("API timeout grows with maxOutput and keeps 90 s as the floor", () => {
  assert.equal(providerTimeoutMs({ provider: "anthropic" }), 90000);
  assert.equal(providerTimeoutMs({ provider: "anthropic" }, 1024), 91000);
  assert.equal(providerTimeoutMs({ provider: "anthropic" }, 4096), 183000);
  assert.equal(providerTimeoutMs({ provider: "kimi" }, 8192), 306000);
  assert.equal(providerTimeoutMs({ provider: "anthropic" }, 16000), 540000);
  assert.equal(providerTimeoutMs({ provider: "anthropic" }, 1e9), 600000, "capped at 10 minutes");
  for (const bad of [0, -5, NaN, "4096", null]) assert.equal(providerTimeoutMs({ provider: "anthropic" }, bad), 90000, String(bad));
});

// The home server is CPU-only: 4.5-8.5 tok/s measured 8 Nov 2026, so 30 ms/token (33 tok/s) cut the local model
// runs at 90 s ("ollama timed out after 90 s", 3 of 5 daily tasks). Local waits 200 ms/token.
test("Ollama timeout follows CPU generation speed (200 ms per output token)", () => {
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 512), 163000);
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 1024), 265000);
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 2048), 470000);
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 1e9), 600000, "capped at 10 minutes");
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 0), 90000);
});

// BH-06 (GATE-1): the local timeout ignored prefill. qwen3.5:4b prefills ~33 tok/s and 9B ~19 tok/s
// on home server (RISET-070); a full 14.8 KB request is ~4,900 tokens ≈ 150-260 s before the first output
// token. Local waits 60 ms per prompt token (bytes/3 upper estimate) on top; API unchanged.
test("BH-06: Ollama timeout also counts the prompt (prefill), capped at 10 minutes", () => {
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 1024, 0), 265000, "no prompt bytes = old value");
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 1024, 3000), 325000, "+1000 tokens × 60 ms");
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 1024, 14848), 562000);
  assert.equal(providerTimeoutMs({ provider: "ollama" }, 2048, 14848), 600000, "cap");
  assert.equal(providerTimeoutMs({ provider: "anthropic" }, 4096, 14848), 183000, "API ignores prompt size");
});

test("BH-06: a real Ollama request is given the prefill-aware timeout", async () => {
  const e = await invokeModel({
    profile: { provider: "ollama", model: "qwen3.5:4b", baseURL: "http://127.0.0.1:11434" },
    system: "s",
    messages: [{ role: "user", content: "x".repeat(9000) }],
    tools: [],
    signal: new AbortController().signal,
    maxOutput: 1024,
    fetchImpl: async () => Promise.reject(timeout),
  }).catch((x) => x);
  const s = Number(String(e.message).match(/timed out after (\d+) s/)?.[1]);
  assert.ok(s > 265, "prompt bytes counted: " + e.message);
});

test("the RunPod timeout is unchanged by maxOutput", () => {
  assert.equal(providerTimeoutMs({ provider: "runpod" }, 16000), 300000);
  assert.equal(providerTimeoutMs({ provider: "runpod", timeoutSeconds: 60 }, 16000), 60000);
});

test("the request uses the timeout of its own maxOutput", async () => {
  const e = await call(4096);
  assert.equal(e.code, "ERR_PROVIDER_TIMEOUT");
  assert.match(e.message, /timed out after 183 s/);
  assert.match(e.message, /No automatic retry/);
  assert.match((await call()).message, /timed out after 122 s/, "the default 2048 output tokens");
});
