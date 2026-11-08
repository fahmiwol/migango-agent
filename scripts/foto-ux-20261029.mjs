// UX photos 29 Oct 2026 (fixes U1, U5, U2, mode hint). Reuses the isolation of scripts/foto-fitur.mjs:
// renderer only (ui/index.html) with a stub preload, hidden offscreen window, network blocked, temp
// userData. Never touches the live app. Host events (start / usage / finish) are SIMULATED by firing
// fixture events into the renderer's onEvent handler; they are not a real model run.
// Usage: node scripts/foto-ux-20261029.mjs
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  windowOptions, blockDecision, makeUserDataPath, assertSafeUserData, visibleCount, fixtureFor, FIXTURE,
  stubPreloadSource, preloadMethodNames, classifyKey, formatKey, forbiddenPath, LABEL,
} from "./foto-fitur.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const outDir = path.join(root, "tmp-migan", "foto-ux-20261029");
const RUN_ID = "run-foto-0001";
const NEXT = "anthropic / claude-sonnet-fixture";
// Outer size is 3px short of the target: the hidden offscreen window reports content 3px wider (measured: viewport nyata in the report).
const WIDTHS = [{ name: "1280", width: 1277, height: 900 }, { name: "599", width: 596, height: 900 }];

const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return "tidak ditemukan"; e.click(); return ${JSON.stringify("diklik: " + sel)}; })()`;
const fire = (ev) => `(() => { window.workbench.__fire(${JSON.stringify(ev)}); return ${JSON.stringify("event: " + ev.type)}; })()`;
// Bring the deepest element holding the text into view first: a text below the fold is judged only
// after scrolling there, the way a user would; the hit-test itself is unchanged (classifyKey).
const scrollTo = (k) => `(() => { const hits = [...document.body.querySelectorAll("*")].filter((e) => (e.textContent || "").includes(${JSON.stringify(k)}));
  const el = hits.filter((e) => ![...e.children].some((c) => (c.textContent || "").includes(${JSON.stringify(k)})))[0];
  if (el) el.scrollIntoView({ block: "center" }); return !!el; })()`;
const keyScriptOne = (k) => `(() => { const classifyKey = ${classifyKey.toString()}; return classifyKey(${JSON.stringify(k)}, document, window); })()`;

const STEPS = [
  { name: "01-beranda-awal", act: [], keys: [
    "Model berikutnya: " + NEXT, "AI membaca dan menjawab, tanpa mengubah berkas.", "Periksa hasil sebelum dipakai.",
    "Asal: Kamu", "Tujuan: Rapikan laporan penjualan Oktober", "Sekarang: Menulis perubahan.",
    "Giliran ke-1; batas belum diketahui.", "Perkiraan biaya sejauh ini US$0.07." ] },
  { name: "02-mode-kerjakan", act: [click('[data-mode="work"]')], keys: ["AI mengusulkan perubahan; kamu memberi izin sebelum diterapkan."] },
  { name: "03-tugas-berjalan", act: [
    fire({ type: "start", id: RUN_ID, profile: { provider: "kimi", model: "kimi-k2.6" } }),
    fire({ type: "agen.pemakaian", runId: RUN_ID, v: 1, turn: 1, inputTokens: 120, outputTokens: 40, inputBytes: 360, inputBudget: 4000, estimatedInputTokens: 120, requestLimit: 8000, limitNote: "", cost: 0.0123, costNote: "x" }),
  ], keys: ["Model berikutnya: " + NEXT, "Model tugas ini: kimi / kimi-k2.6", "Perkiraan biaya sejauh ini US$0.0123.", "Sedang bekerja. Mode bisa diganti setelah tugas berhenti."] },
  { name: "04-tugas-selesai", act: [
    fire({ type: "finish", runId: RUN_ID, status: "responded", profile: { provider: "kimi", model: "kimi-k2.6" }, usage: { input: 120, output: 40, cached: 0, cacheCreated: 0 } }),
  ], keys: ["Model berikutnya: " + NEXT, "Perkiraan biaya tugas ini US$0.0123."] },
  { name: "05-bahasa-inggris", act: [click("#langBtn")], keys: ["Next model: " + NEXT, "Review results before using.", "Estimated task cost: US$0.0123.", "AI proposes changes; you approve before they are applied."] },
];

export function patchStub(source) {
  const a = "if (/^on[A-Z]/.test(name)) { api[name] = () => () => {}; continue; }";
  const b = "api.__fotoLog = () => log.slice();";
  if (!source.includes(a) || !source.includes(b)) throw Error("stub preload shape changed");
  return source
    .replace(" files: () => [],", " files: () => ({ files: [], truncated: false }),")
    .replace(a, "if (/^on[A-Z]/.test(name)) { api[name] = (cb) => { handlers.push(cb); return () => {}; }; continue; }")
    .replace("const api = {};", "const api = {}; const handlers = [];")
    .replace(b, b + " api.__fire = (e) => { handlers.forEach((h) => h(e)); };");
}

async function runInElectron() {
  const { app, BrowserWindow, dialog, session } = await import("electron");
  const userData = assertSafeUserData(makeUserDataPath(process.pid + "-" + Date.now()));
  const log = { userData, requests: [], blocked: [], errors: [], visible: [], forbidden: [] };
  dialog.showErrorBox = (t, c) => log.errors.push(t + ": " + c);
  mkdirSync(userData, { recursive: true });
  app.setPath("userData", userData); app.setPath("sessionData", userData); app.setPath("crashDumps", path.join(userData, "crash"));
  app.disableHardwareAcceleration();
  app.on("window-all-closed", () => {});
  const results = [];
  try {
    await app.whenReady();
    const ses = session.fromPartition("foto-fitur-tmp");
    for (const s of [ses, session.defaultSession])
      s.webRequest.onBeforeRequest((d, done) => { const x = blockDecision(d.url); (x.cancel ? log.blocked : log.requests).push(d.url); done(x); });
    const stubDir = path.join(userData, "stub");
    mkdirSync(stubDir, { recursive: true });
    mkdirSync(outDir, { recursive: true });
    const names = preloadMethodNames(readFileSync(path.join(root, "src", "desktop", "preload.cjs"), "utf8"));
    const fixture = fixtureFor({ settings: { profiles: { openai: { model: "" }, anthropic: { model: "claude-sonnet-fixture", workspaceId: "" }, kimi: { model: "" }, ollama: { model: "", baseURL: "" } } } });
    const stub = path.join(stubDir, "preload-stub-ux.cjs");
    writeFileSync(stub, patchStub(stubPreloadSource(names, fixture)));
    for (const size of WIDTHS) {
      const win = new BrowserWindow({ ...windowOptions(stub), width: size.width, height: size.height, useContentSize: true, enableLargerThanScreen: true });
      try {
        win.webContents.on("console-message", (...a) => { if (log.errors.length < 20) log.errors.push(size.name + " console: " + String(a[0]?.message ?? a[2]).slice(0, 200) + " @" + String(a[0]?.sourceId ?? a[4]).split("/").pop() + ":" + (a[0]?.lineNumber ?? a[3])); });
        await win.loadURL(pathToFileURL(path.join(root, "ui", "index.html")).href);
        await new Promise((r) => setTimeout(r, 1500));
        for (const step of STEPS) {
          const acts = [];
          for (const a of step.act) { acts.push(await win.webContents.executeJavaScript(a)); await new Promise((r) => setTimeout(r, 700)); }
          const keys = [];
          for (const k of step.keys) {
            await win.webContents.executeJavaScript(scrollTo(k));
            await new Promise((r) => setTimeout(r, 150));
            keys.push(await win.webContents.executeJavaScript(keyScriptOne(k)));
          }
          // Extra facts: the Rincian parts are closed, the mode buttons carry aria-pressed.
          const facts = await win.webContents.executeJavaScript(`(() => ({
            rincianTertutup: [...document.querySelectorAll("details.usage-detail, details.sedang-rincian")].map((d) => d.open === false),
            ariaPressed: [...document.querySelectorAll("[data-mode]")].map((b) => b.dataset.mode + "=" + b.getAttribute("aria-pressed")),
            horizontalScroll: document.documentElement.scrollWidth > window.innerWidth,
            viewport: window.innerWidth + "x" + window.innerHeight,
            wide: (() => { const c = document.getElementById("chatWorkspace"); const r = c.getBoundingClientRect().right; return [...c.querySelectorAll("*")].filter((e) => e.getBoundingClientRect().right > r + 1 && e.getBoundingClientRect().width > 0).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "." + String(e.className).split(" ")[0]) + ":" + Math.round(e.getBoundingClientRect().right - r)).slice(0, 6); })(),
            innerHScroll: [...document.querySelectorAll("body *")].filter((e) => e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0 && /(auto|scroll)/.test(getComputedStyle(e).overflowX)).map((e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "." + String(e.className).split(" ")[0])).slice(0, 6),
          }))()`);
          if (visibleCount(BrowserWindow.getAllWindows()) !== 0) throw Error("visible window detected; stopping");
          // Photo 1: the last key scrolled into view (where the fix lives); photo 2: top of the page.
          const png = (await win.webContents.capturePage()).toPNG();
          const file = path.join(outDir, step.name + "-" + size.name + ".png");
          writeFileSync(file, png);
          await win.webContents.executeJavaScript("document.querySelectorAll('*').forEach((e) => { if (e.scrollTop) e.scrollTop = 0; }); window.scrollTo(0,0)");
          await new Promise((r) => setTimeout(r, 150));
          writeFileSync(path.join(outDir, step.name + "-" + size.name + "-atas.png"), (await win.webContents.capturePage()).toPNG());
          results.push({ step: step.name, width: size.name, viewport: size.width + "x" + size.height, acts, keys, facts, file, bytes: png.length });
        }
      } catch (e) {
        log.errors.push(size.name + ": " + e.message);
      } finally {
        if (!win.isDestroyed()) win.destroy();
      }
    }
  } catch (e) { log.errors.push("run: " + e.message); }
  log.forbidden = [userData, ...log.requests].filter(forbiddenPath);
  const lines = ["# Laporan foto UX 29 Okt 2026", "", "Label: " + LABEL + ".", "",
    "Render terisolasi dari kode di folder ini; data fixture; event tugas (mulai, pemakaian, selesai) DISIMULASIKAN lewat handler onEvent, bukan jalan model sungguhan.",
    "Terlihat = tengah elemen berada di viewport dan document.elementFromPoint di tengah itu mengembalikan elemen atau anaknya (elemen digulir ke tengah dulu).", ""];
  for (const r of results) {
    lines.push("## " + r.step + " @ " + r.viewport, "", "- Aksi: " + (r.acts.join("; ") || "tanpa aksi"));
    for (const k of r.keys) lines.push("- `" + k.key + "`: " + formatKey(k));
    lines.push("- Rincian tertutup: " + r.facts.rincianTertutup.join(",") + "; aria-pressed: " + r.facts.ariaPressed.join(", ") + "; gulir mendatar halaman: " + r.facts.horizontalScroll + "; viewport nyata: " + r.facts.viewport + "; gulir mendatar di dalam: " + (r.facts.innerHScroll.join(", ") || "tidak ada") + (r.facts.innerHScroll.length ? "; melewati tepi: " + r.facts.wide.join(", ") : ""));
    lines.push("- Berkas: " + path.relative(root, r.file).replaceAll("\\", "/") + " (" + r.bytes + " byte)", "");
  }
  lines.push("## Batas", "", "- Jalan tugas, biaya dan akhir tugas adalah event simulasi; tidak ada panggilan model dan tidak ada tangkapan app pemilik.", "- Isi Rincian tidak dibuka di foto (tertutup sejak awal, sesuai spek); hanya tombol Rincian yang dinilai terlihat.", "- Kartu Sedang dikerjakan di foto memakai fixture riwayat (status running); langkah dan biaya dari fixture, bukan data nyata.", "- Hanya lebar 1280 dan 599 (tinggi 817 terbatas jendela terisolasi); lebar 900 tidak difoto.", "- Foto bernama -atas = awal halaman; tanpa akhiran = elemen kunci terakhir digulir ke tengah.", "", "## Isolasi", "", "- userData sementara (dihapus sesudah run): " + userData, "- Path Roaming\\migan-workbench tersentuh: " + log.forbidden.length,
    "- Permintaan file diizinkan: " + log.requests.length + "; non-file diblok: " + log.blocked.length, "", "## Galat", "");
  for (const e of log.errors.length ? log.errors : ["(tidak ada)"]) lines.push("- " + e);
  writeFileSync(path.join(outDir, "LAPORAN.md"), lines.join("\n") + "\n");
  writeFileSync(path.join(outDir, "log.json"), JSON.stringify({ log, results: results.map(({ file, ...r }) => r) }, null, 2));
  app.quit();
  setTimeout(() => { try { rmSync(userData, { recursive: true, force: true }); } catch {} app.exit(0); }, 500);
}

async function launchFromNode() {
  const require = (await import("node:module")).createRequire(import.meta.url);
  const bin = require("electron");
  if (typeof bin !== "string" || !existsSync(bin)) throw Error("electron binary not found");
  rmSync(path.join(outDir, "LAPORAN.md"), { force: true });
  const env = { ...process.env, FOTO_UX_RUN: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(bin, [fileURLToPath(import.meta.url)], { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const timer = setTimeout(() => child.kill(), 90000);
  const code = await new Promise((r) => child.on("exit", r));
  clearTimeout(timer);
  console.log("electron exit " + code + "; laporan: tmp-migan/foto-ux-20261029/LAPORAN.md");
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.versions.electron && process.env.FOTO_UX_RUN === "1") runInElectron();
  else if (!process.versions.electron) launchFromNode().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
