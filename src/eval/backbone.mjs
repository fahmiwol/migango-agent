// Benchmark polos vs backbone miganGO (RISET-013, pra-daftar evals/backbone/pra-daftar.json).
// Model-agnostik: kedua lengan hanya menerima `panggil(req)`:
//   req   = { system, messages, tools, maxTokens }
//   pesan = { role: "user"|"assistant"|"tool", content, toolCalls?, callId?, name? }
//   balas = { text, calls: [{ id, name, args }], usage: { input, output } }
// Adaptor penyedia (Ollama, Anthropic, OpenAI, Kimi) ada di luar modul ini.
// Alat bekerja di atas fixture dalam memori: tidak ada akses disk, jaringan, atau shell.
import { readFileSync } from "node:fs";

export const KATEGORI = ["koding", "riset", "konten", "operasi", "data"];
export const ROUTER = Object.freeze({
  koding: ["daftar_berkas", "baca_berkas", "cari_teks", "hitung"],
  riset: ["cari_dokumen", "baca_berkas", "daftar_berkas"],
  konten: ["baca_berkas", "cek_teks"],
  operasi: ["daftar_berkas", "baca_berkas", "cari_teks", "hitung"],
  data: ["baca_berkas", "tabel", "hitung"],
});
export const BATAS = Object.freeze({ maksAlat: 4, maksUlang: 2, anggaranKonteks: 12000, maxTokens: 512 });
export const POTONG_ALAT = 1200; // pra-daftar: hasil alat dipotong 1200 karakter
const KUNCI_NILAI = ["jawabanCocok", "jawabanMemuat", "dilarangCocok", "sumberWajib", "maksKata", "maksKarakter", "wajibKata", "butirTepat"];

export function validasiSet(set) {
  if (!set || !Array.isArray(set.tugas) || set.tugas.length === 0) throw new Error("set tanpa tugas");
  const ids = new Set();
  for (const t of set.tugas) {
    if (!t.id || typeof t.prompt !== "string") throw new Error("tugas tanpa id/prompt");
    if (ids.has(t.id)) throw new Error("id ganda: " + t.id);
    ids.add(t.id);
    if (!KATEGORI.includes(t.kategori)) throw new Error("kategori tidak dikenal: " + t.kategori);
    if (!t.nilai || !KUNCI_NILAI.some((k) => k in t.nilai)) throw new Error("tugas tanpa nilai: " + t.id);
    if (t.berkas && typeof t.berkas !== "object") throw new Error("berkas harus objek: " + t.id);
  }
  return set;
}

export function muatSet(file) {
  return validasiSet(JSON.parse(readFileSync(file, "utf8")));
}

const kata = (s) => s.trim().split(/\s+/).filter(Boolean);
const butir = (s) => s.split(/\r?\n/).filter((l) => /^\s*[-*•]\s+\S/.test(l)).length;
const re = (p) => new RegExp(p, "i");

// Penilai deterministik. Kunci jawaban tidak pernah dikirim ke model.
export function nilai(t, r) {
  const final = String(r?.final ?? "").trim();
  const alasan = [];
  if (!final) return { lulus: false, alasan: ["kosong"] };
  const n = t.nilai;
  const low = final.toLowerCase();
  for (const p of n.jawabanCocok || []) if (!re(p).test(final)) alasan.push("tidak cocok " + p);
  for (const s of n.jawabanMemuat || []) if (!low.includes(s.toLowerCase())) alasan.push("tidak memuat " + s);
  for (const p of n.dilarangCocok || []) if (re(p).test(final)) alasan.push("dilarang " + p);
  const sumber = (r.sumber || []).map((s) => String(s).trim());
  for (const s of n.sumberWajib || []) if (!sumber.includes(s) && !final.includes(s)) alasan.push("tanpa sumber " + s);
  if (n.maksKata && kata(final).length > n.maksKata) alasan.push("terlalu banyak kata");
  if (n.maksKarakter && final.length > n.maksKarakter) alasan.push("terlalu panjang");
  for (const w of n.wajibKata || []) if (!low.includes(w.toLowerCase())) alasan.push("tanpa kata " + w);
  if (n.butirTepat && butir(final) !== n.butirTepat) alasan.push("jumlah butir salah");
  return { lulus: alasan.length === 0, alasan };
}

// ---------- alat deterministik ----------
export function hitungAman(ekspresi) {
  const s = String(ekspresi).replace(/\s+/g, "");
  if (!/^[0-9.+\-*/^()]+$/.test(s)) throw new Error("hanya angka dan + - * / ^ ( )");
  let i = 0;
  const angka = () => {
    const m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
    if (!m) throw new Error("ekspresi tidak sah");
    i += m[0].length;
    return Number(m[0]);
  };
  const faktor = () => {
    if (s[i] === "-") { i++; return -faktor(); }
    if (s[i] === "+") { i++; return faktor(); }
    let v;
    if (s[i] === "(") { i++; v = jumlah(); if (s[i] !== ")") throw new Error("kurung tidak tertutup"); i++; } else v = angka();
    if (s[i] === "^") { i++; v = v ** faktor(); }
    return v;
  };
  const kali = () => { let v = faktor(); while (s[i] === "*" || s[i] === "/") { const o = s[i++]; const b = faktor(); v = o === "*" ? v * b : v / b; } return v; };
  const jumlah = () => { let v = kali(); while (s[i] === "+" || s[i] === "-") { const o = s[i++]; const b = kali(); v = o === "+" ? v + b : v - b; } return v; };
  const v = jumlah();
  if (i !== s.length || !Number.isFinite(v)) throw new Error("ekspresi tidak sah");
  return Math.round(v * 1e9) / 1e9;
}

const token = (s) => (String(s).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
export function cariDokumen(berkas, kueri, k = 3) {
  const docs = Object.entries(berkas || {}).map(([path, isi]) => ({ path, tok: token(path + " " + isi) }));
  const q = [...new Set(token(kueri))];
  const N = docs.length || 1;
  const skor = docs.map((d) => {
    let s = 0;
    for (const w of q) {
      const tf = d.tok.filter((x) => x === w).length;
      if (!tf) continue;
      const df = docs.filter((e) => e.tok.includes(w)).length;
      s += (tf / (tf + 1.2)) * Math.log(1 + N / df);
    }
    return { path: d.path, skor: Math.round(s * 1000) / 1000 };
  });
  return skor.filter((x) => x.skor > 0).sort((a, b) => b.skor - a.skor || a.path.localeCompare(b.path)).slice(0, k);
}

function csv(isi) {
  const [kepala, ...baris] = isi.trim().split(/\r?\n/).map((l) => l.split(","));
  return baris.map((b) => Object.fromEntries(kepala.map((h, j) => [h.trim(), (b[j] ?? "").trim()])));
}

function agregat(op, xs) {
  if (op === "hitung") return xs.length;
  if (!xs.length) return null;
  if (op === "jumlah") return xs.reduce((a, b) => a + b, 0);
  if (op === "rata") return Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1e6) / 1e6;
  if (op === "maks") return Math.max(...xs);
  if (op === "min") return Math.min(...xs);
  if (op === "median") { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  throw new Error("operasi tidak dikenal: " + op);
}

const SPEK = {
  daftar_berkas: { description: "Daftar path berkas di workspace tugas.", parameters: { type: "object", properties: {} } },
  baca_berkas: { description: "Baca isi berkas dengan nomor baris (format n|baris).", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  cari_teks: { description: "Cari teks literal di semua berkas; hasil path:baris:isi.", parameters: { type: "object", properties: { pola: { type: "string" } }, required: ["pola"] } },
  hitung: { description: "Hitung ekspresi aritmetika (+ - * / ^ kurung).", parameters: { type: "object", properties: { ekspresi: { type: "string" } }, required: ["ekspresi"] } },
  cari_dokumen: { description: "Cari dokumen paling relevan untuk kueri; hasil path dan skor.", parameters: { type: "object", properties: { kueri: { type: "string" } }, required: ["kueri"] } },
  cek_teks: { description: "Hitung kata, karakter dan butir '- ' dari sebuah teks draf.", parameters: { type: "object", properties: { teks: { type: "string" } }, required: ["teks"] } },
  tabel: {
    description: "Agregasi CSV. operasi: jumlah|rata|median|maks|min|hitung. kali: kolom pengali opsional. filterKolom/filterNilai opsional. kelompok: kolom grup opsional.",
    parameters: { type: "object", properties: { path: { type: "string" }, operasi: { type: "string" }, kolom: { type: "string" }, kali: { type: "string" }, filterKolom: { type: "string" }, filterNilai: { type: "string" }, kelompok: { type: "string" } }, required: ["path", "operasi"] },
  },
};

export function buatAlat(t) {
  const berkas = t.berkas || {};
  const nama = ROUTER[t.kategori];
  const ambil = (p) => (Object.hasOwn(berkas, p) ? berkas[p] : null);
  const impl = {
    daftar_berkas: () => Object.keys(berkas).join("\n") || "(kosong)",
    baca_berkas: ({ path }) => { const isi = ambil(path); return isi == null ? "berkas tidak ada: " + path : isi.split("\n").map((l, j) => j + 1 + "|" + l).join("\n"); },
    cari_teks: ({ pola }) => {
      const out = [];
      for (const [p, isi] of Object.entries(berkas)) isi.split("\n").forEach((l, j) => { if (pola && l.includes(pola)) out.push(p + ":" + (j + 1) + ":" + l); });
      return out.join("\n") || "tidak ditemukan";
    },
    hitung: ({ ekspresi }) => String(hitungAman(ekspresi)),
    cari_dokumen: ({ kueri }) => JSON.stringify(cariDokumen(berkas, kueri, 3)),
    cek_teks: ({ teks }) => JSON.stringify({ kata: kata(String(teks)).length, karakter: String(teks).trim().length, butir: butir(String(teks)) }),
    tabel: ({ path, operasi, kolom, kali, filterKolom, filterNilai, kelompok }) => {
      const isi = ambil(path);
      if (isi == null) return "berkas tidak ada: " + path;
      let rows = csv(isi);
      if (filterKolom) rows = rows.filter((r) => String(r[filterKolom]).toLowerCase() === String(filterNilai ?? "").toLowerCase());
      const nilaiBaris = (r) => Number(r[kolom]) * (kali ? Number(r[kali]) : 1);
      if (operasi !== "hitung" && !(kolom in (rows[0] || {}))) return "kolom tidak ada: " + kolom;
      if (kelompok) {
        const g = {};
        for (const r of rows) (g[r[kelompok]] ||= []).push(nilaiBaris(r));
        return JSON.stringify({ hasil: Object.fromEntries(Object.entries(g).map(([k, xs]) => [k, agregat(operasi, xs)])) });
      }
      return JSON.stringify({ hasil: agregat(operasi, rows.map(nilaiBaris)) });
    },
  };
  return {
    spek: nama.map((n) => ({ name: n, ...SPEK[n] })),
    jalankan(n, args = {}) {
      if (!nama.includes(n)) return "alat tidak tersedia: " + n;
      try { return impl[n](args || {}); } catch (e) { return "galat: " + e.message; }
    },
  };
}

// ---------- skema keluaran + verifier (hanya batasan publik, bukan kunci) ----------
export function uraiJawaban(text) {
  const s = String(text || "");
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const o = JSON.parse(s.slice(a, b + 1));
    if (!o || typeof o !== "object" || o.jawaban == null) return null;
    return { jawaban: String(o.jawaban), sumber: Array.isArray(o.sumber) ? o.sumber.map(String) : [] };
  } catch { return null; }
}

export function verifikasi(t, p) {
  const masalah = [];
  if (!p || typeof p.jawaban !== "string") return { ok: false, masalah: ["keluaran harus JSON {\"jawaban\": string, \"sumber\": [path]}"] };
  const j = p.jawaban.trim();
  if (!j) masalah.push("jawaban kosong");
  if (t.format && !new RegExp(t.format).test(j)) masalah.push("format jawaban harus cocok " + t.format);
  const b = t.batasan || {};
  if (b.maksKata && kata(j).length > b.maksKata) masalah.push("maksimal " + b.maksKata + " kata, sekarang " + kata(j).length);
  if (b.maksKarakter && j.length > b.maksKarakter) masalah.push("maksimal " + b.maksKarakter + " karakter, sekarang " + j.length);
  for (const w of b.wajibKata || []) if (!j.toLowerCase().includes(w.toLowerCase())) masalah.push("wajib memuat " + w);
  if (b.butirTepat && butir(j) !== b.butirTepat) masalah.push("harus tepat " + b.butirTepat + " butir '- ', sekarang " + butir(j));
  if (t.kategori === "riset") {
    if (!p.sumber.length) masalah.push("sumber wajib diisi path berkas");
    for (const s of p.sumber) if (!Object.hasOwn(t.berkas || {}, s)) masalah.push("sumber tidak ada di workspace: " + s);
  }
  return { ok: masalah.length === 0, masalah };
}

// ---------- memori kerja: compaction pesan alat lama ----------
export function padatkan(messages, anggaran = BATAS.anggaranKonteks) {
  const out = messages.map((m) => ({ ...m }));
  for (let i = 1; i < out.length - 1 && JSON.stringify(out).length > anggaran; i++) {
    const m = out[i];
    if (m.role === "tool" && !String(m.content).startsWith("[dipadatkan")) {
      m.content = "[dipadatkan: " + String(m.content).length + " karakter dari " + (m.name || "alat") + "; panggil ulang bila perlu]";
    }
  }
  return out;
}

const tambahUsage = (a, u) => ({ input: a.input + (Number(u?.input) || 0), output: a.output + (Number(u?.output) || 0) });
const isiBerkas = (berkas) => Object.entries(berkas || {}).map(([p, isi]) => "=== " + p + " ===\n" + isi).join("\n");

// Lengan polos: satu panggilan, tanpa alat, berkas disisipkan apa adanya.
export async function jalankanPolos(t, panggil, opsi = {}) {
  const mulai = Date.now();
  const konten = t.prompt + (Object.keys(t.berkas || {}).length ? "\n\nBerkas:\n" + isiBerkas(t.berkas) : "");
  try {
    const r = await panggil({ system: "Jawab singkat dan tepat.", messages: [{ role: "user", content: konten }], tools: [], maxTokens: opsi.maxTokens || BATAS.maxTokens });
    return { final: String(r.text || "").trim(), sumber: [], panggilan: 1, usage: tambahUsage({ input: 0, output: 0 }, r.usage), ms: Date.now() - mulai };
  } catch (e) {
    return { final: "", sumber: [], panggilan: 1, usage: { input: 0, output: 0 }, ms: Date.now() - mulai, galat: e.message };
  }
}
const SISTEM_BACKBONE = "Kamu agen miganGO. Pakai alat untuk memeriksa fakta dan menghitung; jangan menebak. " +
  "Jawaban akhir HANYA JSON satu baris: {\"jawaban\": \"...\", \"sumber\": [\"path berkas\"]}. Isi jawaban persis sesuai format yang diminta.";

// Lengan backbone: rencana -> retrieval -> loop alat (router) -> skema JSON -> verifier mengulang; compaction tiap giliran.
export async function jalankanBackbone(t, panggil, opsi = {}) {
  const mulai = Date.now();
  const batas = { ...BATAS, ...opsi.batas };
  const alat = buatAlat(t);
  let usage = { input: 0, output: 0 };
  let panggilan = 0, ulangVerifier = 0, alatDipakai = 0, upaya = 0;
  let terakhir = null;
  const jejak = [];
  const panggilCatat = async (req) => { panggilan++; const r = await panggil(req); usage = tambahUsage(usage, r.usage); return r; };
  const hasil = (galat) => ({
    final: terakhir?.jawaban?.trim() ?? "", sumber: terakhir?.sumber ?? [], panggilan, ulangVerifier, alatDipakai, usage, ms: Date.now() - mulai, jejak, ...(galat ? { galat } : {}),
  });
  try {
    const temu = cariDokumen(t.berkas, t.prompt, 3);
    const konteks = temu.length ? "Berkas paling relevan (retrieval): " + temu.map((x) => x.path).join(", ") : "Tidak ada berkas.";
    const rencanaR = await panggilCatat({
      system: "Pecah tugas menjadi 2-4 langkah singkat. Balas JSON {\"langkah\": [\"...\"]}.",
      messages: [{ role: "user", content: t.prompt + "\n\n" + konteks + "\nSemua berkas: " + (Object.keys(t.berkas || {}).join(", ") || "-") }],
      tools: [], maxTokens: 200,
    });
    let langkah = [];
    try {
      const s = String(rencanaR.text || "");
      const o = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
      if (Array.isArray(o.langkah)) langkah = o.langkah.slice(0, 4).map(String);
    } catch { /* rencana opsional; model kecil sering gagal JSON */ }
    jejak.push({ rencana: langkah });
    const potongan = temu.map((x) => "=== " + x.path + " ===\n" + String(t.berkas[x.path]).slice(0, 1500)).join("\n");
    const messages = [{ role: "user", content: t.prompt + (langkah.length ? "\n\nRencana:\n- " + langkah.join("\n- ") : "") + "\n\n" + konteks + (potongan ? "\n" + potongan : "") }];
    for (;;) {
      const bolehAlat = alatDipakai < batas.maksAlat;
      const r = await panggilCatat({ system: SISTEM_BACKBONE, messages: padatkan(messages, batas.anggaranKonteks), tools: bolehAlat ? alat.spek : [], maxTokens: batas.maxTokens });
      const calls = bolehAlat ? (r.calls || []) : [];
      if (calls.length) {
        alatDipakai++;
        messages.push({ role: "assistant", content: r.text || "", toolCalls: calls });
        for (const c of calls) {
          jejak.push({ alat: c.name });
          messages.push({ role: "tool", callId: c.id, name: c.name, content: String(alat.jalankan(c.name, c.args)).slice(0, POTONG_ALAT) });
        }
        continue;
      }
      const p = uraiJawaban(r.text);
      if (p) terakhir = p;
      const v = verifikasi(t, p);
      jejak.push({ verifikasi: v.ok, masalah: v.masalah });
      if (v.ok || upaya >= batas.maksUlang) break;
      upaya++;
      ulangVerifier++;
      messages.push({ role: "assistant", content: String(r.text || "") });
      messages.push({ role: "user", content: "Verifier menolak: " + v.masalah.join("; ") + ". Perbaiki dan balas JSON saja." });
    }
    return hasil();
  } catch (e) {
    return hasil(e.message);
  }
}
// ---------- plafon, biaya, laporan ----------
export const MAKS_PLAFON = 10;
export function pilihPlafon(set, ids) {
  if (!Array.isArray(ids) || ids.length > MAKS_PLAFON) throw new Error("plafon maksimal " + MAKS_PLAFON + " tugas");
  return ids.map((id) => {
    const t = set.tugas.find((x) => x.id === id);
    if (!t) throw new Error("id plafon tidak dikenal: " + id);
    return t;
  });
}

// Harga per 1 juta token dari pemilik; tanpa harga = null (tidak menebak).
export function biaya(penyedia, usage, harga) {
  if (penyedia === "ollama") return 0;
  if (!harga || !Number.isFinite(harga.input) || !Number.isFinite(harga.output)) return null;
  return Math.round(((usage.input || 0) * harga.input + (usage.output || 0) * harga.output) / 1e6 * 1e6) / 1e6;
}

const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
const rata = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function acak(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
export function bootstrapCI(selisih, sampel = 2000, seed = 1) {
  if (!selisih.length) return [null, null];
  const rnd = acak(seed), n = selisih.length, m = [];
  for (let s = 0; s < sampel; s++) { let j = 0; for (let i = 0; i < n; i++) j += selisih[Math.floor(rnd() * n)]; m.push(j / n); }
  m.sort((a, b) => a - b);
  return [r3(m[Math.floor(0.025 * sampel)]), r3(m[Math.ceil(0.975 * sampel) - 1])];
}

// Skor per tugas = rata-rata lulus atas ulangan; skor lengan = rata-rata skor per tugas.
function perTugas(hasil, lengan) {
  const g = new Map();
  for (const h of hasil) if (h.lengan === lengan) { if (!g.has(h.id)) g.set(h.id, { kategori: h.kategori, xs: [] }); g.get(h.id).xs.push(h.lulus ? 1 : 0); }
  return g;
}

export function laporan(hasil, opsi = {}) {
  const P = perTugas(hasil, "polos"), B = perTugas(hasil, "backbone"), C = perTugas(hasil, "plafon");
  const ids = [...B.keys()].filter((id) => P.has(id));
  const skor = (M, id) => rata(M.get(id).xs);
  const kategori = {};
  for (const k of KATEGORI) {
    const ks = ids.filter((id) => B.get(id).kategori === k);
    if (!ks.length) continue;
    const p = rata(ks.map((id) => skor(P, id))), b = rata(ks.map((id) => skor(B, id)));
    kategori[k] = { n: ks.length, polos: r3(p), backbone: r3(b), kenaikan: r3(b - p) };
  }
  const selisih = ids.map((id) => skor(B, id) - skor(P, id));
  const tp = rata(ids.map((id) => skor(P, id))), tb = rata(ids.map((id) => skor(B, id)));
  const total = { n: ids.length, polos: r3(tp), backbone: r3(tb), kenaikan: r3(tb - tp), ci: bootstrapCI(selisih) };
  const passK = {};
  for (const [nama, M] of [["polos", P], ["backbone", B]]) passK[nama] = r3(rata(ids.map((id) => (M.get(id).xs.every(Boolean) ? 1 : 0))));
  const subset = (opsi.subsetPlafon || []).filter((id) => C.has(id) && B.has(id));
  const sc = rata(subset.map((id) => skor(C, id))), sb = rata(subset.map((id) => skor(B, id)));
  const plafon = { n: subset.length, plafon: r3(sc), backbone: r3(sb), rasio: sc ? r3(sb / sc) : null };
  const waktu = {}, ongkos = {}, panggilan = {};
  for (const lengan of ["polos", "backbone", "plafon"]) {
    const hs = hasil.filter((h) => h.lengan === lengan);
    if (!hs.length) continue;
    const ms = hs.map((h) => h.ms || 0);
    waktu[lengan] = { median: median(ms), total: ms.reduce((a, b) => a + b, 0) };
    const bs = hs.map((h) => h.biaya);
    ongkos[lengan] = bs.some((x) => x == null) ? null : r3(bs.reduce((a, b) => a + b, 0) * 1000) / 1000;
    panggilan[lengan] = r3(rata(hs.map((h) => h.panggilan || 1)));
  }
  const naikKat = Object.values(kategori).filter((k) => k.kenaikan >= 0).length;
  const vonis = {
    H1: total.kenaikan >= 0.15 && total.ci[0] > 0,
    H2: naikKat >= 4,
    H3: plafon.rasio == null ? null : plafon.rasio >= 0.8,
    H4: waktu.polos && waktu.backbone ? waktu.backbone.median <= 6 * waktu.polos.median : null,
  };
  // Pilot 20 tugas: tidak pernah klaim umum (batasKlaim pra-daftar).
  return { kategori, total, passK, plafon, waktu, biaya: ongkos, panggilan, vonis, klaimUmum: false };
}
