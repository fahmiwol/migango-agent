// Give a task to the owner's running miganGO without a window (PRD-019 phase 1), or print the
// day's cost report. The task path goes through the Local Bridge (start -> operation -> result);
// the bridge token stays in its descriptor and is never printed. Keys stay in the app.
//
//   node scripts/migango-tugas.mjs jalankan --workspace <abs> --mode ask|work --prompt "..."
//        [--model <profileId>] [--request-id <uuid>] [--discovery <connection.json>]
//        [--batas-detik 900] [--jeda-ms 2000] [--setujui-worktree]
//   node scripts/migango-tugas.mjs laporan [--tanggal YYYY-MM-DD] [--data <folder data miganGO>]
//
// --setujui-worktree (markas, 26 Oct 2026): approve complete file writes on its own only when the
// workspace is a linked git worktree on a branch other than main/master. Every other approval
// (shell, network, secrets, writes elsewhere) waits for the owner.
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { callLocalBridge } from "../src/bridge/client.mjs";
import { CostMeter, wibDate } from "../src/core/cost-meter.mjs";
import { isolatedWorktree } from "../src/core/worktree.mjs";

const dataRoot = () => path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "migan-workbench");
const canonical = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--setujui-worktree") out.setujuiWorktree = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function jalankan(o) {
  const discovery = o.discovery || path.join(dataRoot(), "local-bridge", "connection.json");
  if (!o.workspace || !path.isAbsolute(o.workspace)) throw new Error("--workspace harus path absolut");
  if (!["ask", "work"].includes(o.mode)) throw new Error("--mode harus ask atau work");
  const call = (method, params) => callLocalBridge(discovery, method, params);
  const requestId = o["request-id"] || randomUUID();
  const pause = Math.max(10, Number(o["jeda-ms"]) || 2000);
  const deadline = Date.now() + Math.max(1, Number(o["batas-detik"]) || 900) * 1000;
  const auto = o.setujuiWorktree ? isolatedWorktree(o.workspace) : null;
  const approved = [],
    waiting = new Map();
  // Printed first, so a failed run can be looked up or retried with the same id.
  console.error("migango-tugas: requestId " + requestId);
  const startParams = {
    requestId,
    expectedWorkspace: o.workspace,
    prompt: o.prompt,
    mode: o.mode,
    ...(o.model ? { modelId: o.model } : {}),
  };
  // The bridge treats the same requestId + input as one task, so a lost answer is retried safely.
  let op;
  for (let attempt = 1; ; attempt++) {
    try {
      op = await call("start", startParams);
      break;
    } catch (error) {
      if (attempt >= 3 || !/timed out|connection failed/i.test(error.message)) throw error;
      await delay(500 * attempt);
    }
  }
  for (;;) {
    for (const item of await call("approvals", {})) {
      // Only approvals raised by this task's own operation.
      if (item.operationId !== op.operationId) continue;
      const eligible =
        auto?.ok &&
        ["write_file", "edit_file"].includes(item.tool) &&
        item.approvable === true &&
        canonical(item.workspace) === canonical(o.workspace);
      if (eligible) {
        await call("decide", { id: item.id, digest: item.digest, yes: true, expectedWorkspace: o.workspace });
        approved.push({ id: item.id, tool: item.tool });
        waiting.delete(item.id);
      } else waiting.set(item.id, { id: item.id, tool: item.tool, expiresAt: item.expiresAt });
    }
    op = await call("operation", { operationId: op.operationId });
    if (!["starting", "running"].includes(op.status) || Date.now() > deadline) break;
    await delay(pause);
  }
  const done = !["starting", "running"].includes(op.status);
  const result = done ? await call("result", { operationId: op.operationId }) : { operation: op, run: null };
  const report = {
    ...result,
    ...(auto ? { persetujuanOtomatis: auto.ok ? `aktif (worktree cabang ${auto.branch})` : `tidak aktif: ${auto.reason}` } : {}),
    disetujuiOtomatis: approved,
    menungguPemilik: [...waiting.values()].filter((w) => !approved.some((a) => a.id === w.id)),
  };
  console.log(JSON.stringify(report, null, 2));
  return done ? 0 : 2;
}

async function laporan(o) {
  // The CLI does not read the app's settings file; real caps live in miganGO's Settings.
  const meter = new CostMeter({ root: o.data || dataRoot(), settings: () => ({ dailyCaps: {} }) });
  const report = await meter.report(o.tanggal || wibDate());
  console.log(
    JSON.stringify({ ...report, capNote: "Pagu sebenarnya ada di Pengaturan miganGO; laporan ini hanya membaca catatan biaya." }, null, 2),
  );
  return 0;
}

const o = options(process.argv.slice(2));
try {
  const command = o._[0];
  process.exitCode = command === "jalankan" ? await jalankan(o) : command === "laporan" ? await laporan(o) : 1;
  if (!["jalankan", "laporan"].includes(command)) console.error("Perintah: jalankan | laporan (lihat komentar di atas berkas).");
} catch (error) {
  // Only the message: no stack, no descriptor contents.
  console.error("migango-tugas: " + String(error.message).slice(0, 500));
  process.exitCode = 1;
}
