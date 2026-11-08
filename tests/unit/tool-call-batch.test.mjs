// Harness fix 3 (markas, 29 Oct 2026): "Invalid or excessive tool calls" ended a Kimi K3.1 Pro run on
// turn 1. invokeModel threw on any reply with more than 8 tool calls or with ids that were not unique
// (missing ids all count as one undefined id). Kimi batches several calls in one reply and its ids are
// model-written ("functions.read_file:0"), so both shapes are legitimate model output, not attacks.
// New behaviour: missing or duplicate ids get a generated id, written into the native message too so
// the tool results still match; calls beyond 8 are not run and get a model-visible refusal result;
// a reply with more than 64 calls is still refused. Fake fetch only; no paid API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";
import { AgentRuntime } from "../../src/agents/runtime.mjs";

const MODEL = "fixture-kimi";
const signal = new AbortController().signal;
const toolCall = (id, n) => ({
  ...(id === undefined ? {} : { id }),
  type: "function",
  function: { name: "read_file", arguments: JSON.stringify({ path: `f${n}.txt` }) },
});
const kimiReply = (toolCalls, content = "") =>
  new Response(
    JSON.stringify({
      model: MODEL,
      choices: [{ message: { role: "assistant", content, tool_calls: toolCalls }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200 },
  );
const kimiText = (text) =>
  new Response(
    JSON.stringify({ model: MODEL, choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    { status: 200 },
  );
const kimi = (response, messages = [{ role: "user", content: "baca" }], seen = []) =>
  invokeModel({
    profile: { provider: "kimi", model: MODEL },
    key: "fixture-only",
    system: "s",
    messages,
    tools: [{ name: "read_file", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
    signal,
    fetchImpl: async (url, init) => (seen.push(JSON.parse(init.body)), response()),
  });
const uniqueIds = (calls) => new Set(calls.map((c) => c.id)).size === calls.length && calls.every((c) => typeof c.id === "string" && c.id);

test("duplicate ids (Kimi reusing functions.read_file:0) get stable unique ids instead of a crash", async () => {
  const reply = await kimi(() => kimiReply([toolCall("functions.read_file:0", 1), toolCall("functions.read_file:0", 2), toolCall("functions.read_file:1", 3)]));
  assert.equal(reply.calls.length, 3);
  assert.ok(uniqueIds(reply.calls), JSON.stringify(reply.calls));
  assert.equal(reply.calls[0].id, "functions.read_file:0", "the first keeps its own id");
  assert.equal(reply.calls[2].id, "functions.read_file:1");
  // The native message replayed next turn carries exactly the ids the tool results will use.
  assert.deepEqual(reply.message.native.kimi.tool_calls.map((t) => t.id), reply.calls.map((c) => c.id));
});

test("missing and empty ids are generated", async () => {
  const reply = await kimi(() => kimiReply([toolCall(undefined, 1), toolCall("", 2), toolCall("  ", 3)]));
  assert.equal(reply.calls.length, 3);
  assert.ok(uniqueIds(reply.calls), JSON.stringify(reply.calls));
  assert.deepEqual(reply.message.native.kimi.tool_calls.map((t) => t.id), reply.calls.map((c) => c.id));
});

test("generated ids round-trip: the next request pairs every tool_call with its tool result", async () => {
  const first = await kimi(() => kimiReply([toolCall(undefined, 1), toolCall(undefined, 2)]));
  const seen = [];
  await kimi(
    () => kimiText("selesai"),
    [{ role: "user", content: "baca" }, first.message, ...first.calls.map((c) => ({ role: "tool", callId: c.id, name: c.name, content: "isi" }))],
    seen,
  );
  const sent = seen[0].messages;
  const asked = sent.find((m) => m.role === "assistant").tool_calls.map((t) => t.id);
  const answered = sent.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(answered, asked);
});

test("more than 8 calls: the first 8 are returned to run, the rest are returned as skipped, nothing throws", async () => {
  const twelve = Array.from({ length: 12 }, (_, n) => toolCall(`functions.read_file:${n}`, n));
  const reply = await kimi(() => kimiReply(twelve));
  assert.equal(reply.calls.length, 8);
  assert.equal(reply.skippedCalls.length, 4);
  assert.deepEqual(reply.skippedCalls.map((c) => c.id), ["functions.read_file:8", "functions.read_file:9", "functions.read_file:10", "functions.read_file:11"]);
  // History keeps all 12, so every call can be answered (run or refused).
  assert.equal(reply.message.calls.length, 12);
  assert.equal(reply.message.native.kimi.tool_calls.length, 12);
});

test("an absurd batch (more than 64 calls) is still refused with a clear error", async () => {
  const many = Array.from({ length: 65 }, (_, n) => toolCall(`c${n}`, n));
  await assert.rejects(() => kimi(() => kimiReply(many)), /65 tool calls in one reply/);
});

test("Anthropic duplicate tool_use ids are normalised in the native blocks too", async () => {
  const reply = await invokeModel({
    profile: { provider: "anthropic", model: "fixture" },
    key: "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "baca" }],
    tools: [],
    signal,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          model: "fixture",
          content: [
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a" } },
            { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "b" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
      ),
  });
  assert.ok(uniqueIds(reply.calls));
  assert.deepEqual(reply.message.native.anthropic.map((b) => b.id), reply.calls.map((c) => c.id));
});

test("runtime: a Kimi reply with 10 calls and duplicate ids runs 8, refuses 2 to the model, and continues", async () => {
  const seen = [];
  const executed = [];
  const runs = [];
  const ten = Array.from({ length: 10 }, (_, n) => toolCall(n < 2 ? "functions.read_file:0" : `functions.read_file:${n}`, n));
  const replies = [() => kimiReply(ten), () => kimiText("Selesai membaca.")];
  const store = {
    settings: { active: "kimi", profiles: { kimi: { model: MODEL, contextWindowTokens: 262144 } }, routes: {}, maxTurns: 4, internalMemory: false },
    keys: { kimi: "fixture-only" },
    redact: (s) => s,
    saveRun: async (run) => runs.push(structuredClone(run)),
  };
  const tools = {
    workspace: { root: "test" },
    execute: async (call) => (executed.push(call.id), { content: "isi " + call.args.path }),
    mcp: { close: async () => {} },
  };
  const runtime = new AgentRuntime({
    store,
    tools,
    emit: () => {},
    provider: (req) => invokeModel({ ...req, fetchImpl: async (url, init) => (seen.push(JSON.parse(init.body)), replies[seen.length - 1]()) }),
  });
  const result = await runtime.start({ prompt: "baca semua berkas", mode: "ask" });
  assert.notEqual(result.status, "failed", runs.at(-1)?.error);
  assert.equal(executed.length, 8, "at most 8 calls run per reply");
  assert.equal(new Set(executed).size, 8);
  assert.equal(seen.length, 2);
  const sent = seen[1].messages;
  const asked = sent.find((m) => m.role === "assistant" && m.tool_calls).tool_calls.map((t) => t.id);
  const answered = sent.filter((m) => m.role === "tool");
  assert.equal(asked.length, 10);
  assert.deepEqual(answered.map((m) => m.tool_call_id), asked, "every call is answered, in order");
  const refused = answered.filter((m) => /ERR_TOOL_CALL_LIMIT/.test(m.content));
  assert.equal(refused.length, 2);
  assert.match(refused[0].content, /not run/i);
});
