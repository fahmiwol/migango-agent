import { validateWorkspaceId } from "./anthropic-workspace.mjs";
// Same regex providers.mjs exports (leaf module avoids an import cycle via providers.mjs).
import { RUNPOD_ENDPOINT_ID } from "./runpod-endpoint.mjs";
import { geminiModelId } from "./gemini.mjs";
// RunPod-only fields: endpointId is required (the request URL is built from it), timeoutSeconds is
// optional 30-1800. Both are refused on any other provider instead of being silently dropped.
export function validateRunpodFields(p) {
  if (p.provider !== "runpod") {
    if (p.endpointId !== undefined)
      throw new Error("endpointId is only allowed for RunPod profiles");
    if (p.timeoutSeconds !== undefined)
      throw new Error("timeoutSeconds is only allowed for RunPod profiles");
    return {};
  }
  if (typeof p.endpointId !== "string" || !RUNPOD_ENDPOINT_ID.test(p.endpointId))
    throw new Error("RunPod needs an endpointId: 8-40 lowercase letters or digits from the RunPod console");
  const out = { endpointId: p.endpointId };
  if (p.timeoutSeconds !== undefined) {
    if (!Number.isSafeInteger(p.timeoutSeconds) || p.timeoutSeconds < 30 || p.timeoutSeconds > 1800)
      throw new Error("Invalid timeoutSeconds: must be an integer 30-1800");
    out.timeoutSeconds = p.timeoutSeconds;
  }
  return out;
}
export const ROUTES = Object.freeze({
  conversation: { label: "Percakapan", requires: ["text"] },
  summary: { label: "Ringkasan / ekstraksi", requires: ["text"] },
  research: { label: "Riset / pemahaman", requires: ["text", "tools"] },
  coding: {
    label: "Coding / implementasi",
    requires: ["text", "tools", "code"],
  },
  debugging: {
    label: "Debug / pengujian",
    requires: ["text", "tools", "code"],
  },
  planning: { label: "Rencana / arsitektur", requires: ["text"] },
  creative: { label: "Kreasi / generatif", requires: ["text"] },
  visual: { label: "Visual / multimodal", requires: ["vision"] },
  review: { label: "Review / validasi", requires: ["text", "code"] },
});
const rules = [
  ["visual", /\b(gambar|image|foto|visual|vision|video|3d|mesh)\b/i],
  [
    "debugging",
    /\b(debug\w*|bug|gagal|error|failing|broken|perbaiki|repair)\b/i,
  ],
  ["review", /\b(review|validasi|validator|audit|critique)\b/i],
  ["planning", /\b(architect\w*|arsitektur|rancang|rencana|plan\w*)\b/i],
  [
    "summary",
    /\b(ringkas\w*|summar\w*|ekstrak\w*|extract\w*|translate|terjemah\w*)\b/i,
  ],
  [
    "research",
    /\b(riset|research|telusuri|investigate|pahami|understand|repositori|sources|sumber)\b/i,
  ],
  [
    "coding",
    /\b(implement\w*|coding|ngoding|program\w*|aplikasi|kode|build|function|fitur|website|landing)\b/i,
  ],
  ["creative", /\b(kreatif|cerita|story|konten|content|copy|poster)\b/i],
];
export function classifyTask(prompt, override = "auto") {
  if (override && override !== "auto") {
    if (!ROUTES[override]) throw new Error("Unknown task route");
    return { route: override, reason: "Owner override", confidence: 1 };
  }
  for (const [route, rule] of rules) {
    const match = String(prompt).match(rule);
    if (match)
      return { route, reason: "Local rule: " + match[0], confidence: 0.8 };
  }
  return {
    route: "conversation",
    reason: "General conversation; no specialist rule matched",
    confidence: 0.5,
  };
}
export function resolveModel(
  settings,
  route,
  { visualAdapter = false, independentFrom } = {},
) {
  const contract = ROUTES[route];
  if (!contract) throw new Error("Unknown route");
  if (route === "visual" && !visualAdapter)
    throw new Error(
      "Visual route requires an image/multimodal adapter. This text alpha cannot claim that capability.",
    );
  const registry = settings.modelRegistry || [];
  const mapped = settings.routeMap?.[route];
  let profile;
  if (mapped) {
    profile = registry.find((p) => p.id === mapped);
    if (!profile)
      throw new Error("Configured model profile is missing: " + mapped);
    if (profile.enabled === false)
      throw new Error("Configured model profile is disabled: " + mapped);
  } else
    profile = registry
      .filter(
        (p) =>
          p.enabled !== false &&
          contract.requires.every((c) => p.capabilities?.includes(c)),
      )
      .sort(
        (a, b) =>
          (a.priority ?? 50) - (b.priority ?? 50) || a.id.localeCompare(b.id),
      )[0];
  if (!profile)
    throw new Error("No configured capable model profile for " + route);
  if (!contract.requires.every((c) => profile.capabilities?.includes(c)))
    throw new Error(
      "Model profile lacks required capabilities for " +
        route +
        ": " +
        contract.requires.join(", "),
    );
  if (independentFrom && profile.id === independentFrom)
    throw new Error("Independent review requires a different model profile");
  return {
    ...profile,
    route,
    selectionReason: mapped
      ? "Explicit route mapping"
      : "Configured capable profiles ordered by owner priority; quality and price are not inferred",
    verification: profile.verification || { status: "not-tested" },
  };
}
export function validateRegistry(input, previous = []) {
  if (!Array.isArray(input) || input.length > 40)
    throw new Error("Model registry must contain at most 40 profiles");
  const ids = new Set();
  return input.map((p) => {
    if (!/^[a-zA-Z0-9_-]{1,60}$/.test(p.id) || ids.has(p.id))
      throw new Error("Model IDs must be unique letters/numbers/hyphens");
    ids.add(p.id);
    if (
      !["openai", "anthropic", "kimi", "gemini", "ollama", "runpod"].includes(p.provider) ||
      typeof p.model !== "string" ||
      !p.model.trim() ||
      p.model.length > 160 ||
      !Array.isArray(p.capabilities) ||
      p.capabilities.some(
        (c) =>
          ![
            "text",
            "tools",
            "code",
            "vision",
            "image-generation",
            "json",
          ].includes(c),
      )
    )
      throw new Error("Invalid model profile");
    if (
      p.provider !== "ollama" &&
      !/^[a-zA-Z0-9_-]{1,60}$/.test(p.credentialId || "")
    )
      throw new Error("A model needs a credential ID");
    if (p.provider === "runpod" && p.credentialId !== "runpod")
      throw new Error("A RunPod profile must use the credential ID runpod");
    if (p.provider === "gemini") {
      // One Gemini key slot in Settings; the name must be one the adapter accepts (from models.list).
      if (p.credentialId !== "gemini")
        throw new Error("A Gemini profile must use the credential ID gemini");
      geminiModelId(p.model);
    }
    const runpod = validateRunpodFields(p);
    const hasContextWindow = p.contextWindowTokens !== undefined;
    if (
      hasContextWindow &&
      !(
        Number.isSafeInteger(p.contextWindowTokens) && p.contextWindowTokens > 0
      )
    )
      throw new Error(
        "contextWindowTokens must be a positive safe integer when provided",
      );
    const result = {
      id: p.id,
      label: String(p.label || p.id).slice(0, 100),
      provider: p.provider,
      model: p.model.trim(),
      credentialId: p.provider === "ollama" ? null : p.credentialId,
      baseURL:
        p.provider === "ollama"
          ? String(p.baseURL || "").slice(0, 300)
          : undefined,
      capabilities: [...new Set(p.capabilities)],
      enabled: p.enabled !== false,
      priority: Math.max(0, Math.min(100, Number(p.priority) || 50)),
    };
    if (hasContextWindow) result.contextWindowTokens = p.contextWindowTokens;
    if (p.provider === "anthropic") {
      const workspaceId = validateWorkspaceId(p.workspaceId);
      if (workspaceId) result.workspaceId = workspaceId;
    }
    Object.assign(result, runpod);
    const old = previous.find((o) => o.id === p.id);
    if (
      old &&
      old.provider === result.provider &&
      old.model === result.model &&
      old.baseURL === result.baseURL &&
      old.credentialId === result.credentialId &&
      old.workspaceId === result.workspaceId &&
      old.endpointId === result.endpointId &&
      old.timeoutSeconds === result.timeoutSeconds
    )
      result.verification = old.verification;
    return result;
  });
}
