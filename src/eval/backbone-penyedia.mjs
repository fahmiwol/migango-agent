// Adaptor benchmark backbone -> invokeModel (src/core/providers.mjs). Satu antarmuka untuk
// Ollama, Anthropic, OpenAI dan Kimi: benchmark tidak tahu penyedia mana yang dipakai.
// Kunci tidak dibaca di sini; pemanggil memberikannya (atau tidak, untuk Ollama).
import { invokeModel } from "../core/providers.mjs";

export const PENYEDIA = Object.freeze(["ollama", "anthropic", "openai", "kimi"]);

export function profilBenchmark(penyedia, model, baseURL = "http://127.0.0.1:11434") {
  if (!PENYEDIA.includes(penyedia)) throw new Error("penyedia tidak didukung benchmark: " + penyedia);
  if (typeof model !== "string" || !model.trim()) throw new Error("model wajib diisi");
  return penyedia === "ollama" ? { provider: penyedia, model, baseURL } : { provider: penyedia, model };
}

export function buatPanggil({ profile, key, fetchImpl, signal } = {}) {
  // Pesan asisten asli disimpan per id panggilan alat, supaya giliran berikutnya dikirim dalam
  // bentuk asli penyedia (tool_use/function_call) dan id-nya cocok.
  const asli = new Map();
  return async function panggil({ system, messages, tools = [], maxTokens = 512 }) {
    const pesan = messages.map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        const native = asli.get(m.toolCalls[0].id);
        return { role: "assistant", content: m.content || "", calls: m.toolCalls, native };
      }
      if (m.role === "tool") return { role: "tool", callId: m.callId, name: m.name, content: String(m.content) };
      return { role: m.role, content: String(m.content) };
    });
    const r = await invokeModel({
      profile, key, system, messages: pesan, tools,
      signal: signal || new AbortController().signal,
      maxOutput: maxTokens,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    for (const c of r.calls) asli.set(c.id, r.message.native);
    return { text: r.text, calls: r.calls, usage: { input: r.usage.input, output: r.usage.output }, finishReason: r.finishReason };
  };
}
