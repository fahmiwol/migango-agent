import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Round 3 (markas, 27 Oct 2026, owner approved +US$50): the dollar cap goes to 230 and the daily
// token cap to 150M, because with ~77% cache reads a dollar buys more tokens; dollars stay the
// main fence. The kit runs only on a rehearsal copy here (--data), never on the live folder.
const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const kit = path.join(repo, "docs", "08-ops", "kit-kredit", "kredit.mjs");
// The kit only accepts an isolated worktree on a non-main branch. A throwaway repo + worktree keeps
// the test independent of where it runs (a detached verification checkout is refused on purpose).
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kit-repo-"));
const git = (...a) => execFileSync("git", a, { cwd: scratch, stdio: "pipe", windowsHide: true });
git("init", "-q", "-b", "main");
await fs.writeFile(path.join(scratch, "a.txt"), "a");
git("add", "a.txt");
git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "t");
const workspace = path.join(scratch + "-wt");
git("worktree", "add", "-q", "-b", "kit-test", workspace);
// "exit" handlers cannot wait for promises, so the cleanup is synchronous.
process.on("exit", () => { for (const d of [workspace, scratch]) try { rmSync(d, { recursive: true, force: true }); } catch {} });

async function siapkan(pagu, token) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-batas-"));
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1, settings: {}, vault: {} }));
  const laporan = path.join(dir, "lap.json");
  try {
    execFileSync(process.execPath, [kit, "siapkan", "--workspace", workspace, "--pagu", String(pagu), "--token", String(token), "--data", dir, "--laporan", laporan], { stdio: "pipe", windowsHide: true });
  } catch {}
  const out = JSON.parse(await fs.readFile(laporan, "utf8"));
  await fs.rm(dir, { recursive: true, force: true });
  return out;
}

test("the kit accepts the round-3 caps: US$230 and 150M tokens", async () => {
  const r = await siapkan(230, 150000000);
  assert.equal(r.galat, undefined, r.galat);
  assert.equal(r.hasil.sesudah.anthropicUsd, 230);
  assert.equal(r.hasil.sesudah.anthropicTokens, 150000000);
});

test("the kit still refuses a dollar cap above 250", async () => {
  const r = await siapkan(251, 150000000);
  assert.match(r.galat || "", /pagu/);
});

test("the kit refuses a token cap above 200M", async () => {
  const r = await siapkan(230, 200000001);
  assert.match(r.galat || "", /token/);
});
