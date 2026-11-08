import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// Thinking-block binding (28 Oct 2026). Anthropic binds a thinking block to the exact prefix it
// was produced under. discover_tools grows the tools list and context compaction rewrites older
// turns, so every work-mode task failed on the next turn: "The `tools` list differs from the one
// this block was created with" and "Content before this block was rewritten". Haiku produced
// thinking blocks without any thinking parameter, so the fix sits in the provider layer for every
// Anthropic model: once history holds a thinking block, the request carries the binding-controls
// beta and asks the API to drop a mismatched block instead of failing.
const signal = new AbortController().signal;
const BETA = "thinking-binding-controls-2026-08-01";
const ok = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n' +
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const withThinking = [
  { role: "user", content: "Halo" },
  { role: "assistant", content: "", native: { anthropic: [{ type: "thinking", thinking: "rencana", signature: "sig" }, { type: "tool_use", id: "t1", name: "read_file", input: {} }] } },
  { role: "tool", callId: "t1", name: "read_file", content: "{}" },
];
async function send({ model = "claude-haiku-5-5", messages, effort } = {}) {
  let sent, headers;
  await invokeModel({
    profile: { provider: "anthropic", model },
    key: "fixture-only",
    system: "s",
    messages,
    tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }],
    signal,
    ...(effort ? { effort } : {}),
    fetchImpl: async (url, init) => {
      sent = JSON.parse(init.body);
      headers = init.headers;
      return new Response(ok, { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  });
  return { sent, headers };
}

test("history with a thinking block: drop_block binding and the beta header (no effort, e.g. Haiku)", async () => {
  const { sent, headers } = await send({ messages: withThinking });
  assert.deepEqual(sent.thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
  assert.equal(sent.thinking.type, "adaptive");
  assert.ok(String(headers["anthropic-beta"] || "").split(",").map((s) => s.trim()).includes(BETA));
});

test("effort thinking keeps its own settings and gains the binding", async () => {
  const { sent } = await send({ model: "claude-opus-5-5", messages: withThinking, effort: { level: "high" } });
  assert.equal(sent.thinking.type, "adaptive");
  assert.equal(sent.output_config.effort, "high");
  assert.deepEqual(sent.thinking.block_binding, { prefix_mismatch_behavior: "drop_block" });
});

test("first turn (no thinking block in history) is sent unchanged: no binding, no beta header", async () => {
  const { sent, headers } = await send({ messages: [{ role: "user", content: "Halo" }] });
  assert.equal(sent.thinking, undefined);
  assert.equal(headers["anthropic-beta"], undefined);
});
