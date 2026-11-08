import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";

// The conversation is re-sent every turn. With one breakpoint on the prelude, 83% of the input
// tokens of the 26-27 Oct queue (54 runs) were billed uncached. A second, rolling breakpoint on
// the last block caches the whole conversation so far; Anthropic allows at most 4 breakpoints.
const signal = new AbortController().signal;
const prelude = "Project conventions…\n[project-files abc]\nATURAN\n[end project-files abc]\n";

async function send(messages) {
  let body;
  await invokeModel({
    profile: { provider: "anthropic", model: "fixture" },
    key: "k",
    system: "SYSTEM",
    messages,
    tools: [],
    signal,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    },
  });
  return body;
}
const marks = (body) => JSON.stringify(body).split("cache_control").length - 1;
const conversation = () => {
  const first = { role: "user", content: prelude + "Owner request:\nKerjakan.", cachePrefix: prelude };
  const native = [{ type: "text", text: "Saya baca." }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }];
  return [
    first,
    { role: "assistant", content: "", calls: [{ id: "t1", name: "read_file", args: { path: "a" } }], native: { anthropic: native } },
    { role: "tool", callId: "t1", name: "read_file", content: "isi berkas a" },
  ];
};

test("a multi-turn request marks the prelude and the last block of the last message", async () => {
  const body = await send(conversation());
  assert.equal(marks(body), 2, "prelude + rolling");
  assert.deepEqual(body.messages[0].content[0].cache_control, { type: "ephemeral" });
  const last = body.messages.at(-1).content.at(-1);
  assert.equal(last.type, "tool_result");
  assert.deepEqual(last.cache_control, { type: "ephemeral" });
  assert.equal(body.messages[1].content.some((b) => b.cache_control), false, "middle messages stay unmarked");
});

test("a plain string last message becomes one marked text block", async () => {
  const body = await send([{ role: "user", content: "Halo" }, { role: "assistant", content: "Hai" }, { role: "user", content: "Lanjut" }]);
  assert.deepEqual(body.messages.at(-1).content, [{ type: "text", text: "Lanjut", cache_control: { type: "ephemeral" } }]);
  assert.equal(marks(body), 1);
});

test("history objects are never mutated, so breakpoints do not pile up across turns", async () => {
  const messages = conversation();
  // The last message is a native block array taken straight from history: the mutation path.
  messages.push({ role: "assistant", content: "", native: { anthropic: [{ type: "text", text: "Selesai baca." }] } });
  const before = JSON.stringify(messages.map((m) => m.native));
  for (let turn = 0; turn < 5; turn++) assert.equal(marks(await send(messages)), 2, "turn " + turn);
  assert.equal(JSON.stringify(messages.map((m) => m.native)), before);
});

test("a thinking block is never marked; the breakpoint moves to the last markable block", async () => {
  const body = await send([
    { role: "user", content: "Halo" },
    { role: "assistant", content: "", native: { anthropic: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t", signature: "s" }] } },
  ]);
  const blocks = body.messages.at(-1).content;
  assert.equal(blocks[1].cache_control, undefined);
  assert.deepEqual(blocks[0].cache_control, { type: "ephemeral" });
});

test("a single first message keeps the existing contract (prelude only, or nothing)", async () => {
  assert.equal(marks(await send([{ role: "user", content: prelude + "x", cachePrefix: prelude }])), 1);
  assert.equal(marks(await send([{ role: "user", content: "Halo" }])), 0);
});
