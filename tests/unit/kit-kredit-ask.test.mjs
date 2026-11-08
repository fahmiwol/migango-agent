import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Benchmark v2 (markas, 27 Oct 2026): pilot 2 showed 10 of 20 plain-arm failures were ask-mode
// budget limits, not the model. For the v2 run the kit sets ask budgets equal to work
// (--ask-setara), records the previous ask values once, and pulihkan puts them back exactly
// (absent stays absent). Runs on a rehearsal copy only.
const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const kit = path.join(repo, "docs", "08-ops", "kit-kredit", "kredit.mjs");
const scratch = mkdtempSync(path.join(os.tmpdir(), "kit-ask-repo-"));
const git = (...a) => execFileSync("git", a, { cwd: scratch, stdio: "pipe", windowsHide: true });
git("init", "-q", "-b", "main");
writeFileSync(path.join(scratch, "a.txt"), "a");
git("add", "a.txt");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "t");
const workspace = scratch + "-wt";
git("worktree", "add", "-q", "-b", "kit-ask", workspace);
process.on("exit", () => { for (const d of [workspace, scratch]) try { rmSync(d, { recursive: true, force: true }); } catch {} });

async function data(settings) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-ask-data-"));
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1, settings, vault: {} }));
  return dir;
}
const kitRun = (dir, ...args) => {
  try {
    execFileSync(process.execPath, [kit, ...args, "--data", dir, "--laporan", path.join(dir, "lap.json")], { stdio: "pipe", windowsHide: true });
  } catch {}
  return fs.readFile(path.join(dir, "lap.json"), "utf8").then(JSON.parse);
};
const settingsOf = async (dir) => JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).settings;
const siapkan = (dir, ...extra) => kitRun(dir, "siapkan", "--workspace", workspace, "--pagu", "230", "--token", "150000000", ...extra);

test("--ask-setara gives ask the same budgets as work for the run", async () => {
  const dir = await data({});
  const r = await siapkan(dir, "--ask-setara");
  assert.equal(r.galat, undefined, r.galat);
  const s = await settingsOf(dir);
  assert.equal(s.inputBudgets.ask, s.inputBudgets.work);
  assert.equal(s.outputLimits.ask, s.outputLimits.work);
  assert.equal(s.inputLimits.ask, s.inputLimits.work);
  await fs.rm(dir, { recursive: true, force: true });
});

test("without the flag the ask budgets are untouched", async () => {
  const dir = await data({ inputBudgets: { ask: 120000 } });
  await siapkan(dir);
  const s = await settingsOf(dir);
  assert.equal(s.inputBudgets.ask, 120000);
  assert.equal(s.outputLimits?.ask, undefined);
  await fs.rm(dir, { recursive: true, force: true });
});

test("pulihkan restores the previous ask values exactly, absent stays absent", async () => {
  const dir = await data({ inputBudgets: { ask: 120000 }, dailyCaps: { anthropic: { usd: 5, tokens: 2000000 } } });
  await siapkan(dir, "--ask-setara");
  await siapkan(dir, "--ask-setara"); // a second run must not overwrite the recorded old values
  const r = await kitRun(dir, "pulihkan");
  assert.equal(r.galat, undefined, r.galat);
  const s = await settingsOf(dir);
  assert.equal(s.inputBudgets.ask, 120000);
  assert.equal(Object.hasOwn(s.outputLimits || {}, "ask"), false);
  assert.equal(Object.hasOwn(s.inputLimits || {}, "ask"), false);
  await fs.rm(dir, { recursive: true, force: true });
});
