// 06u1: render feature screenshots from ui/index.html in a hidden, isolated Electron window.
// Only the renderer is loaded, with a stub preload that returns fixture data.
// Not loaded: src/desktop main process, native helper, vault, recovery, agent connectors.
// Usage: node scripts/foto-fitur.mjs   (spawns the local Electron binary hidden, then exits)
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "tmp-migan", "foto-fitur");
export const LABEL = "render terisolasi dari kode live b4ea5de, bukan tangkapan app pemilik";

export function windowOptions(preload) {
  return {
    show: false,
    width: 1280,
    height: 820,
    skipTaskbar: true,
    focusable: false,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      offscreen: true,
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: "foto-fitur-tmp",
    },
  };
}

// Everything except local files is cancelled: no provider, no Ollama, no web.
export function blockDecision(url) {
  return { cancel: !String(url).startsWith("file:") };
}

export function makeUserDataPath(id) {
  return path.join(path.resolve(os.tmpdir()), "migango-foto-fitur-" + id);
}

export function forbiddenPath(p) {
  return /[\\/]roaming[\\/]migan-workbench/i.test(String(p));
}

export function assertSafeUserData(p) {
  const tmp = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
  if (forbiddenPath(p) || !path.resolve(p).toLowerCase().startsWith(tmp))
    throw Error("unsafe userData path: " + p);
  return p;
}

export function visibleCount(windows) {
  return windows.filter((w) => w.isVisible()).length;
}

const now = Date.UTC(2026, 9, 28, 3, 0, 0);
const RUN_ID = "run-foto-0001";
export const FIXTURE = {
  settings: {
    workspace: "C:\\contoh\\proyek-foto",
    language: "id",
    provider: "anthropic",
    model: "claude-sonnet-fixture",
    modelRegistry: [],
    credentialInfo: [],
  },
  history: [
    // Same shape as the real history list: ISO `created`, `title`, `status`.
    { id: RUN_ID, status: "running", title: "Rapikan laporan penjualan Oktober", created: new Date(now).toISOString() },
  ],
  // Same shape as a saved run record (storage.saveRun): prompt, profile, workspace and
  // tool-start/tool-result events paired by id (the UI only renders `tool-*` events).
  run: {
    id: RUN_ID,
    status: "running",
    title: "Rapikan laporan penjualan Oktober",
    prompt: "Rapikan laporan penjualan Oktober",
    created: new Date(now).toISOString(),
    workspace: "C:\\contoh\\proyek-foto",
    profile: { provider: "anthropic", model: "claude-sonnet-fixture" },
    usage: { inputTokens: 18200, outputTokens: 2400, cost: 0.07, costNote: "US$0,07 (perkiraan)" },
    events: [
      { type: "tool-start", id: "t1", name: "read_file", args: { path: "data/penjualan.csv" } },
      { type: "tool-result", id: "t1", name: "read_file", ok: true, content: "142 baris dibaca" },
      { type: "turn-usage", turn: 1 },
      { type: "tool-start", id: "t2", name: "write_file", args: { path: "laporan/oktober.md" } },
      { type: "agen.pemakaian", cost: 0.07 },
    ],
  },
  recovery: [
    {
      id: "hold-aman-0001", kind: "write_file", reason: "process-restart", pid: 0,
      // 06u4: same shape as src/recovery/periksa-hold.mjs output (tugas is an object).
      periksa: { rekomendasi: "aman-diakui", tugas: { judul: "Tulis ringkasan rapat", tujuan: "Simpan ringkasan rapat ke catatan" }, langkahTerakhir: "Menulis catatan/rapat.md", perintahTerputus: { alat: "write_file", dimulai: false, selesaiTerbukti: false }, berkasBerubah: [], prosesSisa: 0, alasan: [], catatan: "Tidak ada berkas berubah dan tidak ada proses tersisa." },
    },
    {
      id: "hold-cek-0002", kind: "shell", reason: "process-restart", pid: 4242,
      periksa: { rekomendasi: "periksa-dulu", tugas: { judul: "Bangun situs contoh", tujuan: "Jalankan build situs" }, langkahTerakhir: "Menjalankan npm run build", perintahTerputus: { alat: "shell", dimulai: true, selesaiTerbukti: false }, berkasBerubah: ["dist/index.html"], prosesSisa: 1, alasan: ["perintah sudah jalan tanpa bukti selesai", "1 proses masih hidup"], catatan: "" },
    },
  ],
  // 06u4: same shape as muatApaYangBaru() in src/desktop/whats-new-ipc.mjs.
  whatsNew: {
    versiApp: "0.1.0-alpha.21",
    berkas: "docs/RIWAYAT-VERSI.md",
    saatIniDitemukan: true,
    bagian: [
      { versi: "0.1.0-alpha.21", tanggal: "2026-10-28", isi: "- Kartu HOLD berbahasa awam\n- Panel Sedang dikerjakan\n- Jejak kerja per langkah", saatIni: true },
      { versi: "0.1.0-alpha.20", tanggal: "2026-10-27", isi: "- Meteran biaya OpenAI dan Kimi", saatIni: false },
    ],
  },
};

// Stub preload: same method names as the real preload, answers from FIXTURE, no IPC.
export function stubPreloadSource(methodNames, fixture = FIXTURE) {
  return `"use strict";
const { contextBridge } = require("electron");
const F = ${JSON.stringify(fixture)};
const log = [];
const answers = {
  settings: () => F.settings, saveSettings: (s) => ({ ...F.settings, ...s }),
  history: () => F.history, loadRun: () => F.run,
  recoveryList: () => F.recovery, recoveryHoldsAll: () => F.recovery.map((j) => ({ ...j, workspace: F.settings.workspace })),
  recoveryInspect: (id) => F.recovery.find((j) => j.id === id) || null,
  whatsNew: () => F.whatsNew, agentStatus: () => [], agentCatalog: () => ({ cards: [] }),
  employeeProfiles: () => [], files: () => [], skills: () => [], memory: () => ({ records: [] }),
  improvementList: () => [], researchList: () => [], browserSnapshot: () => ({ url: "about:blank", title: "" }),
  listDirectory: () => [], browserLayout: () => null, browserNavigate: () => { throw new Error("jaringan diblok dalam foto-fitur"); },
};
const api = {};
for (const name of ${JSON.stringify(methodNames)}) {
  if (/^on[A-Z]/.test(name)) { api[name] = () => () => {}; continue; }
  api[name] = async (...args) => {
    log.push(name);
    if (answers[name]) return answers[name](...args);
    throw new Error("fixture: " + name + " tidak tersedia dalam render terisolasi");
  };
}
api.__fotoLog = () => log.slice();
contextBridge.exposeInMainWorld("workbench", Object.freeze(api));
`;
}

export function preloadMethodNames(text) {
  const names = [...text.matchAll(/^ {4}(\w+): \(/gm)].map((m) => m[1]);
  if (names.length < 20) throw Error("preload method list not found");
  return names;
}

// Each state: navigate with the same handlers the owner clicks, then look for key text.
// Settings shape that showSettingsData reads; no key values, every slot unconfigured.
const SETTINGS_KOSONG = {
  active: "anthropic",
  configured: { openai: false, anthropic: false, kimi: false, gemini: false, runpod: false },
  profiles: { openai: { model: "" }, anthropic: { model: "", workspaceId: "" }, kimi: { model: "" }, ollama: { model: "", baseURL: "" } },
  routes: { light: "", coding: "" },
  routeMap: {},
  taskModels: [],
  builtinPrices: [],
  modelPrices: {},
  maxTurns: 25,
  devRoots: [],
  memoryEnabled: false,
  mcp: [],
  credentialInfo: [],
};

// Per-state settings override on top of FIXTURE; states without one get the base fixture.
// Every state gets the publicSettings shape (06u3): the old partial stub lacked `profiles`,
// which made showSettingsData throw "reading 'openai'" — a stub artefact, not an app bug.
// 06u35: ui/app.js opens #settingsDialog at startup when the active provider is unconfigured,
// so the all-false SETTINGS_KOSONG (meant for f-koneksi-gemini) covered every other state.
// Base states mark only the active provider configured (a flag, no key); f overrides it back.
const SETTINGS_DASAR = { ...SETTINGS_KOSONG, configured: { ...SETTINGS_KOSONG.configured, anthropic: true } };
export function fixtureFor(state) {
  return { ...FIXTURE, settings: { ...SETTINGS_DASAR, ...FIXTURE.settings, ...(state?.settings || {}) } };
}

export const STATES = [
  { name: "a-sedang-dikerjakan", fixture: "history running + loadRun (langkah, alat, biaya)", nav: [], keys: ["Sedang dikerjakan", "Rapikan laporan penjualan Oktober"] },
  { name: "b-kartu-hold", fixture: "recoveryList: aman-diakui + periksa-dulu", nav: ["recovery", "open:recoveryList"], keys: ["HOLD", "Tulis ringkasan rapat", "Bangun situs contoh"] },
  { name: "c-apa-yang-baru", fixture: "whatsNew: alpha.21", nav: ["text:Apa yang baru"], keys: ["Apa yang baru", "Kartu HOLD berbahasa awam"] },
  { name: "d-jejak-kerja", fixture: "loadRun run-foto-0001", nav: ["text:Rapikan laporan penjualan Oktober", "activity"], keys: ["read_file", "write_file"] },
  { name: "e-browser", fixture: "browserSnapshot about:blank", nav: ["browser"], keys: ["browserPane"] },
  {
    name: "f-koneksi-gemini",
    fixture: "settings lengkap, configured.gemini=false, tanpa kunci",
    settings: SETTINGS_KOSONG,
    modal: "settingsDialog",
    nav: ["#settingsBtn", "open:geminiConfigured"],
    // RunPod shows the same empty text, so the check is scoped to the Gemini element by id.
    keys: ["#geminiConfigured|Kosong: belum ada kunci tersimpan.", "geminiKey"],
  },
];

function clickScript(target) {
  return `(() => {
    const t = ${JSON.stringify(target)};
    let el = null;
    if (t.startsWith("open:")) {
      // Open every closed <details> around the element and bring it into view; no click.
      const target = document.getElementById(t.slice(5));
      if (!target) return "tidak ditemukan";
      for (let p = target.parentElement; p; p = p.parentElement) if (p.tagName === "DETAILS") p.open = true;
      target.scrollIntoView({ block: "center" });
      return "dibuka: " + t.slice(5);
    }
    if (t.startsWith("#")) el = document.getElementById(t.slice(1));
    else if (t.startsWith("text:")) {
      const want = t.slice(5);
      el = [...document.querySelectorAll("button, a, summary, [role=tab], [data-nav]")].find((e) => e.offsetParent !== null && e.textContent.includes(want))
        || [...document.querySelectorAll("button, a, summary, [role=tab], [data-nav]")].find((e) => e.textContent.includes(want));
    } else {
      el = document.querySelector('[data-nav="' + t + '"]') || document.querySelector('[data-view="' + t + '"]') || document.querySelector('[data-tab="' + t + '"]');
    }
    if (!el) return "tidak ditemukan";
    el.click();
    return "diklik: " + (el.id || el.dataset.nav || el.textContent.trim().slice(0, 40));
  })()`;
}

// 06u35: a key is "terlihat" only if its element exists, its centre lies in the viewport with a
// non-zero box, and elementFromPoint at that centre returns the element or a descendant.
// Self-contained (no outer references): it is serialised into the page with toString().
export function classifyKey(k, doc, win) {
  const describe = (e) => !e ? "(kosong)" : e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (!e.id && typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/)[0] : "");
  let candidates = [];
  if (k.startsWith("#") && k.includes("|")) {
    const el = doc.getElementById(k.slice(1, k.indexOf("|")));
    if (el && el.textContent.includes(k.slice(k.indexOf("|") + 1))) candidates = [el];
  } else {
    const byId = doc.getElementById(k);
    if (byId) candidates = [byId];
    else {
      // Deepest elements whose text contains the key (no child element also contains it).
      const hits = [...doc.body.querySelectorAll("*")].filter((e) => (e.textContent || "").includes(k));
      candidates = hits.filter((e) => ![...e.children].some((c) => (c.textContent || "").includes(k)));
    }
  }
  const rank = { "terlihat": 3, "ada-tapi-tertutup": 2, "di-luar-viewport": 1, "tidak-ada": 0 };
  let best = { key: k, status: "tidak-ada", detail: candidates.length ? "ukuran 0 atau tersembunyi" : "tidak ada di DOM" };
  for (const el of candidates) {
    let r;
    const b = el.getBoundingClientRect();
    if (el.hidden || !(b.width > 0) || !(b.height > 0)) r = { key: k, status: "tidak-ada", detail: "ukuran 0 atau tersembunyi" };
    else {
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      if (cx < 0 || cy < 0 || cx >= win.innerWidth || cy >= win.innerHeight) r = { key: k, status: "di-luar-viewport", detail: "tengah di " + Math.round(cx) + "," + Math.round(cy) };
      else {
        const hit = doc.elementFromPoint(cx, cy);
        if (hit && (hit === el || el.contains(hit))) r = { key: k, status: "terlihat", elemen: describe(el) };
        else {
          let dlg = hit;
          while (dlg && dlg.tagName !== "DIALOG") dlg = dlg.parentElement;
          r = { key: k, status: "ada-tapi-tertutup", elemen: describe(el), penutup: describe(dlg || hit) };
        }
      }
    }
    if (rank[r.status] > rank[best.status] || (best.status === "tidak-ada" && r.status === "tidak-ada")) best = r;
    if (best.status === "terlihat") break;
  }
  return best;
}

// Open <dialog>s other than the state's own modal: a clean state must have none.
export function unexpectedModals(doc, allowed) {
  return [...doc.querySelectorAll("dialog[open]")].map((d) => d.id || "(tanpa id)").filter((id) => id !== allowed);
}

export function formatKey(r) {
  if (r.status === "terlihat") return "terlihat";
  if (r.status === "ada-tapi-tertutup") return "ada-tapi-tertutup (penutup: " + r.penutup + ")";
  return r.status + (r.detail ? " (" + r.detail + ")" : "");
}

export function keyScript(keys) {
  return `(() => { const classifyKey = ${classifyKey.toString()};
    return ${JSON.stringify(keys)}.map((k) => classifyKey(k, document, window)); })()`;
}

async function runInElectron() {
  const { app, BrowserWindow, dialog, session } = await import("electron");
  const id = process.pid + "-" + Date.now();
  const userData = assertSafeUserData(makeUserDataPath(id));
  const log = { label: LABEL, userData, paths: [], requests: [], blocked: [], errors: [], visible: [], forbiddenHits: [] };
  // Error dialogs would appear on the owner's screen: log instead.
  dialog.showErrorBox = (title, content) => log.errors.push(String(title) + ": " + String(content));
  process.on("uncaughtException", (e) => log.errors.push("uncaught: " + e.message));
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData);
  app.setPath("sessionData", userData);
  app.setPath("crashDumps", path.join(userData, "crash"));
  app.disableHardwareAcceleration();
  const results = [];
  // Each state destroys its window; without this listener Electron quits when the last window
  // closes, aborting the next loadURL with ERR_FAILED (-2). The runner quits explicitly at the end.
  app.on("window-all-closed", () => process.stderr.write("window-all-closed: no auto-quit\n"));
  // A dying renderer/GPU process makes loadURL reject with ERR_FAILED (-2); log the real cause.
  app.on("child-process-gone", (_e, d) => { log.errors.push("child-process-gone " + d.type + " " + d.reason + " exit=" + d.exitCode); writeReport(results, log); });
  app.on("render-process-gone", (_e, _wc, d) => { log.errors.push("render-process-gone " + d.reason + " exit=" + d.exitCode); writeReport(results, log); });
  try {
    await app.whenReady();
    for (const key of ["userData", "sessionData", "temp", "logs", "crashDumps"]) {
      try { log.paths.push(key + "=" + app.getPath(key)); } catch (e) { log.errors.push("getPath " + key + ": " + e.message); }
    }
    const ses = session.fromPartition("foto-fitur-tmp");
    for (const s of [ses, session.defaultSession])
      s.webRequest.onBeforeRequest((details, done) => {
        const d = blockDecision(details.url);
        (d.cancel ? log.blocked : log.requests).push(details.url);
        done(d);
      });
    const stubDir = path.join(userData, "stub");
    mkdirSync(stubDir, { recursive: true });
    const methodNames = preloadMethodNames(readFileSync(path.join(root, "src", "desktop", "preload.cjs"), "utf8"));
    mkdirSync(outDir, { recursive: true });
    for (const state of STATES) {
      // One stub per state, inside the temp userData, so a settings override stays local to it.
      const stub = path.join(stubDir, "preload-stub-" + state.name + ".cjs");
      writeFileSync(stub, stubPreloadSource(methodNames, fixtureFor(state)));
      // One state failing must not hide the others; each failure is logged with its cause.
      const win = new BrowserWindow(windowOptions(stub));
      try {
      let consoleLines = 0;
      win.webContents.on("console-message", (...a) => { const m = a[0]?.message ?? a[2]; if (consoleLines++ < 8) log.errors.push(state.name + " console: " + String(m).slice(0, 300)); });
      win.webContents.on("did-fail-load", (_e, code, desc, url) => log.errors.push(state.name + " did-fail-load " + code + " " + desc + " " + url));
      win.webContents.on("will-navigate", (_e, url) => log.errors.push(state.name + " will-navigate " + url));
      win.webContents.on("preload-error", (_e, p, err) => log.errors.push(state.name + " preload-error " + err.message));
      await win.loadURL(pathToFileURL(path.join(root, "ui", "index.html")).href);
      await new Promise((r) => setTimeout(r, 1500));
      const clicks = [];
      for (const n of state.nav) {
        clicks.push(await win.webContents.executeJavaScript(clickScript(n)));
        await new Promise((r) => setTimeout(r, 900));
      }
      const keys = await win.webContents.executeJavaScript(keyScript(state.keys));
      // A clean state has no open dialog except its own modal; anything else is logged, not hidden.
      const modals = await win.webContents.executeJavaScript(`(() => { const unexpectedModals = ${unexpectedModals.toString()}; return unexpectedModals(document, ${JSON.stringify(state.modal || "")}); })()`);
      if (modals.length) log.errors.push(state.name + ": dialog tak terduga terbuka: " + modals.join(", "));
      const visible = visibleCount(BrowserWindow.getAllWindows());
      log.visible.push(state.name + "=" + visible);
      if (visible !== 0) throw Error("visible window detected; stopping");
      const image = await win.webContents.capturePage();
      const file = path.join(outDir, state.name + ".png");
      writeFileSync(file, image.toPNG());
      const calls = await win.webContents.executeJavaScript("window.workbench.__fotoLog()");
      results.push({ ...state, clicks, keys, file, bytes: image.toPNG().length, calls });
      } catch (e) {
        // Visibility breach is a hard stop for the whole run; other failures are per state.
        if (/visible window/.test(e.message)) throw e;
        log.errors.push(state.name + ": " + e.message);
      } finally {
        if (!win.isDestroyed()) win.destroy();
        // Flush after every state so a later crash still leaves this evidence on disk.
        log.forbiddenHits = [...log.paths, ...log.requests, userData].filter(forbiddenPath);
        writeReport(results, log);
      }
    }
  } catch (e) {
    log.errors.push("run: " + e.message);
  }
  const touched = [...log.paths, ...log.requests, userData];
  log.forbiddenHits = touched.filter(forbiddenPath);
  writeReport(results, log);
  app.quit();
  // Temp profile removed after Electron releases it (see parent process too).
  setTimeout(() => { try { rmSync(userData, { recursive: true, force: true }); } catch (e) { console.error("rm userData: " + e.message); } app.exit(0); }, 500);
}

function writeReport(results, log) {
  mkdirSync(outDir, { recursive: true });
  const lines = ["# Laporan foto fitur 06u1", "", "Label: " + LABEL + ".", "", "Bukan foto layar pemilik. Data dari fixture, bukan data aplikasi.", ""];
  for (const r of results) {
    lines.push("## " + r.name, "", "- Fixture: " + r.fixture, "- Navigasi: " + (r.clicks.length ? r.clicks.join("; ") : "tanpa klik (Beranda)"));
    // 06u35: one of terlihat / ada-tapi-tertutup / di-luar-viewport / tidak-ada, from a hit-test.
    for (const k of r.keys) lines.push("- Teks kunci `" + k.key + "`: " + formatKey(k));
    lines.push("- Berkas: " + path.relative(root, r.file).replaceAll("\\", "/") + " (" + r.bytes + " byte)", "- API stub yang dipanggil: " + [...new Set(r.calls)].join(", "), "");
  }
  lines.push("## Isolasi", "", "- userData sementara: " + log.userData + " (dihapus sesudah run)");
  for (const p of log.paths) lines.push("- path: " + p);
  lines.push("- Path yang memuat Roaming\\migan-workbench: " + log.forbiddenHits.length);
  lines.push("- Jendela terlihat per keadaan: " + log.visible.join(", "));
  lines.push("- Permintaan file: diizinkan: " + log.requests.length + "; permintaan non-file diblok: " + log.blocked.length);
  for (const b of [...new Set(log.blocked)].slice(0, 20)) lines.push("  - diblok: " + b);
  lines.push("- Batas: log path hanya mencakup app.getPath dan URL yang dimuat, bukan pemantauan sistem berkas penuh.", "", "## Galat", "");
  for (const e of log.errors.length ? log.errors : ["(tidak ada)"]) lines.push("- " + e);
  writeFileSync(path.join(outDir, "LAPORAN.md"), lines.join("\n") + "\n");
  writeFileSync(path.join(outDir, "log.json"), JSON.stringify({ log, results: results.map(({ file, ...r }) => r) }, null, 2));
}

async function launchFromNode() {
  const require = (await import("node:module")).createRequire(import.meta.url);
  const electronBin = require("electron");
  if (typeof electronBin !== "string" || !existsSync(electronBin)) throw Error("electron binary not found");
  // A stale report from an earlier run must never pass for this run's result.
  rmSync(path.join(outDir, "LAPORAN.md"), { force: true });
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "", FOTO_FITUR_RUN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBin, [fileURLToPath(import.meta.url)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  const keep = (d) => { tail = (tail + d).slice(-4000); };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const timer = setTimeout(() => { console.error("timeout: stopping electron"); child.kill(); }, 50000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  console.log("electron exit " + code);
  if (tail.trim()) console.log(tail.slice(-1500));
  const report = path.join(outDir, "LAPORAN.md");
  const exitLine = "\n## Proses Electron\n\n- Kode keluar: " + code + " (0x" + (Number(code) >>> 0).toString(16) + ")\n";
  if (existsSync(report)) appendFileSync(report, exitLine + "- Ekor stderr: " + tail.slice(-600).replace(/\s+/g, " ") + "\n");
  else writeFileSync(report, "# Laporan foto fitur 06u1\n\nLaporan tidak ditulis Electron sebelum keluar.\n" + exitLine);
  console.log("laporan: " + path.relative(root, report));
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.versions.electron && process.env.FOTO_FITUR_RUN === "1") runInElectron();
  else if (!process.versions.electron) launchFromNode().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
