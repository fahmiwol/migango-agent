// Gemini API adapter over REST (task 07c, markas 28 Oct 2026). No SDK: plain fetch, so tests can
// fake it and no dependency is installed. Every shape here comes from
// tmp-migan/riset-gemini/RINGKASAN-GEMINI-API.md (official docs, read 2026-10-28):
// https://ai.google.dev/api/generate-content and https://ai.google.dev/gemini-api/docs/api-key.
// Decisions and rejected alternatives: tmp-migan/catatan-07c.md (ARS-07c-1).
import { randomUUID } from "node:crypto";

const MAX_RESPONSE = 2 * 1024 * 1024;
const BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
// Model names come from models.list ("models/<id>") or the owner's registry; never guessed here.
const MODEL = /^(?:models\/)?([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
export const SYNTH = "gemini-synth-";

export function geminiModelId(model) {
  const m = typeof model === "string" ? MODEL.exec(model) : null;
  if (!m) throw new Error("Invalid Gemini model name: pick a model listed by the Gemini API");
  return m[1];
}

// Key goes only into the x-goog-api-key header, never into the URL (no ?key=).
export function geminiStreamURL(model) {
  return `${BASE}${geminiModelId(model)}:streamGenerateContent?alt=sse`;
}

// JSON Schema subset -> Gemini Schema (OpenAPI-style upper-case types). Fields the summary does
// not list (additionalProperties, $schema, ...) are dropped rather than forwarded.
export function geminiSchema(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  const out = {};
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== "null") : s.type;
  if (typeof type === "string") out.type = type.toUpperCase();
  if (Array.isArray(s.type) && s.type.includes("null")) out.nullable = true;
  if (typeof s.description === "string") out.description = s.description;
  if (Array.isArray(s.enum)) out.enum = s.enum.map(String);
  if (s.properties && typeof s.properties === "object")
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v) || {}]));
  if (Array.isArray(s.required) && s.required.length) out.required = s.required.filter((r) => typeof r === "string");
  if (s.items) out.items = geminiSchema(s.items);
  return out;
}

export function geminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    if (m.role === "tool") {
      const fr = { name: m.name, response: m.error ? { error: m.content } : { result: m.content } };
      // Synthetic ids were made locally for calls without an id; they are never sent back.
      if (typeof m.callId === "string" && m.callId && !m.callId.startsWith(SYNTH)) fr.id = m.callId;
      const last = contents.at(-1);
      if (last?.role === "user" && last.parts.length && last.parts.every((p) => p.functionResponse))
        last.parts.push({ functionResponse: fr });
      else contents.push({ role: "user", parts: [{ functionResponse: fr }] });
    } else if (m.role === "assistant")
      // Model content is resent unchanged so thoughtSignature parts survive the round trip.
      contents.push(m.native?.gemini || { role: "model", parts: [{ text: String(m.content ?? "") }] });
    else contents.push({ role: "user", parts: [{ text: String(m.content ?? "") }] });
  }
  return contents;
}

export function geminiRequest({ profile, key, system, messages, tools, maxOutput }) {
  const url = geminiStreamURL(profile.model);
  const headers = { "Content-Type": "application/json", "x-goog-api-key": key };
  // No temperature default: the summary notes newer models ask for it to be left out.
  const body = { contents: geminiContents(messages), generationConfig: { maxOutputTokens: maxOutput } };
  if (typeof system === "string" && system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools.length) {
    body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) })) }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  return { url, headers, body };
}

const REDACT = /AIza[0-9A-Za-z_-]{20,}/g;
export function redactGemini(text, key) {
  let s = String(text ?? "");
  if (key) s = s.split(key).join("[REDACTED]");
  return s.replace(REDACT, "[REDACTED]");
}

// Prepaid credit or quota exhausted (owner's account is prepaid, auto-reload off). The summary
// gives no exact billing error body, so: 429 + quota/billing/credit, or 400/403 + billing/credit.
// Known limit: a per-minute 429 whose text says "quota" lands here too (never retried either way).
export function isGeminiSaldo(status, detail) {
  const d = String(detail ?? "");
  if (status === 429) return /quota|billing|credit|prepa/i.test(d);
  if (status === 400 || status === 403) return /billing|credit|prepa/i.test(d);
  return false;
}

const timeoutError = (ms) =>
  Object.assign(new Error(`gemini stream idle (diam) for ${Math.round(ms / 1000)} s. No automatic retry.`), { code: "ERR_PROVIDER_TIMEOUT" });

// Reads an alt=sse stream (or a plain JSON body) into one candidate. Parts are merged across
// frames; usageMetadata is taken from the LAST frame that has it, never summed. The stream is
// complete only when a finishReason or promptFeedback.blockReason arrived; otherwise it is a cut
// that may already be billed and is never retried.
export async function readGeminiBody(response, idleMs, key) {
  if (!response.body) throw new Error("Empty provider response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, buffer = "", kind = null, timer;
  const read = () =>
    Promise.race([
      reader.read(),
      new Promise((_, reject) => (timer = setTimeout(() => reject(timeoutError(idleMs)), idleMs))),
    ]).finally(() => clearTimeout(timer));
  const parts = [];
  let finish = null, block = null, usage = null;
  const frame = (d) => {
    if (!d || typeof d !== "object") throw new Error("Invalid provider stream");
    if (d.error)
      throw Object.assign(
        new Error(`gemini stream error: ${redactGemini(d.error.status || d.error.code || "error", key)}: ${redactGemini(d.error.message, key).slice(0, 300)}. No automatic retry.`),
        { code: "ERR_PROVIDER_STREAM_ERROR" },
      );
    if (d.usageMetadata) usage = d.usageMetadata;
    if (d.promptFeedback?.blockReason) block = String(d.promptFeedback.blockReason).slice(0, 40);
    const c = d.candidates?.[0];
    if (!c) return;
    for (const p of c.content?.parts || []) {
      const last = parts.at(-1);
      const plain = typeof p.text === "string" && Object.keys(p).every((k) => k === "text" || k === "thought");
      if (plain && last && typeof last.text === "string" && !last.functionCall && !last.thoughtSignature && !!last.thought === !!p.thought)
        last.text += p.text;
      else parts.push({ ...p });
    }
    if (c.finishReason) finish = String(c.finishReason).slice(0, 40);
  };
  const handle = (chunk) => {
    const data = chunk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]") frame(JSON.parse(data));
  };
  try {
    for (;;) {
      let chunk;
      try {
        chunk = await read();
      } catch (error) {
        if (error?.name === "TimeoutError") throw Object.assign(new Error("gemini timed out while streaming. No automatic retry."), { code: "ERR_PROVIDER_TIMEOUT" });
        throw error;
      }
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > MAX_RESPONSE) throw new Error("Provider response exceeds limit");
      buffer += decoder.decode(chunk.value, { stream: true });
      if (!kind) {
        const first = buffer.trimStart()[0];
        if (!first) continue;
        kind = first === "{" || first === "[" ? "json" : "sse";
      }
      if (kind === "sse") {
        const pieces = buffer.split(/\r?\n\r?\n/);
        buffer = pieces.pop();
        for (const piece of pieces) handle(piece);
      }
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  buffer += decoder.decode();
  if (kind === "json") {
    const d = JSON.parse(buffer);
    for (const f of Array.isArray(d) ? d : [d]) frame(f);
  } else if (buffer.trim()) handle(buffer);
  if (!finish && !block)
    throw Object.assign(new Error("gemini stream cut before finishReason (terputus di tengah). No automatic retry."), { code: "ERR_PROVIDER_STREAM_CUT" });
  return { parts, finish, block, usage };
}

const REFUSED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);
const count = (v) => {
  if (v !== undefined && (!Number.isSafeInteger(v) || v < 0)) throw new Error("Invalid provider usage counters");
  return v;
};

// Token semantics (https://ai.google.dev/api/generate-content#UsageMetadata, read 2026-10-28):
// promptTokenCount includes cached content, so ordinary input = prompt - cached. Thinking tokens
// are billed as output (thinking docs, pricing). toolUsePromptTokenCount is added to input at the
// input rate: its exact rate is not verified, and counting it keeps the estimate from going low.
export function geminiUsage(meta) {
  const prompt = count(meta?.promptTokenCount);
  const cached = count(meta?.cachedContentTokenCount);
  const toolUse = count(meta?.toolUsePromptTokenCount);
  const candidates = count(meta?.candidatesTokenCount);
  const thoughts = count(meta?.thoughtsTokenCount);
  return {
    input: prompt === undefined ? undefined : Math.max(0, prompt - (cached ?? 0)) + (toolUse ?? 0),
    output: candidates === undefined && thoughts === undefined ? (prompt === undefined ? undefined : 0) : (candidates ?? 0) + (thoughts ?? 0),
    cached,
  };
}

export function parseGemini({ parts, finish, block }) {
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought && !p.functionCall).map((p) => p.text).join("");
  const calls = parts.filter((p) => p.functionCall).map((p) => {
    const fc = p.functionCall;
    const args = fc.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments from model");
    return { id: typeof fc.id === "string" && fc.id ? fc.id : SYNTH + randomUUID(), name: String(fc.name ?? ""), args };
  });
  let finishReason = "completed", stopDetail = null;
  if (block || REFUSED.has(finish)) finishReason = "refused";
  else if (finish === "MAX_TOKENS") { finishReason = "incomplete"; stopDetail = "max_tokens"; }
  else if (finish !== "STOP") { finishReason = "incomplete"; stopDetail = String(finish).toLowerCase(); }
  return { text, calls: block ? [] : calls, native: { gemini: { role: "model", parts } }, finishReason, stopDetail };
}
