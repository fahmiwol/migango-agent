// Gemini models.list (task 07c part 3). Shape from tmp-migan/riset-gemini/RINGKASAN-GEMINI-API.md
// section 6, https://ai.google.dev/api/models#method:-models.list (read 2026-10-28):
// GET v1beta/models?pageSize&pageToken -> { models[], nextPageToken }. Listing models does not call a
// model. The key goes only in the x-goog-api-key header, never in the URL. No model names are
// hard-coded: the owner picks one from what the API returns (decision ARS-07c-3, tmp-migan/catatan-07c3.md).
import { geminiModelId, redactGemini } from "./gemini.mjs";

export const GEMINI_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_PAGES = 5;
const MAX_MODELS = 200;
const TIMEOUT_MS = 15000;

const clean = (v, n) => (typeof v === "string" ? v.slice(0, n) : undefined);
const limit = (v) => (Number.isSafeInteger(v) && v > 0 ? v : undefined);

// Never throws: the Settings dialog shows `error` as text. No key = no request.
export async function listGeminiModels({ key, fetchImpl = fetch, signal } = {}) {
  const k = typeof key === "string" ? key.trim() : "";
  if (!k) return { models: [], error: null, reason: "no-key" };
  const models = new Map();
  let token = "";
  const seen = new Set();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url = new URL(GEMINI_MODELS_URL);
      url.searchParams.set("pageSize", "100");
      if (token) url.searchParams.set("pageToken", token);
      const res = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { "x-goog-api-key": k },
        signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        let detail = text;
        try {
          const e = JSON.parse(text).error;
          if (e) detail = [e.status, e.message].filter(Boolean).join(": ");
        } catch {
          // Body is not JSON; the raw text (redacted, trimmed) is the detail.
        }
        return { models: [], error: redactGemini(`Gemini models.list gagal (HTTP ${res.status}): ${String(detail).slice(0, 300)}`, k) };
      }
      let data;
      try {
        data = JSON.parse(text || "{}");
      } catch {
        return { models: [], error: "Gemini models.list: jawaban bukan JSON" };
      }
      for (const m of Array.isArray(data.models) ? data.models : []) {
        if (!m || typeof m.name !== "string") continue;
        const methods = Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [];
        if (!methods.includes("generateContent")) continue;
        try {
          geminiModelId(m.name);
        } catch {
          continue; // A name the adapter would refuse is not offered.
        }
        if (models.size < MAX_MODELS && !models.has(m.name))
          models.set(m.name, {
            name: m.name,
            displayName: clean(m.displayName, 100) || m.name,
            inputTokenLimit: limit(m.inputTokenLimit),
            outputTokenLimit: limit(m.outputTokenLimit),
          });
      }
      token = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
      if (!token || seen.has(token)) break;
      seen.add(token);
    }
  } catch (error) {
    return { models: [], error: redactGemini(`Gemini models.list gagal: ${error?.message || error}`, k).slice(0, 400) };
  }
  return { models: [...models.values()], error: null };
}

// Registry profile for a model picked in Settings; model keeps the exact API name.
export function geminiProfileFromModel(m) {
  const id = geminiModelId(m?.name);
  const profile = {
    id: ("gemini-" + id.replace(/[^a-zA-Z0-9_-]/g, "-")).slice(0, 60),
    label: String(m.displayName || id).slice(0, 100),
    provider: "gemini",
    model: m.name,
    credentialId: "gemini",
    capabilities: ["text", "tools", "code"],
    enabled: true,
    priority: 50,
  };
  if (limit(m.inputTokenLimit)) profile.contextWindowTokens = m.inputTokenLimit;
  return profile;
}
