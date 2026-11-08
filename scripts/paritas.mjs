// Parity runs miganGO vs claude -p (ARS-011, PRD-020).
//
//   node scripts/paritas.mjs cek
//   node scripts/paritas.mjs jalankan --agen migango --ruang <abs worktree> --hasil <jsonl>
//        [--split dev] [--tugas id,id] [--ulang 2] [--model <profileId>] [--lewati-mcp]
//        [--discovery <connection.json>] [--batas-detik 900]
//   node scripts/paritas.mjs jalankan --agen claude --izinkan-claude --ruang <abs worktree> --hasil <jsonl>
//        [--mcp-config <json>] [--claude-bin claude]
//   node scripts/paritas.mjs laporan --hasil <jsonl>
//
// --ruang is a linked git worktree outside main; it is reset to each task's files before every
// attempt. For miganGO the app must already be open (launched through explorer.exe) with that
// folder as its workspace. claude -p only runs with --izinkan-claude: markas held it on 27 Oct 2026
// because of the weekly Claude usage cap. Holdout tasks are refused until the protocol is frozen.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { callLocalBridge } from "../src/bridge/client.mjs";
import { loadSet, prepare, collect, grade, runMigango, runClaude, report, needsThirdRepeat, outcomeFor } from "../src/eval/paritas.mjs";

function options(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--izinkan-claude", "--lewati-mcp"].includes(a)) out[a.slice(2)] = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

async function cek() {
  const set = await loadSet();
  let ok = 0;
  for (const t of set.tugas)
    for (const [name, expect] of [["benar", true], ["salah", false]]) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paritas-cek-"));
      try {
        if (grade(t, await outcomeFor(t, t.uji[name], dir)).pass === expect) ok++;
        else console.error(`penilai ${t.id} salah menilai solusi ${name}`);
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    }
  console.log(JSON.stringify({ tugas: set.tugas.length, dev: set.tugas.filter((t) => t.split === "dev").length, penilaiBenar: ok, dari: set.tugas.length * 2 }));
  return ok === set.tugas.length * 2 ? 0 : 1;
}

const spawnClaude = (bin) => (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile(bin, args, { cwd, timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (error, stdout) =>
      error && !stdout ? reject(error) : resolve(stdout),
    ),
  );

async function jalankan(o) {
  if (!["migango", "claude"].includes(o.agen)) throw new Error("--agen harus migango atau claude");
  if (o.agen === "claude" && !o["izinkan-claude"])
    throw new Error("claude -p ditahan (putusan markas 27 Okt 2026, pagu usage mingguan). Jalankan dengan --izinkan-claude sesudah STOP dibuka.");
  if (!o.ruang || !path.isAbsolute(o.ruang)) throw new Error("--ruang harus path absolut ke worktree terpisah");
  if (!o.hasil) throw new Error("--hasil <berkas jsonl> wajib");
  const split = o.split || "dev";
  if (split !== "dev") throw new Error("Holdout tidak dijalankan sampai protokol beku (ARS-011).");
  const set = await loadSet();
  const only = o.tugas ? new Set(o.tugas.split(",")) : null;
  const tasks = set.tugas.filter((t) => t.split === split && (!only || only.has(t.id)));
  const repeats = Math.max(1, Math.min(5, Number(o.ulang) || 2));
  const discovery = o.discovery || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "migan-workbench", "local-bridge", "connection.json");
  const call = (method, params) => callLocalBridge(discovery, method, params);
  const write = (row) => fs.appendFile(o.hasil, JSON.stringify({ ...row, at: new Date().toISOString() }) + "\n");
  for (const task of tasks)
    for (let ulang = 1; ulang <= repeats; ulang++) {
      const base = { agen: o.agen, id: task.id, kategori: task.kategori, split, ulang };
      if (task.kategori === "mcp" && o["lewati-mcp"]) {
        await write({ ...base, status: "tidak-dijalankan", pass: null, alasan: "MCP katalog belum terpasang" });
        continue;
      }
      try {
        await prepare(task, o.ruang);
        const r =
          o.agen === "migango"
            ? await runMigango({ task, workspace: o.ruang, call, modelId: o.model, limitMs: (Number(o["batas-detik"]) || 900) * 1000 })
            : await runClaude({ task, workspace: o.ruang, spawnClaude: spawnClaude(o["claude-bin"] || "claude"), mcpConfig: o["mcp-config"] });
        const outcome = await collect(task, o.ruang, r);
        const g = grade(task, outcome);
        await write({ ...base, status: "dinilai", pass: g.pass, alasan: g.reasons, final: String(r.final).slice(0, 500), jenis: r.jenis, ms: r.ms, biaya: r.biaya ?? null, usage: r.usage ?? null, intervensi: r.intervensi });
        console.error(`${task.id} #${ulang}: ${g.pass ? "LULUS" : "GAGAL"}`);
      } catch (error) {
        // Infrastructure (bridge closed, cap reached) is recorded apart and is not an agent failure.
        await write({ ...base, status: "tidak-dijalankan", pass: null, alasan: String(error.message).slice(0, 300) });
        console.error(`${task.id} #${ulang}: tidak dijalankan: ${error.message}`);
        if (/pagu|ERR_COST_CAP|bridge is unavailable/i.test(error.message)) return 2;
      }
    }
  return 0;
}

async function laporan(o) {
  const rows = (await fs.readFile(o.hasil, "utf8")).split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  console.log(JSON.stringify({ ...report(rows), ulangKetiga: needsThirdRepeat(rows) }, null, 2));
  return 0;
}

const o = options(process.argv.slice(2));
const commands = { cek, jalankan: () => jalankan(o), laporan: () => laporan(o) };
try {
  process.exitCode = commands[o._[0]] ? await commands[o._[0]]() : (console.error("Perintah: cek | jalankan | laporan"), 1);
} catch (error) {
  console.error("paritas: " + error.message);
  process.exitCode = 1;
}
