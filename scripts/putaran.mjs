#!/usr/bin/env node
// Round runner CLI (ARS-016): runs one bounded work run per round through the Local Bridge,
// lets the host commit after every round and stops on goal, round limit, budget or errors.
// Approvals stay with the owner; only --setujui-daftar-izin approves write_file/edit_file/shell
// items the bridge itself marks approvable for this operation and workspace.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { callLocalBridge } from "../src/bridge/client.mjs";
import { jalankanPutaran } from "../src/runflow/putaran.mjs";
import { costOf, effectivePrices, PAID_PROVIDERS } from "../src/core/cost-meter.mjs";

export const IZIN_DAFTAR = Object.freeze(["write_file", "edit_file", "shell"]);
const AKTIF = new Set(["starting", "running", "queued", "waiting", "waiting-approval", "stopping"]);
const BATAS_RUN_MS = 30 * 60 * 1000;
const JEDA_MS = 1500;
const POLL_SESUDAH_STOP = 60;

const FLAGS = { "--tujuan-berkas": "tujuanBerkas", "--progress": "progress", "--maks": "maks", "--anggaran": "anggaran", "--model": "model", "--workspace": "workspace", "--maks-giliran": "maksGiliran" };
// Hard stop per round (markas, 27 Oct 2026): every run gets maxTurns; the app keeps the lower of
// this and the owner's limit, so a round can never run unbounded (06a2 ran 59 turns without it).
const MAKS_GILIRAN_BAWAAN = 25;

/** Parses CLI flags; relative files resolve against the workspace (default: cwd). */
export function parseArgs(argv, cwd = process.cwd()) {
  const raw = { setujuiDaftarIzin: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--setujui-daftar-izin") raw.setujuiDaftarIzin = true;
    else if (Object.hasOwn(FLAGS, a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error("Nilai " + a + " wajib diisi.");
      raw[FLAGS[a]] = v;
    } else throw new Error("Flag tidak dikenal: " + String(a).slice(0, 40));
  }
  const workspace = raw.workspace ?? cwd;
  if (!path.isAbsolute(workspace)) throw new Error("--workspace harus path absolut.");
  for (const k of ["tujuanBerkas", "progress"])
    if (!raw[k]) throw new Error("--" + (k === "tujuanBerkas" ? "tujuan-berkas" : "progress") + " wajib diisi.");
  const maks = Number(raw.maks);
  if (!/^\d+$/.test(raw.maks ?? "") || !Number.isInteger(maks) || maks < 1 || maks > 1000) throw new Error("--maks harus bilangan bulat 1-1000.");
  const anggaran = Number(raw.anggaran);
  if (!/^\d+(\.\d+)?$/.test(raw.anggaran ?? "") || !(anggaran > 0) || anggaran > 1000) throw new Error("--anggaran harus angka USD di atas 0, maks 1000.");
  const maksGiliran = raw.maksGiliran === undefined ? MAKS_GILIRAN_BAWAAN : Number(raw.maksGiliran);
  if (!/^\d+$/.test(raw.maksGiliran ?? String(MAKS_GILIRAN_BAWAAN)) || maksGiliran < 1 || maksGiliran > 60) throw new Error("--maks-giliran harus bilangan bulat 1-60.");
  const ws = path.resolve(workspace);
  return {
    maksGiliran,
    tujuanBerkas: path.resolve(ws, raw.tujuanBerkas),
    progress: path.resolve(ws, raw.progress),
    maks,
    anggaran,
    model: raw.model,
    workspace: ws,
    setujuiDaftarIzin: raw.setujuiDaftarIzin,
  };
}

const samaPath = (a, b) =>
  typeof a === "string" && typeof b === "string" &&
  (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/** True only for an item the auto-approve flag may approve. */
export function bolehDisetujui(item, operationId, workspace) {
  return (
    !!item && item.approvable === true && IZIN_DAFTAR.includes(item.tool) &&
    item.operationId === operationId && samaPath(item.workspace, workspace)
  );
}

/** mulaiRun for the runner: start work mode, wait for the operation, return result.run. */
export function buatMulaiRun({ call, workspace, model, maksGiliran = MAKS_GILIRAN_BAWAAN, setujuiDaftarIzin = false, tunda = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, batasMs = BATAS_RUN_MS, sekarang = () => Date.now() }) {
  return async ({ prompt }) => {
    const op = await call("start", { requestId: randomUUID(), expectedWorkspace: workspace, prompt, mode: "work", maxTurns: maksGiliran, ...(model ? { modelId: model } : {}) });
    const operationId = op?.operationId;
    if (typeof operationId !== "string") throw new Error("Bridge tidak memberi operationId.");
    const deadline = sekarang() + batasMs;
    const dilaporkan = new Set();
    const disetujui = new Set();
    let stopped = false;
    let sisaSesudahStop = POLL_SESUDAH_STOP;
    for (;;) {
      const items = await call("approvals", {});
      for (const item of Array.isArray(items) ? items : []) {
        if (setujuiDaftarIzin && bolehDisetujui(item, operationId, workspace)) {
          if (disetujui.has(item.id)) continue;
          disetujui.add(item.id);
          await call("decide", { id: item.id, digest: item.digest, yes: true, expectedWorkspace: workspace });
        } else if (item?.operationId === operationId && !dilaporkan.has(item.id)) {
          dilaporkan.add(item.id);
          log("Persetujuan " + String(item.tool).slice(0, 40) + " menunggu keputusan pemilik di aplikasi.");
        }
      }
      const status = (await call("operation", { operationId }))?.status;
      if (!AKTIF.has(status)) break;
      if (!stopped && sekarang() >= deadline) {
        stopped = true;
        log("Batas waktu run tercapai; run dihentikan.");
        await call("stop", { expectedWorkspace: workspace });
      }
      if (stopped && --sisaSesudahStop < 0) break;
      await tunda(JEDA_MS);
    }
    const res = await call("result", { operationId });
    if (!res?.run || typeof res.run !== "object") throw new Error("Hasil bridge tidak memuat run.");
    return res.run;
  };
}

/** USD of one run from its reported usage at built-in prices; null when unknown (runner stops). */
export function hargaDariRun(run) {
  const p = run?.profile;
  if (!p || typeof p.provider !== "string" || typeof p.model !== "string") return null;
  if (p.provider === "ollama") return 0;
  if (!PAID_PROVIDERS.includes(p.provider)) return null;
  const u = run.usage;
  if (!u || u.available === false || !Number.isFinite(u.input) || !Number.isFinite(u.output)) return null;
  const price = effectivePrices()[p.provider + "/" + p.model];
  return price ? costOf(price, u) : null;
}

/** Paths from `git status --porcelain -z`; the source path of a rename/copy is skipped. */
export function pathBerubah(raw) {
  const tokens = String(raw).split("\0");
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.length < 4) continue;
    out.push(t.slice(3));
    if (/[RC]/.test(t.slice(0, 2))) i++;
  }
  return out;
}

function gitAsli(workspace) {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile("git", args, { cwd: workspace, windowsHide: true, shell: false, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (args[0] === "diff") return resolve({ code: error ? error.code : 0 });
        if (error) return reject(error);
        resolve(stdout);
      });
    });
}

/** commitPutaran: stage progress plus changed files, commit 'putaran N: ...'; null if nothing staged. */
export function buatCommitPutaran({ workspace, progress, jalankanGit }) {
  const rel = path.relative(workspace, progress);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Berkas progress harus berada di dalam workspace.");
  const git = jalankanGit || gitAsli(workspace);
  const progressRel = rel.split(path.sep).join("/");
  return async (_ke, pesan) => {
    const changed = pathBerubah(await git(["status", "--porcelain", "-z", "-uall"]));
    const files = [...new Set([progressRel, ...changed])];
    await git(["add", "--", ...files]);
    const diff = await git(["diff", "--cached", "--quiet"]);
    if (diff?.code === 0) return null;
    await git(["commit", "-m", String(pesan)]);
    return String(await git(["rev-parse", "HEAD"])).trim();
  };
}

/** bacaProgress: the progress text, or "" while the file does not exist yet. */
export function bacaProgressDari(file) {
  return async () => {
    try {
      return await fs.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return "";
      throw error;
    }
  };
}

/** Only the discovery file of the bridge is read from the app data folder. */
export function berkasPenemuan(env = process.env) {
  if (!env.APPDATA) throw new Error("APPDATA tidak ada; bridge tidak bisa ditemukan.");
  return path.join(env.APPDATA, "migan-workbench", "local-bridge", "connection.json");
}

export async function main(argv = process.argv.slice(2)) {
  const o = parseArgs(argv);
  const tujuan = await fs.readFile(o.tujuanBerkas, "utf8");
  const desc = berkasPenemuan();
  const call = (method, params) => callLocalBridge(desc, method, params);
  const hasil = await jalankanPutaran({
    tujuan,
    maksPutaran: o.maks,
    anggaranUsd: o.anggaran,
    mulaiRun: buatMulaiRun({ call, workspace: o.workspace, model: o.model, maksGiliran: o.maksGiliran, setujuiDaftarIzin: o.setujuiDaftarIzin }),
    bacaProgress: bacaProgressDari(o.progress),
    commitPutaran: buatCommitPutaran({ workspace: o.workspace, progress: o.progress }),
    hargaRun: hargaDariRun,
  });
  console.log(JSON.stringify(hasil, null, 2));
  return hasil;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error("Gagal: " + (error?.message || String(error)).slice(0, 400));
    process.exitCode = 1;
  });
}
