// Full AgentRuntime seam with no network, keys or shell. Reusable acceptance fixtures.
import path from "node:path";
import { AgentRuntime } from "../../src/agents/runtime.mjs";
import { BUILTIN_AGENT } from "../../src/agents/catalog.mjs";
export const reply = (text = "ok", calls = [], extra = {}) => ({
  text,
  calls,
  finishReason: "completed",
  usage: { input: 2, output: 1, cached: 0, available: true },
  message: { role: "assistant", content: text, calls },
  ...extra,
});
export const agent = (id, over = {}) => ({
  ...structuredClone(BUILTIN_AGENT),
  id,
  nama: id,
  profilModel: "model-" + id,
  rute: ["coding"],
  izinTool: ["list_files", "read_file", "search_files"],
  ...over,
});
export function fixture({
  agents = [agent("koda"), agent("rupa"), agent("reviewer")],
  settings = {},
  provider = async () => reply(),
  gate,
  brain,
  context,
} = {}) {
  const runs = new Map(),
    events = [],
    seen = [],
    effects = [],
    approvalLog = [];
  let closed = 0;
  const store = {
    settings: {
      active: "ollama",
      profiles: { ollama: { model: "parent", baseURL: "http://127.0.0.1" } },
      routes: {},
      maxTurns: 12,
      internalMemory: false,
      memoryEnabled: false,
      autoRouting: false,
      modelRegistry: agents.map((a) => ({
        id: a.profilModel,
        provider: "ollama",
        model: "child-" + a.id,
        baseURL: "http://127.0.0.1",
        enabled: true,
        capabilities: ["text", "code", "tools"],
      })),
      ...settings,
    },
    keys: {},
    redact: (s) => s,
    saveRun: async (r) => runs.set(r.id, structuredClone(r)),
    loadRun: async (id) => structuredClone(runs.get(id)),
  };
  const catalog = {
    list: () => [structuredClone(BUILTIN_AGENT), ...structuredClone(agents)],
    get: (id) =>
      structuredClone(
        id === "migan" ? BUILTIN_AGENT : agents.find((a) => a.id === id),
      ),
  };
  const tools = {
    workspace: { root: path.resolve("team-fixture-workspace") },
    skills: { load: async () => null },
    context,
    mcp: { close: async () => closed++ },
    approvals: {
      request: async (name, args, signal, actor) => {
        approvalLog.push({ name, args, actor });
        return true;
      },
    },
    execute: async (call, signal, options) => {
      signal.throwIfAborted();
      effects.push({ call, options });
      return { ok: true, hash: "fixturehash", bytes: 2, tools: [] };
    },
  };
  const runtime = new AgentRuntime({
    store,
    tools,
    catalog,
    gate,
    brain,
    emit: (e) => events.push(structuredClone(e)),
    provider: async (req) => {
      seen.push({
        profile: structuredClone(req.profile),
        tools: req.tools.map((t) => t.name),
        messages: structuredClone(req.messages),
        maxOutput: req.maxOutput,
      });
      return provider(req);
    },
  });
  return {
    runtime,
    store,
    tools,
    catalog,
    runs,
    events,
    seen,
    effects,
    approvalLog,
    closed: () => closed,
    parent: () => [...runs.values()].find((r) => !r.parentRunId),
    children: () => [...runs.values()].filter((r) => r.parentRunId),
  };
}
export const single = { jalur: "panggil", agen: ["koda"] };
export const council = { jalur: "majelis", agen: ["koda", "rupa"] };
