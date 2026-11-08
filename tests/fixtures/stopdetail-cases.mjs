// Shared provider stopDetail cases (ARS-004 §11), used by the unit test and by the mutation check.
const anthropic = (stop_reason) => ({
  content: [{ type: "text", text: "part" }],
  stop_reason,
  usage: { input_tokens: 1, output_tokens: 2 },
});
const openai = (status, incomplete_details) => ({
  status,
  ...(incomplete_details ? { incomplete_details } : {}),
  output: [{ type: "message", content: [{ type: "output_text", text: "part" }] }],
  usage: { input_tokens: 1, output_tokens: 2 },
});
const ollama = (extra) => ({
  message: { role: "assistant", content: "part" },
  prompt_eval_count: 1,
  eval_count: 2,
  ...extra,
});

export const CASES = [
  ["anthropic max_tokens", "anthropic", anthropic("max_tokens"), "incomplete", "max_tokens"],
  ["anthropic pause_turn", "anthropic", anthropic("pause_turn"), "incomplete", "pause_turn"],
  ["anthropic context window", "anthropic", anthropic("model_context_window_exceeded"), "incomplete", "context_window"],
  ["anthropic end_turn", "anthropic", anthropic("end_turn"), "completed", null],
  ["openai max_output_tokens", "openai", openai("incomplete", { reason: "max_output_tokens" }), "incomplete", "max_output_tokens"],
  ["openai incomplete without detail", "openai", openai("incomplete"), "incomplete", null],
  ["openai completed", "openai", openai("completed"), "completed", null],
  ["ollama length", "ollama", ollama({ done: true, done_reason: "length" }), "incomplete", "length"],
  ["ollama unfinished without reason", "ollama", ollama({ done: false }), "incomplete", null],
  ["ollama stop", "ollama", ollama({ done: true, done_reason: "stop" }), "completed", null],
].map(([name, provider, data, finishReason, stopDetail]) => ({ name, provider, data, finishReason, stopDetail }));

export async function runCase(invokeModel, c) {
  const reply = await invokeModel({
    profile: { provider: c.provider, model: "fixture", baseURL: "http://127.0.0.1:11434" },
    key: c.provider === "ollama" ? undefined : "fixture-only",
    system: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    signal: new AbortController().signal,
    fetchImpl: async () => new Response(JSON.stringify({ model: "fixture", ...c.data }), { status: 200 }),
  });
  return { finishReason: reply.finishReason, stopDetail: reply.stopDetail };
}
