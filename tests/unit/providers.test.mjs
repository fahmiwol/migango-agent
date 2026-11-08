import { test } from "node:test";
import assert from "node:assert/strict";
import { invokeModel } from "../../src/core/providers.mjs";
const tools = [
  {
    name: "read_file",
    description: "Read",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
];
const signal = new AbortController().signal;
test("HTTP400 detail is redacted before truncation so reflected keys cannot leak a cut prefix", async () => {
  const key = "fixture-private-key-123456789";
  let observed;
  try {
    await invokeModel({
      profile: { provider: "anthropic", model: "fixture" },
      key,
      system: "s",
      messages: [],
      tools: [],
      signal,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: { message: "x".repeat(990) + key } }),
          { status: 400 },
        ),
    });
  } catch (error) {
    observed = error.message;
  }
  assert.match(observed, /HTTP 400/);
  assert.equal(observed.includes("fixture-pr"), false);
  assert.match(observed, /No automatic retry/);
});
test("OpenAI preserves reasoning and function outputs over multiple steps; key is header only", async () => {
  let request;
  const native = [
    { type: "reasoning", id: "r1", summary: [] },
    {
      type: "function_call",
      call_id: "c1",
      name: "read_file",
      arguments: '{"path":"a.md"}',
    },
  ];
  const fetchImpl = async (url, opts) => {
    request = { url, opts, body: JSON.parse(opts.body) };
    return new Response(
      JSON.stringify({
        model: "test-model",
        output: native,
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
  };
  const profile = { provider: "openai", model: "test-model" };
  const result = await invokeModel({
    profile,
    key: "fixture-key",
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools,
    signal,
    fetchImpl,
  });
  assert.equal(result.calls[0].args.path, "a.md");
  assert.equal(request.opts.headers.Authorization, "Bearer fixture-key");
  assert.ok(!request.opts.body.includes("fixture-key"));
  await invokeModel({
    profile,
    key: "fixture-key",
    system: "sys",
    messages: [
      { role: "user", content: "hi" },
      result.message,
      { role: "tool", callId: "c1", name: "read_file", content: "{}" },
    ],
    tools,
    signal,
    fetchImpl,
  });
  assert.equal(request.body.input[1].type, "reasoning");
  assert.equal(request.body.input[3].type, "function_call_output");
  assert.equal(request.body.input[3].call_id, "c1");
});
test("Anthropic preserves thinking signatures and groups tool results before next answer", async () => {
  let body;
  const content = [
    { type: "thinking", thinking: "opaque", signature: "signature" },
    { type: "tool_use", id: "a", name: "read_file", input: { path: "a.md" } },
    { type: "tool_use", id: "b", name: "read_file", input: { path: "b.md" } },
  ];
  const fetchImpl = async (u, o) => {
    body = JSON.parse(o.body);
    return new Response(
      JSON.stringify({
        model: "model-a",
        content,
        usage: {
          input_tokens: 10,
          output_tokens: 3,
          cache_read_input_tokens: 4,
        },
      }),
    );
  };
  const base = {
    profile: { provider: "anthropic", model: "model-a" },
    key: "fixture-key",
    system: "sys",
    tools,
    signal,
    fetchImpl,
  };
  const r = await invokeModel({
    ...base,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.calls.length, 2);
  await invokeModel({
    ...base,
    messages: [
      { role: "user", content: "hi" },
      r.message,
      { role: "tool", callId: "a", content: "1" },
      { role: "tool", callId: "b", content: "2" },
    ],
  });
  assert.equal(body.system, "sys");
  assert.deepEqual(body.messages[1].content[0], content[0]);
  assert.equal(body.messages[2].content.length, 2);
  assert.equal(body.messages[2].content[1].tool_use_id, "b");
});
test("Ollama bounded CPU-friendly request, tool calls and model identity", async () => {
  let body;
  const fetchImpl = async (u, o) => {
    body = JSON.parse(o.body);
    return new Response(
      JSON.stringify({
        model: "local",
        message: { role: "assistant", content: "done" },
        prompt_eval_count: 7,
        eval_count: 2,
      }),
    );
  };
  const r = await invokeModel({
    profile: {
      provider: "ollama",
      model: "local",
      baseURL: "http://127.0.0.1:11434",
    },
    system: "sys",
    messages: [{ role: "user", content: "hi" }],
    tools,
    signal,
    fetchImpl,
  });
  assert.equal(r.text, "done");
  assert.equal(body.stream, false);
  assert.equal(body.options.num_ctx, 16384);
  // home server bench 8 Nov 2026: hybrid models (qwen3.5) think by default on Ollama — 2x slower on CPU
  // and worse on strict JSON. A daily desktop pauses > 2 min between tasks, so 2m reloaded the
  // model (5-10 s) plus the full prompt before almost every task.
  assert.equal(body.think, false);
  assert.equal(body.keep_alive, "30m");
  await assert.rejects(
    () =>
      invokeModel({
        profile: {
          provider: "ollama",
          model: "wrong",
          baseURL: "http://127.0.0.1:11434",
        },
        system: "sys",
        messages: [],
        tools,
        signal,
        fetchImpl,
      }),
    /model/i,
  );
});
test("missing key, malformed tool arguments, quota and oversized response fail closed", async () => {
  const base = {
    profile: { provider: "openai", model: "x" },
    system: "s",
    messages: [],
    tools,
    signal,
  };
  await assert.rejects(() => invokeModel(base), /key/i);
  await assert.rejects(
    () =>
      invokeModel({
        ...base,
        key: "fixture",
        fetchImpl: async () =>
          new Response("secret reflected", { status: 429 }),
      }),
    /429/,
  );
  await assert.rejects(
    () =>
      invokeModel({
        ...base,
        key: "fixture",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              output: [
                {
                  type: "function_call",
                  call_id: "x",
                  name: "read_file",
                  arguments: "bad",
                },
              ],
            }),
          ),
      }),
    /arguments/i,
  );
});
test("empty, refused and truncated model replies cannot masquerade as completed answers", async () => {
  const request = async (provider, data) =>
    invokeModel({
      profile: { provider, model: "x", baseURL: "http://127.0.0.1" },
      key: "fixture",
      system: "s",
      messages: [],
      tools,
      signal,
      fetchImpl: async () => new Response(JSON.stringify(data)),
    });
  assert.equal(
    (
      await request("openai", {
        status: "completed",
        output: [{ type: "reasoning", summary: [] }],
      })
    ).finishReason,
    "empty",
  );
  assert.equal(
    (
      await request("openai", {
        status: "incomplete",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "partial" }],
          },
        ],
      })
    ).finishReason,
    "incomplete",
  );
  assert.equal(
    (
      await request("openai", {
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "Cannot do that" }],
          },
        ],
      })
    ).finishReason,
    "refused",
  );
  assert.equal(
    (
      await request("anthropic", {
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "partial" }],
      })
    ).finishReason,
    "incomplete",
  );
  assert.equal(
    (
      await request("ollama", {
        done: true,
        done_reason: "length",
        message: { content: "partial" },
      })
    ).finishReason,
    "incomplete",
  );
});
test("invalid usage counters fail closed and missing usage is explicitly unknown", async () => {
  const request = (usage) =>
    invokeModel({
      profile: { provider: "anthropic", model: "x" },
      key: "fixture",
      system: "s",
      messages: [],
      tools,
      signal,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ content: [{ type: "text", text: "ok" }], usage }),
        ),
    });
  for (const value of [-1, "8", 1.5])
    await assert.rejects(
      () => request({ input_tokens: 2, output_tokens: value }),
      /usage/,
    );
  assert.equal((await request({})).usage.available, false);
  assert.equal((await request({ input_tokens: 2 })).usage.available, false);
  assert.deepEqual(
    (
      await request({
        input_tokens: 2,
        output_tokens: 3,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 5,
      })
    ).usage,
    { input: 2, output: 3, cached: 5, cacheCreated: 4, available: true },
  );
});
test("provider response cap is enforced before JSON parse", async () => {
  await assert.rejects(
    () =>
      invokeModel({
        profile: { provider: "openai", model: "x" },
        key: "fixture",
        system: "s",
        messages: [],
        tools,
        signal,
        fetchImpl: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      }),
    /limit/,
  );
});
