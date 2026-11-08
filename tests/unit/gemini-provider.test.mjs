import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// Gemini adapter (task 07c part 1, markas 28 Oct 2026). Source for every shape used here:
// tmp-migan/riset-gemini/RINGKASAN-GEMINI-API.md, a summary of the official docs, all read
// 2026-10-28 (https://ai.google.dev/api, https://ai.google.dev/api/generate-content,
// https://ai.google.dev/gemini-api/docs/api-key). Fetch is always a fake; no real key exists here.
// Real-response fixtures follow after the owner's first live run.
const signal = new AbortController().signal;
// Fake keys are assembled at runtime so the repository secret scanner (.githooks) stays strict
// and no source line looks like a real Google key.
const GOOGLE_PREFIX = ["AI", "za"].join("");
const KEY = GOOGLE_PREFIX + "FixtureOnly-not-a-real-key-000000000";
const ECHOED = GOOGLE_PREFIX + "SyD-0123456789abcdefghijklmnopqrstuv";
const sse = (frames) => frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\r\n\r\n`).join("");
function streamOf(text, sizes = [7, 1, 23, 3, 64]) {
  const bytes = new TextEncoder().encode(text);
  const parts = [];
  for (let i = 0, k = 0; i < bytes.length; k++) {
    const n = sizes[k % sizes.length];
    parts.push(bytes.slice(i, i + n));
    i += n;
  }
  return new ReadableStream({ pull(c) { const p = parts.shift(); p ? c.enqueue(p) : c.close(); } });
}
const TOOLS = [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } }];
async function call(body, opts = {}, status = 200) {
  const seen = [];
  const reply = await invokeModel({
    profile: { provider: "gemini", model: "fixture-gemini" },
    key: KEY,
    system: "Jawab singkat.",
    messages: [{ role: "user", content: "Halo" }],
    tools: TOOLS,
    signal,
    ...opts,
    fetchImpl: async (url, init) => {
      seen.push({ url, init, body: JSON.parse(init.body) });
      const payload = typeof body === "string" ? streamOf(body) : body;
      return new Response(payload, { status, headers: { "content-type": status === 200 ? "text/event-stream" : "application/json" } });
    },
  }).catch((e) => e);
  return { reply, seen };
}
const done = (parts, extra = {}) => ({ candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...extra });
const piece = (parts) => ({ candidates: [{ content: { role: "model", parts } }] });

test("request: streaming URL, key only in x-goog-api-key, systemInstruction, contents, tools", async () => {
  const { reply, seen } = await call(sse([done([{ text: "ok" }])]));
  assert.equal(reply.text, "ok");
  const { url, init, body } = seen[0];
  assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/fixture-gemini:streamGenerateContent?alt=sse");
  assert.equal(init.headers["x-goog-api-key"], KEY);
  assert.equal(init.headers.Authorization, undefined);
  assert.ok(!url.includes(KEY) && !url.includes("key="), "the key never goes into the URL");
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "Jawab singkat." }] });
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: "Halo" }] }]);
  assert.equal(body.generationConfig.maxOutputTokens, 2048);
  assert.equal(body.generationConfig.temperature, undefined, "no universal temperature default");
  const decl = body.tools[0].functionDeclarations[0];
  assert.equal(decl.name, "read_file");
  assert.deepEqual(decl.parameters, { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] });
  assert.deepEqual(body.toolConfig, { functionCallingConfig: { mode: "AUTO" } });
});

test("a model name from models.list (models/...) is not doubled; unsafe names never reach fetch", async () => {
  const { seen } = await call(sse([done([{ text: "ok" }])]), { profile: { provider: "gemini", model: "models/fixture-gemini" } });
  assert.match(seen[0].url, /\/v1beta\/models\/fixture-gemini:streamGenerateContent\?alt=sse$/);
  for (const model of ["../fixture", "models/a?key=x", "fixture gemini", "", "tunedModels/x/y"]) {
    const { reply, seen: s } = await call(sse([done([{ text: "ok" }])]), { profile: { provider: "gemini", model } });
    assert.ok(reply instanceof Error, model);
    assert.equal(s.length, 0, "no fetch for " + model);
    assert.equal(reply.notSent, true);
  }
});

test("text across awkward byte splits is joined; thought parts are not shown as text", async () => {
  const frames = sse([
    piece([{ text: "rahasia pikiran", thought: true }]),
    piece([{ text: "Ibu kota " }]),
    piece([{ text: "Jakarta" }]),
    done([{ text: "." }]),
  ]);
  for (const sizes of [[1], [2, 5], [7, 1, 23, 3, 64], [100000]]) {
    const seenBodies = [];
    const reply = await invokeModel({
      profile: { provider: "gemini", model: "fixture-gemini" }, key: KEY, system: "", messages: [{ role: "user", content: "x" }], tools: [], signal,
      fetchImpl: async (url, init) => { seenBodies.push(JSON.parse(init.body)); return new Response(streamOf(frames, sizes), { status: 200 }); },
    });
    assert.equal(reply.text, "Ibu kota Jakarta.", "sizes " + sizes);
    assert.equal(reply.finishReason, "completed");
    assert.equal(seenBodies[0].tools, undefined, "no tools field without tools");
    assert.equal(seenBodies[0].systemInstruction, undefined, "no empty systemInstruction");
  }
});

test("function call round trip: calls out, native content kept, functionResponse back with the same id", async () => {
  const modelParts = [{ functionCall: { id: "fc-1", name: "read_file", args: { path: "a.txt" } }, thoughtSignature: "sig-A" }];
  const first = await call(sse([done(modelParts)]));
  assert.deepEqual(first.reply.calls, [{ id: "fc-1", name: "read_file", args: { path: "a.txt" } }]);
  assert.deepEqual(first.reply.message.native.gemini, { role: "model", parts: modelParts });
  const history = [
    { role: "user", content: "Halo" },
    first.reply.message,
    { role: "tool", callId: "fc-1", name: "read_file", content: "isi berkas" },
  ];
  const second = await call(sse([done([{ text: "Selesai" }])]), { messages: history });
  assert.equal(second.reply.text, "Selesai");
  const contents = second.seen[0].body.contents;
  assert.deepEqual(contents[1], { role: "model", parts: modelParts }, "model content resent unchanged (thoughtSignature kept)");
  assert.deepEqual(contents[2], { role: "user", parts: [{ functionResponse: { id: "fc-1", name: "read_file", response: { result: "isi berkas" } } }] });
});

test("calls without an id get a local id that is never sent back; parallel results share one user turn", async () => {
  const first = await call(sse([done([{ functionCall: { name: "read_file", args: { path: "a" } } }, { functionCall: { name: "read_file", args: { path: "b" } } }])]));
  const [a, b] = first.reply.calls;
  assert.ok(a.id && b.id && a.id !== b.id);
  const second = await call(sse([done([{ text: "ok" }])]), {
    messages: [{ role: "user", content: "Halo" }, first.reply.message, { role: "tool", callId: a.id, name: "read_file", content: "A" }, { role: "tool", callId: b.id, name: "read_file", content: "B", error: true }],
  });
  const turn = second.seen[0].body.contents[2];
  assert.deepEqual(turn, { role: "user", parts: [
    { functionResponse: { name: "read_file", response: { result: "A" } } },
    { functionResponse: { name: "read_file", response: { error: "B" } } },
  ] });
  assert.equal(second.seen[0].body.contents.length, 3);
});

test("usage: input = prompt - cached; output = candidates + thoughts; last frame wins, never summed", async () => {
  // https://ai.google.dev/api/generate-content#UsageMetadata (read 2026-10-28):
  //   promptTokenCount "this includes … tokens in the cached content."
  //   totalTokenCount "Total token count for the generation request (prompt + tool-use prompt +
  //   thoughts + response candidates)."
  // https://ai.google.dev/gemini-api/docs/generate-content/thinking#pricing (read 2026-10-28):
  //   "When thinking is turned on, response pricing is the sum of output tokens and thinking tokens."
  const u = (c) => ({ promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: c, thoughtsTokenCount: 30, totalTokenCount: 1030 + c });
  const { reply } = await call(sse([
    { ...piece([{ text: "a" }]), usageMetadata: u(10) },
    { ...done([{ text: "b" }]), usageMetadata: u(50) },
  ]));
  assert.deepEqual([reply.usage.input, reply.usage.cached, reply.usage.output, reply.usage.available], [400, 600, 80, true]);
});

test("usage: tool-use prompt tokens are charged as input (rate unverified: conservative); missing = unknown", async () => {
  const { reply } = await call(sse([{ ...done([{ text: "a" }]), usageMetadata: { promptTokenCount: 100, toolUsePromptTokenCount: 20, candidatesTokenCount: 5 } }]));
  assert.deepEqual([reply.usage.input, reply.usage.cached, reply.usage.output], [120, null, 5]);
  const none = await call(sse([done([{ text: "a" }])]));
  assert.equal(none.reply.usage.available, false);
  const bad = await call(sse([{ ...done([{ text: "a" }]), usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 1 } }]));
  assert.match(bad.reply.message, /usage counters/);
});

test("a stream that ends without finishReason is a cut: clear error, may be billed, no retry", async () => {
  const { reply, seen } = await call(sse([piece([{ text: "setengah" }])]));
  assert.equal(reply.code, "ERR_PROVIDER_STREAM_CUT");
  assert.match(reply.message, /No automatic retry/);
  assert.notEqual(reply.notSent, true);
  assert.equal(seen.length, 1);
});

test("an error frame inside the stream ends the call", async () => {
  const { reply } = await call(sse([piece([{ text: "a" }]), { error: { code: 500, status: "INTERNAL", message: "boom" } }]));
  assert.equal(reply.code, "ERR_PROVIDER_STREAM_ERROR");
  assert.match(reply.message, /No automatic retry/);
});

test("stops: MAX_TOKENS is incomplete, SAFETY and blocked prompts are refused", async () => {
  const max = await call(sse([{ candidates: [{ content: { role: "model", parts: [{ text: "pot" }] }, finishReason: "MAX_TOKENS" }] }]));
  assert.deepEqual([max.reply.finishReason, max.reply.stopDetail], ["incomplete", "max_tokens"]);
  const safety = await call(sse([{ candidates: [{ content: { role: "model", parts: [] }, finishReason: "SAFETY" }] }]));
  assert.equal(safety.reply.finishReason, "refused");
  const blocked = await call(sse([{ promptFeedback: { blockReason: "SAFETY" } }]));
  assert.equal(blocked.reply.finishReason, "refused");
  assert.deepEqual(blocked.reply.calls, []);
});

test("429 quota/credit is ERR_GEMINI_SALDO: one fetch, no retry, short owner message", async () => {
  const body = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } });
  const { reply, seen } = await call(body, {}, 429);
  assert.equal(reply.code, "ERR_GEMINI_SALDO");
  assert.equal(reply.status, 429);
  assert.match(reply.message, /^saldo Gemini habis/);
  assert.match(reply.message, /No automatic retry/);
  assert.equal(seen.length, 1);
  const credit = await call(JSON.stringify({ error: { code: 403, message: "Prepaid credit balance is depleted" } }), {}, 403);
  assert.equal(credit.reply.code, "ERR_GEMINI_SALDO");
  const rate = await call(JSON.stringify({ error: { code: 429, message: "Too many requests per minute" } }), {}, 429);
  assert.notEqual(rate.reply.code, "ERR_GEMINI_SALDO");
  assert.equal(rate.reply.status, 429);
  const bad = await call(JSON.stringify({ error: { code: 400, message: "Invalid argument" } }), {}, 400);
  assert.notEqual(bad.reply.code, "ERR_GEMINI_SALDO");
});

test("the key never leaks into errors, even when the provider echoes it", async () => {
  const echo = JSON.stringify({ error: { code: 400, message: `API key ${KEY} invalid; also ${ECHOED}` } });
  const { reply } = await call(echo, {}, 400);
  assert.ok(reply instanceof Error);
  assert.ok(!reply.message.includes(KEY));
  assert.ok(!reply.message.includes(ECHOED));
  assert.match(reply.message, /REDACTED/);
  const err = await invokeModel({ profile: { provider: "gemini", model: "fixture-gemini" }, key: KEY, system: "", messages: [{ role: "user", content: "x" }], tools: [], signal,
    fetchImpl: async () => { throw new TypeError("network down"); } }).catch((e) => e);
  assert.ok(!String(err.message).includes(KEY) && !String(err.stack).includes(KEY));
  const missing = await call(sse([done([{ text: "a" }])]), { key: "" });
  assert.equal(missing.seen.length, 0);
});
