import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// Streaming for Anthropic (markas, 27 Oct 2026, backlog item 3): long replies no longer have to
// arrive inside one fixed wait, a cut stream is a clear non-retried error, and usage still comes
// from the final events (message_start + the last message_delta). Event shapes follow the
// Messages streaming docs: message_start, content_block_start/delta/stop, message_delta,
// message_stop, ping, error.
const signal = new AbortController().signal;
const sse = (events) => events.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`).join("");
// Split the stream at awkward places so the parser must handle partial lines and events.
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
async function call(body, opts = {}) {
  let sent;
  const reply = await invokeModel({
    profile: { provider: "anthropic", model: "claude-fixture" },
    key: "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "Halo" }],
    tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }],
    signal,
    ...opts,
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      return new Response(typeof body === "string" ? streamOf(body) : body, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  return { reply, sent };
}
const start = ["message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-fixture", content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } } }];

test("the request asks for a stream", async () => {
  const { sent } = await call(sse([start, ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "ok" } }], ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }], ["message_stop", {}]]));
  assert.equal(sent.stream, true);
});

test("text deltas are joined and usage comes from message_start + the last message_delta", async () => {
  const { reply } = await call(sse([
    start,
    ["ping", {}],
    ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Ibu kota " } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Jakarta" } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9 } }],
    ["message_stop", {}],
  ]));
  assert.equal(reply.text, "Ibu kota Jakarta");
  assert.deepEqual([reply.usage.input, reply.usage.output, reply.usage.cached, reply.usage.cacheCreated], [12, 9, 900, 40]);
  assert.equal(reply.finishReason, "completed");
});

test("a tool call is rebuilt from split input_json_delta pieces", async () => {
  const { reply } = await call(sse([
    start,
    ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "tu1", name: "read_file", input: {} } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"pa' } }],
    ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: 'th": "a.txt"}' } }],
    ["content_block_stop", { index: 0 }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
    ["message_stop", {}],
  ]));
  assert.deepEqual(reply.calls.map((c) => [c.id, c.name, c.args]), [["tu1", "read_file", { path: "a.txt" }]]);
});

test("thinking blocks keep text and signature in the native history shape", async () => {
  const { reply } = await call(sse([
    start,
    ["content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }],
    ["content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }],
    ["content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } }],
    ["content_block_stop", { index: 0 }],
    ["content_block_start", { index: 1, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { index: 1, delta: { type: "text_delta", text: "ya" } }],
    ["content_block_stop", { index: 1 }],
    ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }],
    ["message_stop", {}],
  ]));
  assert.deepEqual(reply.message.native.anthropic[0], { type: "thinking", thinking: "hmm", signature: "sig" });
  assert.deepEqual(reply.message.native.anthropic[1], { type: "text", text: "ya" });
});

test("a stream that ends before message_stop is a cut: clear error, may be billed, no retry", async () => {
  const err = await call(sse([start, ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "setengah" } }]])).catch((e) => e);
  assert.equal(err.code, "ERR_PROVIDER_STREAM_CUT");
  assert.match(err.message, /No automatic retry/);
  assert.notEqual(err.notSent, true, "a cut stream may have been billed");
});

test("an error event in the stream ends the call with the provider's error type", async () => {
  const err = await call(sse([start, ["error", { error: { type: "overloaded_error", message: "Overloaded" } }]])).catch((e) => e);
  assert.match(err.message, /overloaded_error/);
  assert.match(err.message, /No automatic retry/);
});

test("a stream silent longer than the idle limit is stopped as a timeout", async () => {
  let pulls = 0;
  const stuck = new ReadableStream({
    pull(c) {
      if (pulls++ === 0) c.enqueue(new TextEncoder().encode(sse([start])));
      return new Promise(() => {});
    },
  });
  const err = await call(stuck, { streamIdleMs: 50 }).catch((e) => e);
  assert.equal(err.code, "ERR_PROVIDER_TIMEOUT");
  assert.match(err.message, /idle|diam/i);
});

test("a plain JSON body (older fixtures, proxies) is still read", async () => {
  const body = JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 1 } });
  const { reply } = await call(body);
  assert.equal(reply.text, "ok");
});
