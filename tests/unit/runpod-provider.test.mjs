import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel, providerTimeoutMs } from "../../src/core/providers.mjs";

// RunPod serverless vLLM, OpenAI-compatible chat completions. Belum diverifikasi live:
// URL dan format diambil dari permintaan pemilik, bukan diuji dengan kunci sungguhan.
const KEY = "fixture-only";
const EP = "abc123def456";
const ok = (extra = {}) =>
  new Response(JSON.stringify({ model: "qwen-7b", choices: [{ message: { content: "Jakarta" }, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 }, ...extra }));
const call = (profile, fetchImpl, signal = new AbortController().signal) =>
  invokeModel({ profile: { provider: "runpod", model: "qwen-7b", endpointId: EP, ...profile }, key: KEY, system: "s", messages: [{ role: "user", content: "Ibu kota?" }], tools: [], signal, fetchImpl });

test("runpod sends chat completions to the URL built from endpointId only", async () => {
  let seen;
  const reply = await call({ baseURL: "https://evil.example" }, async (url, opts) => ((seen = { url, opts }), ok()));
  assert.equal(seen.url, "https://api.runpod.ai/v2/" + EP + "/openai/v1/chat/completions");
  assert.equal(seen.opts.headers.Authorization, "Bearer " + KEY);
  assert.equal(seen.opts.redirect, "error");
  const body = JSON.parse(seen.opts.body);
  assert.equal(body.model, "qwen-7b");
  assert.equal(body.messages[0].role, "system");
  assert.equal(reply.text, "Jakarta");
  assert.deepEqual([reply.usage.input, reply.usage.output, reply.usage.available], [7, 2, true]);
});

test("a malformed endpointId is refused before anything is sent", async () => {
  for (const bad of [undefined, "", "abc", "ABCDEFGH12", "abc123def456.evil.com", "../../x/abcdefgh", "abc123def456/x", "a".repeat(41), 42]) {
    let sent = 0;
    const e = await call({ endpointId: bad }, async () => (sent++, ok())).catch((x) => x);
    assert.match(e.message, /endpointId/i, String(bad));
    assert.equal(e.notSent, true);
    assert.equal(sent, 0, String(bad));
  }
});

test("runpod timeout is longer by default, owner-settable and validated", () => {
  assert.equal(providerTimeoutMs({ provider: "kimi" }), 90000);
  assert.equal(providerTimeoutMs({ provider: "runpod" }), 300000);
  assert.equal(providerTimeoutMs({ provider: "runpod", timeoutSeconds: 600 }), 600000);
  for (const bad of [5, 0, 2000, 1.5, "60"]) assert.throws(() => providerTimeoutMs({ provider: "runpod", timeoutSeconds: bad }), /timeoutSeconds/);
});

test("5xx and timeout give a clear message, keep the status, and never retry", async () => {
  let sent = 0;
  const e5 = await call({}, async () => (sent++, new Response("{}", { status: 503 }))).catch((x) => x);
  assert.equal(sent, 1);
  assert.equal(e5.status, 503);
  assert.match(e5.message, /runpod HTTP 503/);
  assert.match(e5.message, /cold start|worker/i);
  assert.match(e5.message, /No automatic retry/);
  sent = 0;
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const et = await call({}, async () => (sent++, Promise.reject(timeout))).catch((x) => x);
  assert.equal(sent, 1);
  assert.equal(et.code, "ERR_PROVIDER_TIMEOUT");
  assert.match(et.message, /timeoutSeconds/);
  assert.match(et.message, /No automatic retry/);
  assert.notEqual(et.notSent, true, "a timed-out request may have been billed");
});

test("the key never appears in a provider error message", async () => {
  const e = await call({}, async () => new Response(JSON.stringify({ error: { message: "bad key fixture-only" } }), { status: 401 })).catch((x) => x);
  assert.doesNotMatch(e.message, /fixture-only/);
});
