#!/usr/bin/env node
// Benchmark polos vs backbone miganGO (RISET-013, pra-daftar evals/backbone/pra-daftar.json).
// Pemakaian pemilik (Ollama lokal, tanpa biaya):
//   node scripts/backbone.mjs --model <nama-dari-ollama-list>
// Plafon (berbayar, maks 10 tugas, pagu US$1, harga diisi pemilik, kunci dari variabel lingkungan
// MIGAN_BENCH_ANTHROPIC_KEY yang diisi pemilik sendiri; skrip tidak membaca vault aplikasi):
//   node scripts/backbone.mjs --model <kecil> --plafon-model <sonnet> --izinkan-plafon --harga-input <US$/1M> --harga-output <US$/1M>
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { muatSet, jalankanPolos, jalankanBackbone, nilai, biaya, laporan, pilihPlafon, BATAS } from "../src/eval/backbone.mjs";
import { buatPanggil, profilBenchmark, PENYEDIA } from "../src/eval/backbone-penyedia.mjs";

export const PAGU_PLAFON_USD = 1;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function bacaArgumen(argv) {
  const a = { penyedia: "ollama", model: null, ulangan: 3, plafon: false, plafonModel: null, harga: null, keluar: "tmp-migan/backbone-hasil.json", baseURL: "http://127.0.0.1:11434" };
  let izin = false, hin, hout;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => { const x = argv[++i]; if (x === undefined) throw new Error(k + " butuh nilai"); return x; };
    if (k === "--model") a.model = v();
    else if (k === "--penyedia") a.penyedia = v();
    else if (k === "--ulangan") a.ulangan = Number(v());
    else if (k === "--plafon-model") a.plafonModel = v();
    else if (k === "--izinkan-plafon") izin = true;
    else if (k === "--harga-input") hin = Number(v());
    else if (k === "--harga-output") hout = Number(v());
    else if (k === "--keluar") a.keluar = v();
    else if (k === "--base-url") a.baseURL = v();
    else throw new Error("argumen tidak dikenal: " + k);
  }
  if (!a.model) throw new Error("--model wajib (lihat node scripts/ollama-daftar.mjs)");
  if (!PENYEDIA.includes(a.penyedia)) throw new Error("penyedia tidak didukung: " + a.penyedia);
  if (!Number.isSafeInteger(a.ulangan) || a.ulangan < 1 || a.ulangan > 10) throw new Error("ulangan harus 1-10");
  if (a.plafonModel) {
    if (!izin) throw new Error("plafon berbayar: tambahkan --izinkan-plafon");
    if (!Number.isFinite(hin) || !Number.isFinite(hout) || hin < 0 || hout < 0) throw new Error("plafon butuh --harga-input dan --harga-output (US$ per 1 juta token) dari pemilik");
    a.plafon = true;
    a.harga = { input: hin, output: hout };
  }
  return a;
}

// Biaya terburuk sebelum ada panggilan: ~3 byte per token masuk (+200 untuk sistem), maxTokens keluar penuh.
export function estimasiPlafon(tugas, harga, maxTokens) {
  let usd = 0;
  for (const t of tugas) {
    const bytes = Buffer.byteLength(t.prompt) + Object.entries(t.berkas || {}).reduce((s, [p, isi]) => s + Buffer.byteLength(p) + Buffer.byteLength(isi) + 10, 0);
    usd += Math.ceil((bytes + 200) / 3) * harga.input + maxTokens * harga.output;
  }
  return usd / 1e6;
}

export async function jalankanBenchmark({ set, ulangan, panggilKecil, penyedia, plafon = null, catat = () => {} }) {
  if (plafon) {
    const tugasPlafon = pilihPlafon(set, plafon.ids);
    const est = estimasiPlafon(tugasPlafon, plafon.harga, plafon.maxTokens);
    if (!(est <= PAGU_PLAFON_USD)) throw new Error("estimasi plafon US$" + est.toFixed(4) + " melewati pagu US$" + PAGU_PLAFON_USD);
  }
  const hasil = [];
  const simpan = (t, lengan, ul, r, pny, harga) => {
    const v = nilai(t, r);
    const h = { id: t.id, kategori: t.kategori, lengan, ulangan: ul, lulus: v.lulus, alasan: v.alasan, panggilan: r.panggilan, usage: r.usage, ms: r.ms, biaya: biaya(pny, r.usage, harga), ...(r.galat ? { galat: String(r.galat).slice(0, 200) } : {}) };
    hasil.push(h);
    catat(h);
  };
  for (let ul = 1; ul <= ulangan; ul++)
    for (const t of set.tugas) {
      simpan(t, "polos", ul, await jalankanPolos(t, panggilKecil), penyedia, null);
      simpan(t, "backbone", ul, await jalankanBackbone(t, panggilKecil), penyedia, null);
    }
  if (plafon)
    for (const t of pilihPlafon(set, plafon.ids)) simpan(t, "plafon", 1, await jalankanPolos(t, plafon.panggil, { maxTokens: plafon.maxTokens }), "anthropic", plafon.harga);
  return { hasil, laporan: laporan(hasil, { subsetPlafon: plafon?.ids || [] }) };
}

async function utama(argv) {
  const a = bacaArgumen(argv);
  const pra = JSON.parse((await import("node:fs")).readFileSync(resolve(ROOT, "evals/backbone/pra-daftar.json"), "utf8"));
  const set = muatSet(resolve(ROOT, pra.setTugas));
  const kunciKecil = a.penyedia === "ollama" ? undefined : process.env["MIGAN_BENCH_" + a.penyedia.toUpperCase() + "_KEY"];
  const panggilKecil = buatPanggil({ profile: profilBenchmark(a.penyedia, a.model, a.baseURL), key: kunciKecil });
  const plafon = a.plafon ? { ids: pra.subsetPlafon, harga: a.harga, maxTokens: BATAS.maxTokens, panggil: buatPanggil({ profile: profilBenchmark("anthropic", a.plafonModel), key: process.env.MIGAN_BENCH_ANTHROPIC_KEY }) } : null;
  const out = await jalankanBenchmark({ set, ulangan: a.ulangan, panggilKecil, penyedia: a.penyedia, plafon, catat: (h) => console.log(h.lengan.padEnd(8), h.id.padEnd(26), "u" + h.ulangan, h.lulus ? "LULUS" : "gagal", h.ms + "ms", h.galat ? "galat" : "") });
  const keluar = resolve(ROOT, a.keluar);
  mkdirSync(dirname(keluar), { recursive: true });
  writeFileSync(keluar, JSON.stringify({ eksperimen: pra.eksperimen, penyedia: a.penyedia, model: a.model, plafonModel: a.plafonModel, ulangan: a.ulangan, tanggal: new Date().toISOString(), ...out }, null, 1));
  const L = out.laporan;
  console.log("\nkategori  n  polos  backbone  kenaikan");
  for (const [k, v] of Object.entries(L.kategori)) console.log(k.padEnd(9), String(v.n).padEnd(2), String(v.polos).padEnd(6), String(v.backbone).padEnd(9), v.kenaikan);
  console.log("total    ", L.total.n, L.total.polos, L.total.backbone, L.total.kenaikan, "CI95", L.total.ci.join(".."));
  console.log("vonis", JSON.stringify(L.vonis), "biaya", JSON.stringify(L.biaya), "\nhasil:", a.keluar);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  utama(process.argv.slice(2)).catch((e) => { console.error("galat:", e.message); process.exitCode = 1; });
