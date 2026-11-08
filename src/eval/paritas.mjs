// Parity test miganGO vs claude -p (ARS-011, PRD-020; markas 27 Oct 2026). A frozen task set graded
// on end state first: final files, node check scripts run on them, the kinds of tools used and the
// answer text. Tool names of both agents map to shared kinds. Runs reset one isolated worktree per
// agent to the task's files. The report pairs both agents per task and never claims parity in the
// pilot: it finds gaps and estimates how many tasks a 10-point margin would need.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { isolatedWorktree } from "../core/worktree.mjs";

const run = promisify(execFile);
const SET = path.resolve(import.meta.dirname, "../../evals/paritas/v1.json");
export const KATEGORI = ["koding", "terminal", "mcp", "riset-web", "dokumen", "delegasi", "memori", "persetujuan"];
const SPLITS = ["dev", "holdout"];
// Nothing private may enter the set: names, private paths, e-mail addresses, secret-shaped values
// and the projects marked rahasia.
const PRIVATE = [/jane-doe/i, /private-brain/i, /[A-Z]:[\\/]/, /@[a-z0-9-]+\.[a-z]/i, /\b(acme-app|acme-core|example-studio)\b/i, /sk-[A-Za-z0-9]{8,}/];

export function validateSet(set) {
  if (set?.v !== 1 || !Array.isArray(set.tugas)) throw new Error("Set paritas tidak sah");
  const ids = new Set();
  for (const t of set.tugas) {
    if (!/^[a-z0-9-]{3,60}$/.test(t.id) || ids.has(t.id)) throw new Error("id tugas tidak sah atau ganda: " + t.id);
    ids.add(t.id);
    if (!KATEGORI.includes(t.kategori)) throw new Error(`${t.id}: kategori tidak dikenal`);
    if (!SPLITS.includes(t.split)) throw new Error(`${t.id}: split harus dev atau holdout`);
    if (t.kebijakan !== undefined && !["izinkan", "tolak"].includes(t.kebijakan)) throw new Error(`${t.id}: kebijakan tidak dikenal`);
    const prompts = t.episode || [t.prompt];
    if (!prompts.length || prompts.some((p) => typeof p !== "string" || p.length < 10)) throw new Error(`${t.id}: prompt tidak sah`);
    if (!t.nilai || !Object.keys(t.nilai).length) throw new Error(`${t.id}: penilai kosong`);
    for (const rel of Object.keys(t.berkas || {}))
      if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes("..")) throw new Error(`${t.id}: path berkas harus relatif`);
  }
  const text = JSON.stringify(set);
  for (const re of PRIVATE) if (re.test(text)) throw new Error("Set memuat data pribadi atau path private: " + re);
  return set;
}

export async function loadSet(file = SET) {
  return validateSet(JSON.parse(await fs.readFile(file, "utf8")));
}

const CLAUDE_KINDS = { Read: "baca", Glob: "baca", Grep: "baca", LS: "baca", Write: "tulis", Edit: "tulis", MultiEdit: "tulis", NotebookEdit: "tulis", Bash: "perintah", WebFetch: "web", WebSearch: "web", Task: "delegasi", Agent: "delegasi" };
// miganGO tool names as registered in src/tools/registry.mjs (27 Oct 2026); delegation is read from
// delegation events, not a tool name.
const MIGANGO_KINDS = { read_file: "baca", list_files: "baca", search_files: "baca", reference_search: "baca", write_file: "tulis", edit_file: "tulis", shell: "perintah", browser_open: "web", browser_snapshot: "web", browser_click: "web", browser_fill: "web", browser_screenshot: "web", mcp_call: "mcp", mcp_list: "mcp", memory_note: "memori", memory_search: "memori" };

/** Shared kind of a tool call: baca, tulis, perintah, web, mcp, delegasi, memori or lain. */
export function toolKind(agent, name) {
  if (/^mcp__/.test(name)) return "mcp";
  const table = agent === "claude" ? CLAUDE_KINDS : MIGANGO_KINDS;
  return table[name] || "lain";
}

const words = (s) => String(s).toLowerCase();
const re = (s) => new RegExp(s, "i");

/** Deterministic grade of one outcome: { pass, reasons[] }, one reason per failed rule. */
export function grade(task, outcome) {
  const n = task.nilai;
  const reasons = [];
  const final = String(outcome.final || "");
  const kinds = new Set(outcome.jenis || []);
  const files = outcome.berkas || {};
  if (["failed", "cancelled"].includes(outcome.status)) reasons.push("tugas gagal");
  for (const t of n.jawabanMemuat || []) if (!words(final).includes(words(t))) reasons.push("jawaban tidak memuat: " + t);
  for (const r of n.jawabanCocok || []) if (!re(r).test(final)) reasons.push("jawaban tidak cocok: " + r);
  for (const k of n.wajibJenis || []) if (!kinds.has(k)) reasons.push("tidak memakai alat jenis: " + k);
  for (const k of n.dilarangJenis || []) if (kinds.has(k)) reasons.push("memakai alat jenis terlarang: " + k);
  for (const [rel, text] of Object.entries(n.berkasSama || {})) if (files[rel] !== text) reasons.push("berkas berbeda: " + rel);
  for (const [rel, list] of Object.entries(n.berkasCocok || {}))
    for (const r of list) if (files[rel] === undefined || !new RegExp(r).test(files[rel])) reasons.push(`berkas ${rel} tidak cocok: ${r}`);
  for (const [rel, list] of Object.entries(n.berkasTidakMemuat || {}))
    for (const t of list) if ((files[rel] || "").includes(t)) reasons.push(`berkas ${rel} masih memuat: ${t}`);
  for (const rel of n.berkasTidakBerubah || []) if (files[rel] !== task.berkas[rel]) reasons.push("berkas berubah: " + rel);
  for (const rel of n.berkasTidakAda || []) if (files[rel] !== undefined) reasons.push("berkas ada: " + rel);
  for (const p of n.perintah || []) {
    const r = (outcome.perintah || {})[p.node];
    if (!r || r.kode !== 0 || !String(r.keluaran).includes(p.keluaranMemuat)) reasons.push(`node ${p.node} tidak mencetak ${p.keluaranMemuat}`);
  }
  return { pass: reasons.length === 0, reasons };
}

const TEXT_LIMIT = 256 * 1024;

/** Text files of a folder (no .git), as { "rel/path": text }. */
export async function snapshot(root, dir = root, out = {}) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === ".git") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await snapshot(root, p, out);
    else if (e.isFile()) {
      const stat = await fs.stat(p);
      if (stat.size <= TEXT_LIMIT) out[path.relative(root, p).split(path.sep).join("/")] = await fs.readFile(p, "utf8");
    }
  }
  return out;
}

/** Runs the task's node check scripts in the folder: { file: { kode, keluaran } }. */
export async function runChecks(task, dir) {
  const out = {};
  for (const p of task.nilai.perintah || []) {
    try {
      const { stdout } = await run(process.execPath, [p.node], { cwd: dir, timeout: 20000, windowsHide: true });
      out[p.node] = { kode: 0, keluaran: stdout };
    } catch (error) {
      out[p.node] = { kode: typeof error.code === "number" ? error.code : 1, keluaran: String(error.stdout || "") };
    }
  }
  return out;
}

async function writeFiles(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), text);
  }
}

/** Builds the outcome a solution fixture would leave (used to test every grader). */
export async function outcomeFor(task, solution, dir) {
  await writeFiles(dir, task.berkas);
  await writeFiles(dir, solution.berkas || {});
  for (const rel of solution.hapus || []) await fs.rm(path.join(dir, rel), { force: true });
  return { status: "responded", final: solution.final || "", jenis: solution.jenis || [], berkas: await snapshot(dir), perintah: await runChecks(task, dir) };
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", windowsHide: true });

/** Resets an isolated worktree to exactly the task's files and commits that as the start state. */
export async function prepare(task, workspace) {
  const check = isolatedWorktree(workspace);
  if (!check.ok) throw new Error("Ruang tugas harus worktree git terpisah di luar main: " + check.reason);
  for (const e of await fs.readdir(workspace)) if (e !== ".git") await fs.rm(path.join(workspace, e), { recursive: true, force: true });
  await writeFiles(workspace, task.berkas);
  git(workspace, "add", "-A");
  git(workspace, "-c", "user.email=paritas@lokal", "-c", "user.name=paritas", "commit", "-q", "--allow-empty", "-m", "paritas: awal " + task.id);
}

/** Final outcome of a run in the workspace, after the agent finished. */
export async function collect(task, workspace, run) {
  return { ...run, berkas: await snapshot(workspace), perintah: await runChecks(task, workspace) };
}

/**
 * One task through miganGO's Local Bridge (the app must already be open on `workspace`). Each
 * episode is a new task. Approvals follow the task's policy: "izinkan" approves inside the isolated
 * workspace, "tolak" denies; both count as human intervention.
 */
export async function runMigango({ task, workspace, call, mode = "work", modelId, pause = 2000, limitMs = 900000, now = () => Date.now() }) {
  const policy = task.kebijakan || "izinkan";
  const started = now();
  const kinds = new Set();
  let final = "", status = "", usage = null, intervensi = 0;
  for (const prompt of task.episode || [task.prompt]) {
    const requestId = randomUUID(); // the bridge expects a UUID
    let op = await call("start", { requestId, expectedWorkspace: workspace, prompt, mode, ...(modelId ? { modelId } : {}) });
    const deadline = now() + limitMs;
    const decided = new Set();
    for (;;) {
      // The real bridge returns a plain array of pending approvals.
      const pending = await call("approvals", {});
      for (const item of Array.isArray(pending) ? pending : []) {
        if (item.operationId !== op.operationId || decided.has(item.id)) continue;
        await call("decide", { id: item.id, digest: item.digest, yes: policy === "izinkan", expectedWorkspace: workspace });
        decided.add(item.id);
        intervensi++;
      }
      op = await call("operation", { operationId: op.operationId });
      if (!["starting", "running"].includes(op.status) || now() > deadline) break;
      if (pause) await delay(pause);
    }
    const result = await call("result", { operationId: op.operationId });
    const r = result?.run || {};
    for (const e of r.events || []) {
      if (e.type === "tool-start") kinds.add(toolKind("migango", e.name));
      if (e.type === "delegation-result" || e.type === "delegation-event") kinds.add("delegasi");
    }
    final = r.final || "";
    status = r.status || op.status;
    usage = r.usage || usage;
  }
  return { agen: "migango", status, final, jenis: [...kinds], usage, intervensi, ms: now() - started };
}

/** claude -p arguments; edits accepted, never bypassPermissions; "tolak" denies shell and network. */
export function claudeArgs(task, prompt, { mcpConfig } = {}) {
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"];
  if (task.kebijakan === "tolak") args.push("--disallowedTools", "Bash WebFetch WebSearch");
  if (mcpConfig && task.kategori === "mcp") args.push("--mcp-config", mcpConfig);
  return args;
}

/** Parses claude -p stream-json output: { final, jenis, biaya, isError }. */
export function parseClaude(stdout) {
  const kinds = new Set();
  let final = "", biaya = null, isError = false;
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.type === "assistant") for (const c of m.message?.content || []) if (c.type === "tool_use") kinds.add(toolKind("claude", c.name));
    if (m.type === "result") {
      final = m.result || "";
      biaya = typeof m.total_cost_usd === "number" ? m.total_cost_usd : null;
      isError = !!m.is_error;
    }
  }
  return { final, jenis: [...kinds], biaya, isError };
}

/** One task through claude -p; each episode is a new session. `spawnClaude(args, cwd)` → stdout. */
export async function runClaude({ task, workspace, spawnClaude, mcpConfig, now = () => Date.now() }) {
  const started = now();
  const kinds = new Set();
  let last = { final: "", isError: false }, biaya = 0;
  for (const prompt of task.episode || [task.prompt]) {
    last = parseClaude(await spawnClaude(claudeArgs(task, prompt, { mcpConfig }), workspace));
    for (const k of last.jenis) kinds.add(k);
    biaya = last.biaya === null || biaya === null ? null : biaya + last.biaya;
  }
  return { agen: "claude", status: last.isError ? "failed" : "responded", final: last.final, jenis: [...kinds], biaya, intervensi: 0, ms: now() - started };
}

// Seeded PRNG so a report is reproducible.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Paired report over graded results [{ agen, id, kategori, ulang, pass, status }]. Means are over
 * tasks (each task's mean over its repeats), the interval is a bootstrap over tasks, never over
 * single attempts. No parity is claimed in the pilot.
 */
export function report(results, { seed = 1, resamples = 2000 } = {}) {
  const graded = results.filter((r) => r.status === "dinilai" && typeof r.pass === "boolean");
  const byTask = new Map();
  for (const r of graded) {
    const t = byTask.get(r.id) || { id: r.id, kategori: r.kategori, claude: [], migango: [] };
    t[r.agen].push(r.pass ? 1 : 0);
    byTask.set(r.id, t);
  }
  const paired = [...byTask.values()].filter((t) => t.claude.length && t.migango.length);
  const kategori = {};
  const rand = mulberry32(seed);
  const discord = [];
  for (const k of KATEGORI) {
    const tasks = paired.filter((t) => t.kategori === k);
    if (!tasks.length) continue;
    const c = tasks.map((t) => mean(t.claude)),
      m = tasks.map((t) => mean(t.migango));
    const diffs = tasks.map((_, i) => m[i] - c[i]);
    const boots = [];
    for (let b = 0; b < resamples; b++) {
      let s = 0;
      for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(rand() * diffs.length)];
      boots.push(s / diffs.length);
    }
    boots.sort((a, b) => a - b);
    const claudeWins = tasks.reduce((s, t) => s + t.claude.reduce((a, b) => a + b, 0), 0);
    const kept = tasks.reduce((s, t) => s + Math.min(t.claude.reduce((a, b) => a + b, 0), t.migango.reduce((a, b) => a + b, 0)), 0);
    for (const t of tasks) discord.push(Math.abs(mean(t.claude) - mean(t.migango)) > 0 ? 1 : 0);
    kategori[k] = {
      tugas: tasks.length,
      claude: mean(c),
      migango: mean(m),
      selisih: mean(diffs),
      interval: [boots[Math.floor(0.025 * resamples)], boots[Math.min(resamples - 1, Math.ceil(0.975 * resamples) - 1)]],
      dipertahankan: claudeWins ? kept / claudeWins : null,
      passK: { claude: mean(tasks.map((t) => (t.claude.every(Boolean) ? 1 : 0))), migango: mean(tasks.map((t) => (t.migango.every(Boolean) ? 1 : 0))) },
    };
  }
  const celah = paired
    .map((t) => ({ id: t.id, kategori: t.kategori, claude: mean(t.claude), migango: mean(t.migango), selisih: mean(t.claude) - mean(t.migango) }))
    .filter((t) => t.selisih > 0)
    .sort((a, b) => b.selisih - a.selisih || a.id.localeCompare(b.id));
  // Tasks needed for a 10-point paired margin (alpha 0.05 two-sided, power 0.8), from the observed
  // share of tasks where the two agents disagree; null when the pilot has no disagreement yet.
  const q = mean(discord);
  const d = 0.1;
  const perkiraanTugasMargin10 = discord.length && q > d * d ? Math.ceil(((1.96 + 0.8416) ** 2 * (q - d * d)) / (d * d)) : null;
  return {
    kategori,
    celah,
    tidakDijalankan: results.filter((r) => r.status === "tidak-dijalankan").length,
    klaimSetara: false,
    perkiraanTugasMargin10,
    catatan: "Pilot penemu celah (putusan markas 27 Okt 2026): tidak ada klaim setara; margin ditetapkan sesudah pilot.",
  };
}

/** Task ids whose four outcomes (two repeats per agent) disagree: only these get a third repeat. */
export function needsThirdRepeat(results) {
  const by = new Map();
  for (const r of results.filter((x) => x.status === "dinilai")) by.set(r.id, [...(by.get(r.id) || []), r.pass]);
  return [...by].filter(([, v]) => new Set(v).size > 1).map(([id]) => id);
}
