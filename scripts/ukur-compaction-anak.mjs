// Measures how team children use their step budget and how often compaction fires (markas,
// 26 Oct 2026: childSteps stays 2 until real runs show otherwise). Reads saved run JSON files and
// prints aggregates only: no prompt, task, file or model text leaves this tool.
// Run: node scripts/ukur-compaction-anak.mjs [--dir <runs folder>]
// Default folder: %APPDATA%/migan-workbench/runs (the app's own data folder).
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const MIN_CHILDREN = 10;
const STEP_SHARE = 0.2;
const STOPS = [
  [/step budget exhausted/i, "batas-langkah"],
  [/input byte budget exhausted/i, "batas-input"],
  [/context window exhausted/i, "jendela-konteks"],
  [/continuation limit/i, "batas-lanjutan"],
  [/deadline/i, "batas-waktu"],
];
const bump = (o, k) => ((o[k] = (o[k] || 0) + 1), o);

function stopOf(run) {
  if (run.status !== "failed") return run.status === "cancelled" ? "dibatalkan" : "selesai";
  for (const [pattern, name] of STOPS) if (pattern.test(String(run.error || ""))) return name;
  return "gagal-lain";
}

/** Aggregates child runs (records with parentRunId). Parent runs are ignored. */
export function measureChildRuns(runs) {
  const out = { children: 0, withCompaction: 0, compactions: 0, stops: {}, stepsUsed: {}, stepBudgets: {} };
  for (const run of runs) {
    if (!run || typeof run !== "object" || !run.parentRunId) continue;
    const events = Array.isArray(run.events) ? run.events : [];
    const compactions = events.filter((e) => e?.type === "context-compacted").length;
    out.children++;
    out.compactions += compactions;
    if (compactions) out.withCompaction++;
    bump(out.stops, stopOf(run));
    bump(out.stepsUsed, events.filter((e) => e?.type === "thinking").length);
    if (Number.isSafeInteger(run.budget?.steps)) bump(out.stepBudgets, run.budget.steps);
  }
  const stepped = out.stops["batas-langkah"] || 0;
  out.proposal =
    out.children === 0
      ? "Belum ada data run tim; childSteps tetap 2."
      : out.children < MIN_CHILDREN
        ? `Data terlalu sedikit (${out.children} anak); childSteps tetap 2 sampai ada minimal ${MIN_CHILDREN} anak.`
        : stepped / out.children >= STEP_SHARE
          ? `${Math.round((100 * stepped) / out.children)}% anak berhenti di batas langkah; usulan uji childSteps 3 (compaction anak baru bisa aktif mulai 3 langkah; input per anak naik kira-kira sepertiga), lalu ukur ulang.`
          : `${Math.round((100 * stepped) / out.children)}% anak berhenti di batas langkah (di bawah ${STEP_SHARE * 100}%); childSteps tetap 2.`;
  return out;
}

async function main() {
  const at = process.argv.indexOf("--dir");
  const dir =
    at > 0 ? process.argv[at + 1] : path.join(process.env.APPDATA || path.join(os.homedir(), ".config"), "migan-workbench", "runs");
  let names = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    names = [];
  }
  const runs = [];
  let unreadable = 0;
  for (const name of names) {
    try {
      runs.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
    } catch {
      unreadable++;
    }
  }
  console.log(JSON.stringify({ files: names.length, unreadable, ...measureChildRuns(runs) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
