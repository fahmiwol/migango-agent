// External brain (an MCP server) cross-project memory for one task (S2). Before this reader, almost no
// memory events came from the external brain, because the only path (brain-adapter) needs a calibrated
// judge and an approved mcp_call, and the app wires neither.
//
// This reader goes through brain-gerbang (a gateway process that fronts the owner's notes server),
// spawned as a short-lived stdio child per task, and calls brain_search (k=3, ~0.6 s live;
// brain_context returns ~6 KB with the owner CORE, too large per task). The text is bounded by
// the caller and injected as UNTRUSTED evidence, like internal memory. It never throws: a
// missing, slow or broken external brain yields { status: "tidak-tersedia" } and the task goes on.
// Only the (already redacted) query leaves the app, and only to the owner's own external brain.
import { spawn } from "node:child_process";

export const BRAIN_GERBANG_BAWAAN = "C:/brain/gateway/server.js";
export const BRAIN_TIMEOUT_MS = 5000;

const textOf = (result) =>
  (result?.content || [])
    .filter((c) => c?.type === "text")
    .map((c) => c.text)
    .join("\n");

/**
 * @param {{ query: string, maxChars: number, perintah?: string[], timeoutMs?: number, signal?: AbortSignal }} a
 * @returns {Promise<{ status: "ok"|"tidak-tersedia", teks: string, ms: number, alasan?: string }>}
 */
export function ambilKonteksBrain({ query, maxChars, perintah, timeoutMs = BRAIN_TIMEOUT_MS, signal } = {}) {
  const t0 = Date.now();
  const selesai = (status, teks = "", alasan) => ({ status, teks, ms: Date.now() - t0, ...(alasan ? { alasan } : {}) });
  return new Promise((resolve) => {
    let done = false,
      child,
      buf = "";
    const akhiri = (hasil) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      try {
        child?.kill();
      } catch {}
      resolve(hasil);
    };
    const onAbort = () => akhiri(selesai("tidak-tersedia", "", "dibatalkan"));
    const timer = setTimeout(() => akhiri(selesai("tidak-tersedia", "", "batas waktu " + timeoutMs + " ms")), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    if (typeof query !== "string" || !query.trim() || !(maxChars > 0))
      return akhiri(selesai("tidak-tersedia", "", "kueri kosong"));
    const [cmd, ...args] = Array.isArray(perintah) && perintah.length ? perintah : [];
    if (!cmd) return akhiri(selesai("tidak-tersedia", "", "gerbang tidak dikonfigurasi"));
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch (e) {
      return akhiri(selesai("tidak-tersedia", "", "gerbang tidak bisa dijalankan: " + String(e?.code || e?.message).slice(0, 80)));
    }
    child.on("error", (e) => akhiri(selesai("tidak-tersedia", "", "gerbang tidak bisa dijalankan: " + String(e?.code || e?.message).slice(0, 80))));
    child.on("exit", () => akhiri(selesai("tidak-tersedia", "", "gerbang berhenti")));
    child.stdin.on("error", () => {});
    const kirim = (m) => {
      try {
        child.stdin.write(JSON.stringify(m) + "\n");
      } catch {}
    };
    child.stdout.on("data", (d) => {
      buf += d;
      if (buf.length > 2_000_000) return akhiri(selesai("tidak-tersedia", "", "jawaban terlalu besar"));
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          return akhiri(selesai("tidak-tersedia", "", "jawaban gerbang bukan JSON"));
        }
        if (m.id === 1) {
          if (m.error) return akhiri(selesai("tidak-tersedia", "", "inisialisasi ditolak"));
          kirim({ jsonrpc: "2.0", method: "notifications/initialized" });
          kirim({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "brain_search", arguments: { query: query.slice(0, 500), k: 3 } } });
        } else if (m.id === 2) {
          if (m.error || m.result?.isError) return akhiri(selesai("tidak-tersedia", "", "brain_search gagal"));
          const teks = textOf(m.result).trim();
          if (!teks) return akhiri(selesai("tidak-tersedia", "", "hasil kosong"));
          return akhiri(selesai("ok", teks.slice(0, maxChars)));
        }
      }
    });
    kirim({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "migango", version: "1" } } });
  });
}

/** The node binary + gerbang script the desktop app uses (owner may override in settings). */
export function perintahGerbang(settings = {}, env = process.env) {
  const o = settings.brainKonteks || {};
  const node = typeof o.node === "string" && o.node ? o.node : env.WORKBENCH_NODE || "C:/Program Files/nodejs/node.exe";
  const gerbang = typeof o.gerbang === "string" && o.gerbang ? o.gerbang : BRAIN_GERBANG_BAWAAN;
  return [node, gerbang];
}

// ---- Consent and provider policy (GATE S2 P1, markas 9 Nov 2026) ----
// Brain holds the owner's private cross-project notes. They reach a model only when the owner
// turned memory on (memoryEnabled, default off) AND Brain context on (brainKonteks.aktif, default
// off). Local models (ollama) are then allowed; an API provider needs its own switch (default off,
// Anthropic included). Providers whose data-use terms are not yet cited stay locked: a switch for
// them is dropped on save and ignored at run time.
export const BRAIN_PENYEDIA_PILIHAN = Object.freeze(["anthropic", "openai"]);
export const BRAIN_PENYEDIA_TERKUNCI = Object.freeze(["kimi", "gemini", "deepseek", "runpod"]);

/** Settings → may this provider receive Brain notes? */
export function bolehBrain(settings = {}, provider) {
  if (settings.memoryEnabled !== true) return { boleh: false, alasan: "ingatan mati (memoryEnabled)" };
  const o = settings.brainKonteks || {};
  if (o.aktif !== true) return { boleh: false, alasan: "konteks Brain belum dinyalakan pemilik" };
  if (provider === "ollama") return { boleh: true };
  if (BRAIN_PENYEDIA_TERKUNCI.includes(provider))
    return { boleh: false, alasan: provider + " terkunci: ketentuan penggunaan data belum dikutip" };
  if (!BRAIN_PENYEDIA_PILIHAN.includes(provider)) return { boleh: false, alasan: "penyedia " + provider + " tidak dikenal" };
  if (o.penyedia?.[provider] !== true) return { boleh: false, alasan: "sakelar Brain untuk " + provider + " mati" };
  return { boleh: true };
}

/** Saved shape: { aktif, penyedia: { anthropic?, openai? }, node?, gerbang? }. The gerbang command
 * (node/gerbang) is kept from the settings file only; the UI or bridge can never set it (GATE P5). */
export function validateBrainKonteks(input, saved) {
  const i = input && typeof input === "object" ? input : {};
  const penyedia = {};
  for (const p of BRAIN_PENYEDIA_PILIHAN)
    if (i.penyedia && Object.hasOwn(i.penyedia, p)) penyedia[p] = i.penyedia[p] === true;
  const out = { aktif: i.aktif === true, penyedia };
  for (const k of ["node", "gerbang"])
    if (typeof saved?.[k] === "string" && saved[k]) out[k] = saved[k];
  return out;
}

const PERAN = /^(\s*)(owner request|system|assistant|user|human|tool|developer)(\s*):/gim;

/** Brain text → JSON lines inside a nonce fence (GATE S2 P3). Role labels at a line start are
 * neutralised and the closing fence cannot appear inside, so stored text cannot pose as the
 * owner's request or close the evidence block. */
export function bungkusBrain(teks, nonce) {
  const baris = String(teks)
    .split(/\r?\n/)
    .map((l) => l.replace(PERAN, "$1[$2]$3:").replaceAll("END BRAIN", "END-BRAIN"));
  return "BEGIN BRAIN " + nonce + "\n" + JSON.stringify({ brain: baris }) + "\nEND BRAIN " + nonce;
}
