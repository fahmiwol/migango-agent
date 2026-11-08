import { safeBrowserURL } from "../tools/workspace.mjs";
import { randomUUID } from "node:crypto";
import { providerEffort } from "./adaptive-routing.mjs";
const MAX_RESPONSE = 2 * 1024 * 1024;
import { UNSCOPED_KEY_STEPS, isUnscopedKeyError, validateWorkspaceId } from "./anthropic-workspace.mjs";
import { geminiRequest, readGeminiBody, parseGemini, geminiUsage, redactGemini, isGeminiSaldo, SYNTH as GEMINI_SYNTH } from "./gemini.mjs";
async function boundedJSON(response) {
  if (!response.body) throw new Error("Empty provider response");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE)
        throw new Error("Provider response exceeds limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
// Anthropic streaming (markas, 27 Oct 2026): the Messages SSE events are put back together into
// the same message object the non-streaming API returns, so parsing, native history and usage
// stay unchanged. Usage = message_start usage overwritten by every message_delta usage (final
// output tokens). A body that starts with "{" is plain JSON (older fixtures, proxies).
// A stream that ends before message_stop is a cut; it may have been billed and is never retried.
const streamTimeout = (ms) =>
  Object.assign(new Error(`anthropic stream idle (diam) for ${Math.round(ms / 1000)} s. No automatic retry.`), { code: "ERR_PROVIDER_TIMEOUT" });
async function readAnthropicBody(response, idleMs) {
  if (!response.body) throw new Error("Empty provider response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, buffer = "", kind = null, timer;
  const read = () =>
    Promise.race([
      reader.read(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(streamTimeout(idleMs)), idleMs))),
    ]).finally(() => clearTimeout(timer));
  let msg = null, done = false;
  const blocks = [], partial = [];
  const handle = (block) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (!data) return;
    const d = JSON.parse(data);
    if (d.type === "message_start") msg = { ...d.message, content: [], usage: { ...(d.message?.usage || {}) } };
    else if (d.type === "content_block_start") {
      blocks[d.index] = { ...d.content_block };
      if (d.content_block?.type === "tool_use") partial[d.index] = "";
    } else if (d.type === "content_block_delta") {
      const b = blocks[d.index], x = d.delta || {};
      if (!b) throw new Error("Invalid provider stream");
      if (x.type === "text_delta") b.text = (b.text || "") + x.text;
      else if (x.type === "input_json_delta") partial[d.index] += x.partial_json;
      else if (x.type === "thinking_delta") b.thinking = (b.thinking || "") + x.thinking;
      else if (x.type === "signature_delta") b.signature = (b.signature || "") + x.signature;
      else if (x.type === "citations_delta") (b.citations ||= []).push(x.citation);
    } else if (d.type === "content_block_stop") {
      const b = blocks[d.index];
      if (b?.type === "tool_use" && partial[d.index]) b.input = parseArgs(partial[d.index]);
    } else if (d.type === "message_delta") {
      if (!msg) throw new Error("Invalid provider stream");
      Object.assign(msg, d.delta || {});
      for (const [k, v] of Object.entries(d.usage || {})) if (v !== null && v !== undefined) msg.usage[k] = v;
    } else if (d.type === "message_stop") done = true;
    else if (d.type === "error")
      throw Object.assign(new Error(`anthropic stream error: ${d.error?.type || "error"}: ${String(d.error?.message || "").slice(0, 300)}. No automatic retry.`), { code: "ERR_PROVIDER_STREAM_ERROR" });
  };
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await read();
      } catch (error) {
        if (error?.name === "TimeoutError") throw Object.assign(new Error("anthropic timed out while streaming. No automatic retry."), { code: "ERR_PROVIDER_TIMEOUT" });
        throw error;
      }
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE) throw new Error("Provider response exceeds limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!kind) {
        const first = buffer.trimStart()[0];
        if (!first) continue;
        kind = first === "{" ? "json" : "sse";
      }
      if (kind === "sse") {
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop();
        for (const part of parts) handle(part);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  buffer += decoder.decode();
  if (kind === "json") return JSON.parse(buffer);
  if (buffer.trim()) handle(buffer);
  if (!done || !msg)
    throw Object.assign(new Error("anthropic stream cut before message_stop (terputus di tengah). No automatic retry."), { code: "ERR_PROVIDER_STREAM_CUT" });
  return { ...msg, content: blocks.filter(Boolean) };
}
// Tool-call batches (harness fix 3, markas 29 Oct 2026). A Kimi K3.1 Pro run died on turn 1 with
// "Invalid or excessive tool calls": the old check threw when a reply held more than 8 calls or ids
// that were not unique. Kimi batches many calls per reply and writes its own ids
// ("functions.read_file:0"), and OpenAI-compatible servers may omit them, so both shapes are normal
// model output. Now: a missing, blank, oversized or repeated id gets a generated one, written into
// the native message too, so the next request pairs every call with its result; at most 8 calls are
// returned to run and the rest come back as skippedCalls, which the runtime answers with a refusal
// the model can read; a reply with more than 64 calls is malformed and still refused.
export const MAX_TOOL_CALLS_PER_REPLY = 8;
export const MAX_TOOL_CALLS_PARSED = 64;
// Tool result for a call beyond the per-reply limit: nothing ran, and the model is told how to proceed.
export function skippedCallContent(position, total) {
  return JSON.stringify({
    error: `Not run: at most ${MAX_TOOL_CALLS_PER_REPLY} tool calls run per reply; this was call ${position} of ${total}. Call it again in your next reply if you still need it.`,
    code: "ERR_TOOL_CALL_LIMIT",
  });
}
function withStableCallIds(provider, calls, native) {
  const seen = new Set(),
    renamed = new Map();
  const fixed = calls.map((c, i) => {
    let id = c.id;
    if (typeof id !== "string" || !id.trim() || id.length > 256 || seen.has(id)) {
      // Gemini's synthetic prefix marks ids that are never sent back to Gemini (see gemini.mjs).
      id = (provider === "gemini" ? GEMINI_SYNTH : "call_") + randomUUID();
      renamed.set(i, id);
    }
    seen.add(id);
    return id === c.id ? c : { ...c, id };
  });
  if (!renamed.size) return { calls: fixed, native };
  // Rewrites the n-th call entry of a native list; entries that are not calls are kept as they are.
  const patch = (list, isCall, key) => {
    let n = -1;
    return (list || []).map((item) => (isCall(item) && renamed.has(++n) ? { ...item, [key]: renamed.get(n) } : item));
  };
  const out = { ...native };
  if (provider === "kimi" || provider === "runpod")
    out[provider] = { ...native[provider], tool_calls: patch(native[provider].tool_calls, () => true, "id") };
  else if (provider === "openai") out.openai = patch(native.openai, (i) => i?.type === "function_call", "call_id");
  else if (provider === "anthropic") out.anthropic = patch(native.anthropic, (b) => b?.type === "tool_use", "id");
  // Gemini resends its parts as they are and drops synthetic ids; Ollama ids are generated already.
  return { calls: fixed, native: out };
}
const parseArgs = (a) => {
  try {
    const o = typeof a === "string" ? JSON.parse(a) : a;
    if (!o || Array.isArray(o) || typeof o !== "object") throw Error();
    return o;
  } catch {
    throw new Error("Invalid tool arguments from model");
  }
};
// Per-request byte limits (harness fix 1, markas 29 Oct 2026). A profile without a declared context
// window keeps the old 8000-200000 range; a declared window may go higher, as far as it can hold at
// ~3 UTF-8 bytes per token after reserving output, but never above REQUEST_INPUT_CEILING (~1M tokens),
// so a hand-edited window or setting can never make a request unlimited.
export const LEGACY_INPUT_LIMIT_MAX = 200000;
export const REQUEST_INPUT_CEILING = 3_000_000;
export const BYTES_PER_TOKEN = 3;
// Bytes a declared window holds after reserving maxOutput, capped at the ceiling; null when undeclared.
export function windowInputLimit(contextWindowTokens, maxOutput) {
  if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) return null;
  return Math.min(REQUEST_INPUT_CEILING, Math.floor((contextWindowTokens - maxOutput) * BYTES_PER_TOKEN));
}
// Byte limit the adapter preflight enforces for one request. Exported so the runtime can compact
// history before this check rejects a request (markas, 25 Oct 2026, limited D-005 change).
// A cost cap per provider on top of the window (markas, 29 Oct 2026): one 600 KB request to Opus is
// hundreds of thousands of input tokens against a US$5 daily cap, so Anthropic keeps the old 200 KB
// until its cost is assessed, whatever the profile window or the mode setting allows.
export const PROVIDER_REQUEST_CAP = Object.freeze({ anthropic: LEGACY_INPUT_LIMIT_MAX });
// Ollama context window per request. 8192 rejected a search plus one small file read live on
// home server (6812 > 6656 bytes, 8 Nov 2026). 16384 tokens of KV for a 4B model is ~2.3 GB on the home server's
// 15.6 GB; prompt time on CPU depends on the tokens actually sent, not on this window.
export const OLLAMA_NUM_CTX = 16384;
export function adapterInputLimit(provider, maxOutput, callerInputLimit) {
  const limit =
    provider === "ollama"
      ? OLLAMA_NUM_CTX - maxOutput - 512
      : callerInputLimit !== undefined
        ? callerInputLimit
        : 48000;
  return Math.min(limit, PROVIDER_REQUEST_CAP[provider] ?? Infinity);
}
// Retry-After as delay-seconds or an HTTP date, in ms; undefined when absent or unreadable.
export function parseRetryAfter(value, now = Date.now()) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}
// RunPod serverless vLLM (OpenAI-compatible; belum diverifikasi live). The URL is built only from a
// strictly validated endpointId, never from a free baseURL, so the key cannot reach another host.
import { RUNPOD_ENDPOINT_ID } from "./runpod-endpoint.mjs";
export { RUNPOD_ENDPOINT_ID };
export function runpodChatURL(endpointId) {
  if (typeof endpointId !== "string" || !RUNPOD_ENDPOINT_ID.test(endpointId))
    throw new Error("Invalid RunPod endpointId: use 8-40 lowercase letters or digits from the RunPod console");
  return `https://api.runpod.ai/v2/${endpointId}/openai/v1/chat/completions`;
}
// Serverless cold starts can take minutes: runpod waits longer by default, owner-settable 30-1800 s.
// Requests are not streamed, so the whole reply must arrive in time: API providers wait 60 s plus
// 30 ms per allowed output token (90 s floor, 10 min cap). A flat 90 s cut long Opus turns.
export function providerTimeoutMs(profile, maxOutput, requestBytes = 0) {
  if (profile?.provider !== "runpod") {
    if (!Number.isSafeInteger(maxOutput) || maxOutput <= 0) return 90000;
    // Local Ollama on home server is CPU-only (4.5-8.5 tok/s, 8 Nov 2026): 200 ms per token, not 30.
    const local = profile?.provider === "ollama";
    const perToken = local ? 0.2 : 0.03;
    // BH-06: CPU prefill is slow too (qwen3.5:4b ~33 tok/s, 9B ~19 tok/s): 60 ms per prompt token,
    // tokens estimated as bytes/3 (upper bound). API providers prefill fast; unchanged.
    const prefill = local && Number.isFinite(requestBytes) && requestBytes > 0 ? Math.ceil((requestBytes / 3) * 0.06) : 0;
    return Math.min(600000, Math.max(90000, (60 + Math.ceil(maxOutput * perToken) + prefill) * 1000));
  }
  const s = profile.timeoutSeconds;
  if (s === undefined) return 300000;
  if (!Number.isSafeInteger(s) || s < 30 || s > 1800)
    throw new Error("Invalid timeoutSeconds: must be an integer 30-1800");
  return s * 1000;
}
// Errors raised before the request leaves the app (validation, missing key, aborted early) are
// marked notSent, so the cost meter releases them: nothing can have been billed (AYMAN H10).
export async function invokeModel(request) {
  const state = { sent: false };
  try {
    return await invokeProvider(request, state);
  } catch (error) {
    if (!state.sent && error && typeof error === "object") error.notSent = true;
    throw error;
  }
}
async function invokeProvider({
  profile,
  key,
  system,
  messages,
  tools,
  signal,
  fetchImpl = fetch,
  maxOutput = 2048,
  effort,
  // Optional per-call request byte limit for API providers (ARS-004 §11); default unchanged.
  inputLimit: callerInputLimit,
  // Anthropic streams: a silence longer than this between chunks ends the call as a timeout.
  streamIdleMs = 90000,
}, state) {
  const provider = profile.provider;
  let url,
    body,
    headers = { "Content-Type": "application/json" };
  if (provider !== "ollama" && !key)
    throw new Error("API key missing. Enter it in Settings.");
  if (provider === "openai") {
    url = "https://api.openai.com/v1/responses";
    headers.Authorization = "Bearer " + key;
    const input = messages.flatMap((m) =>
      m.role === "tool"
        ? [
            {
              type: "function_call_output",
              call_id: m.callId,
              output: m.content,
            },
          ]
        : m.native?.openai || [{ role: m.role, content: m.content }],
    );
    body = {
      model: profile.model,
      instructions: system,
      input,
      store: false,
      include: ["reasoning.encrypted_content"],
      max_output_tokens: maxOutput,
      tools: tools.map((t) => ({
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      })),
    };
  } else if (provider === "kimi" || provider === "runpod") {
    url = provider === "runpod" ? runpodChatURL(profile.endpointId) : "https://api.moonshot.ai/v1/chat/completions";
    headers.Authorization = "Bearer " + key;
    headers["User-Agent"] = "miganGO/0.1.0";
    body = {model:profile.model,max_tokens:maxOutput,stream:false,
      messages:[{role:"system",content:system},...messages.map(m =>
        m.native?.[provider] || (m.role === "tool" ? {role:"tool",tool_call_id:m.callId,content:m.content}
          : {role:m.role,content:m.content}))],
      ...(tools.length ? {tools:tools.map(t => ({type:"function",function:t}))} : {}),
    };
  } else if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    // Required for keys not scoped to a workspace (validated: it goes into a header).
    const workspaceId = validateWorkspaceId(profile.workspaceId);
    if (workspaceId) headers["anthropic-workspace-id"] = workspaceId;
    const converted = [];
    for (const m of messages) {
      if (m.role === "tool") {
        const content = {
          type: "tool_result",
          tool_use_id: m.callId,
          content: m.content,
          is_error: !!m.error,
        };
        if (
          converted.at(-1)?.role === "user" &&
          Array.isArray(converted.at(-1).content) &&
          converted.at(-1).content[0]?.type === "tool_result"
        )
          converted.at(-1).content.push(content);
        else converted.push({ role: "user", content: [content] });
      } else if (
        !m.native?.anthropic &&
        m.role === "user" &&
        typeof m.cachePrefix === "string" &&
        m.cachePrefix &&
        typeof m.content === "string" &&
        m.content.startsWith(m.cachePrefix) &&
        m.content.length > m.cachePrefix.length
      )
        // The only cache breakpoint: the stable project prelude that leads the first message.
        converted.push({
          role: m.role,
          content: [
            { type: "text", text: m.cachePrefix, cache_control: { type: "ephemeral" } },
            { type: "text", text: m.content.slice(m.cachePrefix.length) },
          ],
        });
      else
        converted.push({
          role: m.role,
          content: m.native?.anthropic || m.content,
        });
    }
    // Rolling breakpoint: the whole conversation is re-sent every turn, so the last markable block
    // of the last message is cached too (83% of the input was uncached with the prelude alone).
    // Copies only: history objects are reused next turn and must never collect breakpoints.
    if (converted.length > 1) {
      const last = converted.at(-1);
      const blocks = typeof last.content === "string" ? [{ type: "text", text: last.content }] : last.content.map((b) => ({ ...b }));
      const i = blocks.findLastIndex((b) => !["thinking", "redacted_thinking"].includes(b.type));
      if (i >= 0) {
        blocks[i].cache_control = { type: "ephemeral" };
        converted[converted.length - 1] = { ...last, content: blocks };
      }
    }
    body = {
      model: profile.model,
      system,
      messages: converted,
      max_tokens: maxOutput,
      stream: true,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      })),
    };
  } else if (provider === "ollama") {
    const base = new URL(safeBrowserURL(profile.baseURL));
    if (base.search || base.hash || base.pathname !== "/")
      throw new Error("Ollama endpoint must be an HTTP(S) origin");
    url = base.origin + "/api/chat";
    body = {
      model: profile.model,
      messages: [
        { role: "system", content: system },
        ...messages.map(
          (m) =>
            m.native?.ollama ||
            (m.role === "tool"
              ? { role: "tool", tool_name: m.name, content: m.content }
              : { role: m.role, content: m.content }),
        ),
      ],
      stream: false,
      // home server bench (8 Nov 2026): qwen3.5 thinks by default on Ollama, 2x slower on CPU and worse
      // on strict JSON; models without thinking accept false. 30m keeps the model warm between
      // daily tasks (2m reloaded it, 5-10 s plus the full prompt, before almost every task).
      think: false,
      keep_alive: "30m",
      options: { num_ctx: OLLAMA_NUM_CTX, num_predict: maxOutput },
      tools: tools.map((t) => ({ type: "function", function: t })),
    };
  } else if (provider === "gemini") {
    // Validates the model name before anything is sent; the key goes only into a header.
    ({ url, headers, body } = geminiRequest({ profile, key, system, messages, tools, maxOutput }));
  } else throw new Error("Unsupported provider");
  // Gemini thinking controls are not mapped yet (no verified fixture): effort is not sent to it.
  if (effort !== undefined && provider !== "gemini") Object.assign(body, providerEffort(profile, effort.level).native);
  // Anthropic binds a thinking block to the exact prefix it was produced under. discover_tools
  // grows the tools list and context compaction rewrites older turns, so the next turn was
  // rejected ("The `tools` list differs", "Content before this block was rewritten", 28 Oct).
  // Haiku returns thinking blocks without any thinking parameter, so this covers every model:
  // once history holds a thinking block, ask the API to drop a mismatched one (beta-gated).
  if (
    provider === "anthropic" &&
    body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking"))
  ) {
    body.thinking = { type: "adaptive", ...body.thinking, block_binding: { prefix_mismatch_behavior: "drop_block" } };
    headers["anthropic-beta"] = [headers["anthropic-beta"], "thinking-binding-controls-2026-08-01"].filter(Boolean).join(",");
  }
  const requestBytes = Buffer.byteLength(JSON.stringify(body));
  // Optional per-call limit for API providers: refused outside its range, never clamped, and refused
  // when it cannot fit a declared model context window (~3 UTF-8 bytes per token, plus output).
  // The range is 8000-200000 without a declared window, 8000-REQUEST_INPUT_CEILING with one.
  if (provider !== "ollama" && callerInputLimit !== undefined) {
    const window = profile.contextWindowTokens;
    const declared = Number.isSafeInteger(window) && window > 0;
    const max = declared ? REQUEST_INPUT_CEILING : LEGACY_INPUT_LIMIT_MAX;
    if (
      !Number.isSafeInteger(callerInputLimit) ||
      callerInputLimit < 8000 ||
      callerInputLimit > max
    )
      throw new Error(
        `Invalid inputLimit ${String(callerInputLimit).slice(0, 20)}: must be an integer 8000-${max} bytes`,
      );
    if (
      declared &&
      Math.ceil(callerInputLimit / BYTES_PER_TOKEN) + maxOutput > window
    )
      throw new Error(
        `inputLimit ${callerInputLimit} bytes plus ${maxOutput} output tokens exceeds the model context window (jendela konteks ${window} tokens)`,
      );
  }
  const inputLimit = adapterInputLimit(provider, maxOutput, callerInputLimit);
  if (requestBytes > inputLimit)
    throw new Error(
      `Context preflight rejected ${requestBytes} UTF-8 bytes (limit ${inputLimit}). This conservative byte upper bound reserves output and template overhead; narrow the task or retrieve a smaller excerpt.`,
    );
  const timeoutMs = providerTimeoutMs(profile, maxOutput, requestBytes);
  state.sent = true;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      redirect: "error",
    });
  } catch (error) {
    // A timed-out request may already be billed (state.sent stays true); never retried.
    if (error?.name === "TimeoutError")
      throw Object.assign(
        new Error(`${provider} timed out after ${timeoutMs / 1000} s${provider === "runpod" ? " (cold start can be slow; raise timeoutSeconds in Settings)" : ""}. No automatic retry.`),
        { code: "ERR_PROVIDER_TIMEOUT" },
      );
    throw error;
  }
  if (!response.ok) {
    let detail = "",
      errorType = "";
    // Read before the body: the runtime's retry wrapper honours it (capped there).
    const retryAfterMs = parseRetryAfter(response.headers?.get?.("retry-after"));
    try {
      const errorBody = await boundedJSON(response);
      detail = String(
        errorBody.error?.message ||
          (typeof errorBody.error === "string" ? errorBody.error : ""),
      );
      // Provider error type (e.g. Moonshot exceeded_current_quota_error) lets the retry skip quota errors.
      if (typeof errorBody.error?.type === "string") errorType = errorBody.error.type.slice(0, 80);
      detail = redactGemini(detail, key)
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
        .slice(0, 1000);
    } catch {}
    // Prepaid Gemini credit or quota exhausted: own code, short owner message, never retried.
    if (provider === "gemini" && isGeminiSaldo(response.status, detail))
      throw Object.assign(
        new Error(`saldo Gemini habis (HTTP ${response.status}). ${detail} No automatic retry.`),
        { code: "ERR_GEMINI_SALDO", status: response.status },
      );
    if (provider === "anthropic" && isUnscopedKeyError(response.status, detail))
      throw Object.assign(
        new Error(`anthropic HTTP 400: ${UNSCOPED_KEY_STEPS} ${detail} No automatic retry.`),
        { code: "ERR_ANTHROPIC_WORKSPACE", status: response.status },
      );
    // The status lets the cost meter release requests refused before processing (PRD-019).
    // "No automatic retry" is true of this single call; src/core/provider-retry.mjs may retry 429/5xx.
    throw Object.assign(
      new Error(
        `${provider} HTTP ${response.status}: ${response.status === 429 ? "quota or rate limit" : response.status === 401 || response.status === 403 ? "key or permission rejected" : response.status === 404 ? "model or endpoint unavailable" : provider === "runpod" && response.status >= 500 ? "worker unavailable or cold start failed; check the endpoint in the RunPod console" : "request failed"}. ${detail} No automatic retry.`,
      ),
      {
        status: response.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(errorType ? { providerErrorType: errorType } : {}),
      },
    );
  }
  const data =
    provider === "anthropic" ? await readAnthropicBody(response, streamIdleMs)
    : provider === "gemini" ? await readGeminiBody(response, streamIdleMs, key)
    : await boundedJSON(response);
  if (data.error)
    throw new Error("Provider returned an error; no automatic retry");
  if (
    data.model &&
    data.model !== profile.model &&
    !data.model.startsWith(profile.model + "-")
  )
    throw new Error(
      "Provider model identity mismatch: select the exact served model",
    );
  let text = "",
    calls = [],
    native = {},
    finishReason = "completed",
    // Why an incomplete reply stopped (ARS-004 §11); runtime continues only output-limit stops.
    stopDetail = null;
  if (provider === "openai") {
    const output = data.output || [];
    const content = output
      .filter((i) => i.type === "message")
      .flatMap((i) => i.content || []);
    text = content
      .filter((i) => i.type === "output_text")
      .map((i) => i.text)
      .join("\n");
    calls = output
      .filter((i) => i.type === "function_call")
      .map((i) => ({
        id: i.call_id,
        name: i.name,
        args: parseArgs(i.arguments),
      }));
    native.openai = output;
    if (content.some((i) => i.type === "refusal")) {
      finishReason = "refused";
      text = content
        .filter((i) => i.type === "refusal")
        .map((i) => i.refusal)
        .join("\n");
    } else if (data.status && data.status !== "completed") {
      finishReason = "incomplete";
      const reason = data.incomplete_details?.reason;
      stopDetail = typeof reason === "string" ? reason.slice(0, 40) : null;
    }
  } else if (provider === "kimi" || provider === "runpod") {
    const choice = data.choices?.[0];
    if (!choice?.message) throw Error(`Invalid ${provider === "kimi" ? "Kimi" : "RunPod"} response`);
    text = choice.message.content || "";
    calls = (choice.message.tool_calls || []).map(item => ({id:item.id,name:item.function.name,args:parseArgs(item.function.arguments)}));
    native[provider] = choice.message;
    if (choice.finish_reason === "length") { finishReason = "incomplete"; stopDetail = "length"; }
    else if (choice.finish_reason === "content_filter") finishReason = "refused";
    else if (!["stop","tool_calls"].includes(choice.finish_reason)) { finishReason = "incomplete"; stopDetail = "unknown"; }
  } else if (provider === "anthropic") {
    text = (data.content || [])
      .filter((i) => i.type === "text")
      .map((i) => i.text)
      .join("\n");
    calls = (data.content || [])
      .filter((i) => i.type === "tool_use")
      .map((i) => ({ id: i.id, name: i.name, args: parseArgs(i.input) }));
    native.anthropic = data.content || [];
    if (
      ["max_tokens", "model_context_window_exceeded", "pause_turn"].includes(
        data.stop_reason,
      )
    )
      finishReason = "incomplete";
    stopDetail =
      {
        max_tokens: "max_tokens",
        pause_turn: "pause_turn",
        model_context_window_exceeded: "context_window",
      }[data.stop_reason] ?? null;
    if (data.stop_reason === "refusal") finishReason = "refused";
  } else if (provider === "gemini") {
    ({ text, calls, native, finishReason, stopDetail } = parseGemini(data));
  } else {
    if (!data.message) throw new Error("Invalid Ollama response");
    text = data.message.content || "";
    calls = (data.message.tool_calls || []).map((i, n) => ({
      id: "ollama-" + randomUUID(),
      name: i.function.name,
      args: parseArgs(i.function.arguments),
    }));
    native.ollama = data.message;
    if (data.done === false || data.done_reason === "length")
      finishReason = "incomplete";
    if (data.done_reason === "length") stopDetail = "length";
  }
  if (calls.length > MAX_TOOL_CALLS_PARSED)
    throw new Error(
      `Invalid tool calls: ${calls.length} tool calls in one reply (more than ${MAX_TOOL_CALLS_PARSED}); nothing was run.`,
    );
  ({ calls, native } = withStableCallIds(provider, calls, native));
  const counts = {
    input: data.usage?.input_tokens ?? data.usage?.prompt_tokens ?? data.prompt_eval_count,
    output: data.usage?.output_tokens ?? data.usage?.completion_tokens ?? data.eval_count,
    cached:
      data.usage?.cache_read_input_tokens ??
      data.usage?.input_tokens_details?.cached_tokens ?? data.usage?.prompt_tokens_details?.cached_tokens,
    cacheCreated: data.usage?.cache_creation_input_tokens,
  };
  for (const value of Object.values(counts))
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    )
      throw new Error("Invalid provider usage counters");
  // OpenAI Responses: cached and written tokens are part of input_tokens (developers.openai.com
  // prompt-caching guide, read 27 Oct 2026), so ordinary input is the remainder. Kimi and other
  // chat-completions providers stay as reported until their semantics are checked.
  // Kimi chat completions follow the same rule: prompt_tokens is the total, and cached_tokens and
  // cache_write_tokens (prompt_tokens_details; cached_tokens may also sit at the top of usage) are
  // parts of it (platform.kimi.ai/docs/api/chat, read 27 Oct 2026). RunPod is not checked yet.
  const counter = (v) => {
    if (v !== undefined && (!Number.isSafeInteger(v) || v < 0))
      throw new Error("Invalid provider usage counters");
    return v;
  };
  // Gemini: promptTokenCount includes cached content; thoughts count as output (see gemini.mjs).
  if (provider === "gemini") Object.assign(counts, geminiUsage(data.usage), { cacheCreated: undefined });
  if (provider === "kimi" && counts.cached === undefined)
    counts.cached = counter(data.usage?.cached_tokens);
  if ((provider === "openai" || provider === "kimi") && counts.input !== undefined) {
    const written = counter(
      provider === "openai"
        ? data.usage?.input_tokens_details?.cache_write_tokens
        : data.usage?.prompt_tokens_details?.cache_write_tokens,
    );
    counts.input = Math.max(0, counts.input - (counts.cached ?? 0) - (written ?? 0));
    if (written !== undefined) counts.cacheCreated = written;
  }
  const usage = {
    input: counts.input ?? 0,
    output: counts.output ?? 0,
    // Not reported stays null so a missing counter is never shown as "cache unused".
    cached: counts.cached ?? null,
    cacheCreated: counts.cacheCreated ?? null,
    available: counts.input !== undefined && counts.output !== undefined,
  };
  if (finishReason === "completed" && !calls.length && !text.trim())
    finishReason = "empty";
  return {
    text,
    calls: calls.slice(0, MAX_TOOL_CALLS_PER_REPLY),
    // Not run; each must still get a tool result (the runtime sends a refusal the model can read).
    skippedCalls: calls.slice(MAX_TOOL_CALLS_PER_REPLY),
    usage,
    finishReason,
    stopDetail: finishReason === "incomplete" ? stopDetail : null,
    // History keeps every call, so the provider sees each one answered (run or refused).
    message: { role: "assistant", content: text, calls, native },
  };
}
