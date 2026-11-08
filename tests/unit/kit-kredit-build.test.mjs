import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { rmSync, mkdtempSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Markas, 27 Oct 2026 ("ya kit build"): --workspace-build points the app at an empty build folder
// for the bridge build QA. It uses the SAME guard as the bridge (checkBridgeBuildTarget) with the
// devRoots read from the app settings, never from an argument, and the kit never writes devRoots.
// The kit runs on a rehearsal copy here (--data); the real folder still needs the app closed.
const repo = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const kit = path.join(repo, "docs", "08-ops", "kit-kredit", "kredit.mjs");
const base = mkdtempSync(path.join(os.tmpdir(), "kit-build-"));
const devRoot = path.join(base, "qa");
const target = path.join(devRoot, "build-sonnet");
const outside = path.join(base, "luar", "build");
for (const d of [target, outside]) mkdirSync(d, { recursive: true });
process.on("exit", () => { try { rmSync(base, { recursive: true, force: true }); } catch {} });

async function siapkan(args, devRoots = [devRoot]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-build-data-"));
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1, settings: { devRoots }, vault: {} }));
  const laporan = path.join(dir, "lap.json");
  try {
    execFileSync(process.execPath, [kit, "siapkan", ...args, "--pagu", "230", "--token", "150000000", "--data", dir, "--laporan", laporan], { stdio: "pipe", windowsHide: true });
  } catch {}
  const out = JSON.parse(await fs.readFile(laporan, "utf8"));
  const after = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8")).settings;
  await fs.rm(dir, { recursive: true, force: true });
  return { out, after };
}
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

test("an empty folder inside a devRoot from the settings becomes the workspace", async () => {
  const { out, after } = await siapkan(["--workspace-build", target]);
  assert.equal(out.galat, undefined, out.galat);
  assert.ok(same(after.workspace, await fs.realpath(target)));
});

test("a target outside the settings' devRoots is refused, whatever the arguments say", async () => {
  const { out, after } = await siapkan(["--workspace-build", outside, "--devRoots", path.dirname(outside)]);
  assert.match(out.galat || "", /akar dev|devRoots/);
  assert.equal(after.workspace, undefined, "nothing was written");
});

test("no devRoots in the settings means no build workspace", async () => {
  const { out } = await siapkan(["--workspace-build", target], []);
  assert.match(out.galat || "", /akar dev|devRoots/);
});

test("the kit never writes devRoots", async () => {
  const { after } = await siapkan(["--workspace-build", target]);
  assert.deepEqual(after.devRoots, [devRoot]);
  const r2 = await siapkan(["--workspace-build", target, "--devRoots", "C:\\"]);
  assert.deepEqual(r2.after.devRoots, [devRoot]);
});

test("the miganGO repo itself is never a build workspace, even under a broad devRoot", async () => {
  const { out } = await siapkan(["--workspace-build", path.join(repo, "docs")], [path.parse(repo).root]);
  assert.match(out.galat || "", /repo miganGO|sistem|live/);
});

test("the live app folder is never a build workspace, even under a broad devRoot", async () => {
  const live = "C:\\work\\live";
  try { await fs.access(live); } catch { return; } // only on the machine that has the live folder
  const { out } = await siapkan(["--workspace-build", path.join(live, "docs")], ["C:\\"]);
  assert.match(out.galat || "", /live|repo miganGO|sistem/);
});

test("a folder inside the app data folder is refused even when a devRoot covers it", async () => {
  // The rehearsal data folder plays userData here: forbidden comes from the kit, not from arguments.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kit-build-data-"));
  const inside = path.join(dir, "build");
  await fs.mkdir(inside);
  await fs.writeFile(path.join(dir, "state.json"), JSON.stringify({ version: 1, settings: { devRoots: [os.tmpdir()] }, vault: {} }));
  const laporan = path.join(dir, "lap.json");
  try {
    execFileSync(process.execPath, [kit, "siapkan", "--workspace-build", inside, "--pagu", "230", "--token", "150000000", "--data", dir, "--laporan", laporan], { stdio: "pipe", windowsHide: true });
  } catch {}
  const out = JSON.parse(await fs.readFile(laporan, "utf8"));
  await fs.rm(dir, { recursive: true, force: true });
  assert.match(out.galat || "", /live|data/);
});

test("--workspace and --workspace-build together are refused", async () => {
  const { out } = await siapkan(["--workspace", repo, "--workspace-build", target]);
  assert.match(out.galat || "", /workspace-build/);
});
