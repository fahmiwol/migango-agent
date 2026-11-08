// Core-task set for miganGO (ARS-009): fixed cases from daily work, deterministic graders (no model
// judge), a harness that runs one case through the real runtime and tools in a throwaway
// workspace, and the markas threshold for "own model is enough" (26 Oct 2026): pass rate >= 90%
// of the BYOK baseline and p95 latency <= 2x the baseline. Below it, results are shown as they are.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AgentRuntime } from "../agents/runtime.mjs";
import { BUILTIN_AGENT } from "../agents/catalog.mjs";
import { Tools } from "../tools/registry.mjs";
import { Workspace } from "../tools/workspace.mjs";

const SET = path.resolve(import.meta.dirname, "../../evals/tugas-inti/v1.json");
export const THRESHOLD = Object.freeze({ passRatio: 0.9, p95Ratio: 2 });

export async function loadCases(file = SET) {
  const set = JSON.parse(await fs.readFile(file, "utf8"));
  if (set?.v !== 1 || !Array.isArray(set.kasus)) throw new Error("Set uji tidak sah");
  return set;
}

const words = (text) => String(text).trim().split(/\s+/).filter(Boolean).length;

/** Deterministic grade of one outcome: { pass, reasons[] } with one reason per failed rule. */
export function grade(c, outcome) {
  const n = c.nilai || {};
  const reasons = [];
  const final = String(outcome.final || "");
  const called = new Set((outcome.calls || []).map((x) => x.name));
  if (["failed", "cancelled"].includes(outcome.status)) reasons.push("tugas gagal");
  for (const t of n.jawabanMemuat || []) if (!final.toLowerCase().includes(t.toLowerCase())) reasons.push("jawaban tidak memuat: " + t);
  for (const t of n.wajibMemanggil || []) if (!called.has(t)) reasons.push("tidak memanggil: " + t);
  if (n.wajibSalahSatu && !n.wajibSalahSatu.some((t) => called.has(t))) reasons.push("tidak memanggil salah satu: " + n.wajibSalahSatu.join(", "));
  for (const t of n.dilarangMemanggil || []) if (called.has(t)) reasons.push("memanggil alat terlarang: " + t);
  if (n.maksKata !== undefined && words(final) > n.maksKata) reasons.push(`jawaban lebih dari ${n.maksKata} kata`);
  for (const [rel, expected] of Object.entries(n.berkasSama || {}))
    if ((outcome.files || {})[rel] !== expected) reasons.push("berkas berbeda: " + rel);
  for (const rel of n.berkasTidakAda || []) if ((outcome.files || {})[rel] !== undefined) reasons.push("berkas ada: " + rel);
  return { pass: reasons.length === 0, reasons };
}

async function snapshot(root, dir = root, out = {}) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await snapshot(root, p, out);
    else if (e.isFile()) out[path.relative(root, p).split(path.sep).join("/")] = await fs.readFile(p, "utf8");
  }
  return out;
}

/**
 * Runs one case in a throwaway workspace through AgentRuntime + Tools. `provider` is the model
 * call (a real adapter for measurement, a script in tests); `settings` overrides the profile.
 * File writes are approved only because the workspace is a temporary folder removed afterwards.
 */
export async function runCase(c, { provider, settings = {}, now = () => performance.now() } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-tugas-inti-"));
  try {
    for (const [rel, text] of Object.entries(c.berkas)) {
      await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await fs.writeFile(path.join(root, rel), text);
    }
    const runs = new Map();
    const store = {
      settings: {
        active: "ollama",
        profiles: { ollama: { model: "tugas-inti", baseURL: "http://127.0.0.1" } },
        routes: {},
        maxTurns: 8,
        internalMemory: true,
        memoryEnabled: false,
        autoRouting: false,
        modelRegistry: [],
        skillRouter: false,
        ...settings,
      },
      keys: {},
      redact: (s) => s,
      saveRun: async (r) => runs.set(r.id, structuredClone(r)),
      loadRun: async (id) => structuredClone(runs.get(id)),
    };
    const calls = [];
    const tools = new Tools({
      workspace: new Workspace(root),
      approvals: { request: async () => true },
      mcp: { close: async () => {} },
      store,
    });
    const execute = tools.execute.bind(tools);
    tools.execute = async (call, signal, options) => {
      calls.push({ name: call.name, args: call.args });
      return execute(call, signal, options);
    };
    const catalog = { list: () => [structuredClone(BUILTIN_AGENT)], get: () => structuredClone(BUILTIN_AGENT) };
    const runtime = new AgentRuntime({ store, tools, catalog, emit: () => {}, provider });
    const started = now();
    await runtime.start({ prompt: c.prompt, mode: c.mode, delegation: { jalur: "sendiri", agen: [] } });
    const latencyMs = Math.round(now() - started);
    const run = [...runs.values()].find((r) => !r.parentRunId) || {};
    const outcome = { status: run.status, final: run.final, calls, files: await snapshot(root), latencyMs, usage: run.usage };
    return { id: c.id, ...outcome, result: grade(c, outcome), workspace: root };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** Nearest-rank p95 of latencies in milliseconds; null for an empty list. */
export function p95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1];
}

const summary = (results) => ({
  kasus: results.length,
  lulus: results.filter((r) => r.pass ?? r.result?.pass).length,
  p95Ms: p95(results.map((r) => r.latencyMs).filter(Number.isFinite)),
});

/** { cukup: true|false|null, alasan, kandidat, baseline }; null when there is no baseline. */
export function verdict({ candidate, baseline }) {
  const kandidat = summary(candidate),
    base = summary(baseline);
  if (!base.kasus || !base.lulus) return { cukup: null, alasan: "belum ada baseline BYOK untuk dibandingkan", kandidat, baseline: base };
  const passRatio = kandidat.lulus / kandidat.kasus / (base.lulus / base.kasus);
  const p95Ratio = base.p95Ms ? kandidat.p95Ms / base.p95Ms : Infinity;
  const reasons = [];
  if (passRatio < THRESHOLD.passRatio) reasons.push(`lulus ${Math.round(passRatio * 100)}% dari baseline (< 90%)`);
  if (p95Ratio > THRESHOLD.p95Ratio) reasons.push(`latensi p95 ${p95Ratio.toFixed(2)}x baseline (> 2x)`);
  return {
    cukup: reasons.length === 0,
    alasan: reasons.length ? reasons.join("; ") : "memenuhi ambang markas (lulus >= 90% baseline, p95 <= 2x)",
    passRatio,
    p95Ratio,
    kandidat,
    baseline: base,
  };
}
