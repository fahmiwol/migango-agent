// Risk-first class routing; keep side effects in the existing host.
import { classifyTask, resolveModel, ROUTES } from "./model-registry.mjs";
import { BUILTIN_AGENT } from "../agents/catalog.mjs";
const levels = ["low", "medium", "high"];
const roles = {
  conversation: "assistant",
  summary: "editor",
  research: "researcher",
  coding: "builder",
  debugging: "debugger",
  planning: "architect",
  creative: "writer",
  visual: "visual-reviewer",
  review: "reviewer",
};
const criticalPattern =
  /\b(keamanan|security|auth\w*|credential\w*|kredensial|secret\w*|pembayaran|payments?|produksi|production|migrasi|migrations?|hapus data|delete data|deploy\w*)\b/i;
export function analyseTask(prompt, override = "auto") {
  const classification = classifyTask(prompt, override);
  const critical = criticalPattern.test(prompt);
  const signals = [];
  let score = 0;
  if (
    ["coding", "debugging", "planning", "review"].includes(classification.route)
  ) {
    score += 2;
    signals.push("engineering");
  }
  if (
    /\b(multi[- ]?(file|repo|agent)|arsitektur|architecture|refaktor|refactor|lintas|end.to.end)\b/i.test(
      prompt,
    )
  ) {
    score += 2;
    signals.push("cross-component");
  }
  if (prompt.length > 1500) {
    score++;
    signals.push("long-task");
  }
  if (critical) signals.push("critical-risk");
  return {
    ...classification,
    critical,
    score,
    signals,
    level: critical || score >= 4 ? "high" : score >= 2 ? "medium" : "low",
  };
}
export function validatePolicy(policy, registry = []) {
  if (policy === undefined || policy === null) return null;
  if (
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.version !== 1 ||
    typeof policy.enabled !== "boolean"
  )
    throw Error("Invalid adaptive routing policy");
  for (const key of Object.keys(policy))
    if (!["version", "enabled", "models"].includes(key))
      throw Error("Invalid policy field");
  if (!policy.enabled) return { version: 1, enabled: false };
  if (
    !policy.models ||
    typeof policy.models !== "object" ||
    Array.isArray(policy.models) ||
    Object.keys(policy.models).length !== 3
  )
    throw Error("Invalid policy models");
  for (const level of levels) {
    const id = policy.models[level];
    if (
      typeof id !== "string" ||
      !registry.some((p) => p.id === id && p.enabled !== false)
    )
      throw Error("Unknown or disabled model in policy: " + level);
  }
  return {
    version: 1,
    enabled: true,
    models: Object.fromEntries(
      levels.map((level) => [level, policy.models[level]]),
    ),
  };
}
export function providerEffort(profile, level) {
  if (!levels.includes(level)) throw Error("Invalid effort level");
  if (profile.provider === "kimi" && profile.model === "kimi-k2.6")
    return {
      native: { thinking: { type: level === "low" ? "disabled" : "enabled" } },
      applied: true,
      note: "Kimi K2.6 has binary thinking; medium/high share enabled. Output caps remain host limits.",
    };
  if (
    profile.provider === "anthropic" &&
    ["claude-opus-5-5", "claude-sonnet-5-5"].includes(profile.model)
  )
    return {
      native: {
        thinking: { type: "adaptive" },
        output_config: { effort: level },
      },
      applied: true,
      note: "Anthropic native effort. Requested guidance is not a measured quality or cost guarantee.",
    };
  return {
    native: {},
    applied: false,
    note: "Native effort not verified for this model; host output cap only.",
  };
}
export function planTask({
  prompt,
  settings,
  registry = settings.modelRegistry || [],
  modelId,
  override = "auto",
  agents = [],
  suggestion,
}) {
  const policy = validatePolicy(settings.adaptiveRouting, registry);
  if (!policy?.enabled) return null;
  const analysis = analyseTask(prompt, override);
  let source = "rules";
  if (suggestion !== undefined) {
    if (
      !suggestion ||
      typeof suggestion !== "object" ||
      Array.isArray(suggestion) ||
      Object.keys(suggestion).some(
        (k) => !["route", "level", "confidence", "abstain"].includes(k),
      ) ||
      !Object.hasOwn(ROUTES, suggestion.route) ||
      !levels.includes(suggestion.level) ||
      !Number.isFinite(suggestion.confidence) ||
      suggestion.confidence < 0 ||
      suggestion.confidence > 1 ||
      typeof suggestion.abstain !== "boolean"
    )
      throw Error("Invalid model routing suggestion");
    if (!suggestion.abstain && suggestion.confidence >= 0.85) {
      if (override === "auto") analysis.route = suggestion.route;
      if (levels.indexOf(suggestion.level) > levels.indexOf(analysis.level))
        analysis.level = suggestion.level;
      source = "rules+validated-advice";
    }
  }
  const id = modelId || policy.models[analysis.level];
  const profile = resolveModel(
    {
      ...settings,
      modelRegistry: registry,
      routeMap: { ...settings.routeMap, [analysis.route]: id },
    },
    analysis.route,
  );
  // The caller supplies records from the validated AgentCatalog, never from the model response.
  const candidate = agents.find(
    (a) =>
      a.id !== "migan" &&
      a.rute?.includes(analysis.route) &&
      (!a.profilModel || a.profilModel === profile.id) &&
      (a.jenis !== "bayangan" || Date.parse(a.kedaluwarsa) > Date.now()),
  );
  const agent = candidate || structuredClone(BUILTIN_AGENT);
  return {
    ...analysis,
    source,
    profile,
    agent,
    role: roles[analysis.route],
    effort: {
      level: analysis.level,
      ...providerEffort(profile, analysis.level),
    },
    maxOutput: { low: 1024, medium: 2048, high: 4096 }[analysis.level],
    selectionReason: modelId
      ? "Explicit owner model override"
      : "Owner policy for " + analysis.level + " workload",
    costEstimate: null,
  };
}
