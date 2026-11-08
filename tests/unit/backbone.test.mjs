// Benchmark polos vs backbone (RISET-013). Model palsu berskrip; tanpa jaringan.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  muatSet, validasiSet, nilai, ROUTER, buatAlat, hitungAman, cariDokumen,
  verifikasi, jalankanPolos, jalankanBackbone, laporan, pilihPlafon, biaya, padatkan,
} from "../../src/eval/backbone.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const SET = muatSet(root + "/evals/backbone/v1.json");
const tugas = (id) => SET.tugas.find((t) => t.id === id);

test("set v1 valid: 20 tugas, 5 kategori x 4, id unik", () => {
  assert.equal(SET.tugas.length, 20);
  const per = {};
  for (const t of SET.tugas) per[t.kategori] = (per[t.kategori] || 0) + 1;
  assert.deepEqual(per, { koding: 4, riset: 4, konten: 4, operasi: 4, data: 4 });
});

test("validasiSet menolak id ganda, kategori asing, dan tugas tanpa nilai", () => {
  const t = { id: "a", kategori: "koding", prompt: "p", berkas: {}, nilai: { jawabanMemuat: ["x"] } };
  assert.throws(() => validasiSet({ tugas: [t, { ...t }] }), /ganda/);
  assert.throws(() => validasiSet({ tugas: [{ ...t, kategori: "lain" }] }), /kategori/);
  assert.throws(() => validasiSet({ tugas: [{ ...t, nilai: {} }] }), /nilai/);
});

test("penilai: jawaban benar lulus, salah gagal, kosong gagal", () => {
  const k = tugas("koding-nilai-fungsi");
  assert.equal(nilai(k, { final: "38250", sumber: [] }).lulus, true);
  assert.equal(nilai(k, { final: "45000", sumber: [] }).lulus, false);
  assert.equal(nilai(k, { final: "", sumber: [] }).lulus, false);
});

test("penilai: sumber wajib, dilarang, batas kata/karakter/butir", () => {
  const r = tugas("riset-harga-berlaku");
  assert.equal(nilai(r, { final: "Rp129.000", sumber: ["docs/harga-2026.md"] }).lulus, true);
  assert.equal(nilai(r, { final: "Rp129.000 (docs/harga-2026.md)", sumber: [] }).lulus, true, "sumber boleh di teks");
  assert.equal(nilai(r, { final: "Rp129.000", sumber: [] }).lulus, false, "tanpa sumber");
  assert.equal(nilai(r, { final: "Rp129.000, dulu Rp99.000", sumber: ["docs/harga-2026.md"] }).lulus, false, "dilarang");
  const j = tugas("konten-judul-rapat");
  assert.equal(nilai(j, { final: "Rapat Tim Senin Pukul 09.00", sumber: [] }).lulus, true);
  assert.equal(nilai(j, { final: "Mohon hadir rapat tim kita pada hari Senin pukul 09.00 tepat", sumber: [] }).lulus, false);
  assert.equal(nilai(j, { final: "Rapat Tim Selasa 09.00", sumber: [] }).lulus, false);
  const b = tugas("konten-ringkas-butir");
  assert.equal(nilai(b, { final: "- Anggaran naik 10%\n- Jadwal mundur dua minggu\n- Vendor baru dipilih", sumber: [] }).lulus, true);
  assert.equal(nilai(b, { final: "- Anggaran naik\n- Jadwal mundur", sumber: [] }).lulus, false);
  const s = tugas("konten-subjek-email");
  assert.equal(nilai(s, { final: "Pengingat: INV-2047 jatuh tempo besok", sumber: [] }).lulus, true);
  assert.equal(nilai(s, { final: "Pengingat: INV-2047 jatuh tempo besok, mohon segera dibayar ya terima kasih", sumber: [] }).lulus, false);
});

test("kunci jawaban set v1 sendiri lulus (solusi acuan)", () => {
  const acuan = {
    "koding-nilai-fungsi": "38250", "koding-cari-fungsi": "src/util/teks.js", "koding-baris-bug": "3",
    "koding-versi-dependensi": "3.23.8", "riset-cuti-kontrak": "10 hari", "riset-uang-harian": "Rp350.000",
    "riset-node-minimal": "Node 18", "riset-harga-berlaku": "Rp129.000", "konten-judul-rapat": "Rapat Tim Senin 09.00",
    "konten-ringkas-butir": "- anggaran naik\n- jadwal mundur\n- vendor baru", "konten-subjek-email": "INV-2047 jatuh tempo",
    "konten-tabel-kalimat": "Kopi paling banyak terjual dengan 340 unit.", "operasi-hitung-error": "3",
    "operasi-port-tls": "8443", "operasi-izin-perintah": "B", "operasi-jadwal-cron": "02.30 Senin",
    "data-pendapatan-jawa": "270000", "data-wilayah-terbanyak": "Jawa", "data-rata-unit": "7.4", "data-median": "78",
  };
  for (const t of SET.tugas) {
    const sumber = t.nilai.sumberWajib || [];
    assert.equal(nilai(t, { final: acuan[t.id], sumber }).lulus, true, t.id);
  }
});

test("router: tiap kategori punya alat, alat hanya dari set yang dikenal", () => {
  for (const k of ["koding", "riset", "konten", "operasi", "data"]) assert.ok(ROUTER[k].length > 0, k);
  const a = buatAlat(tugas("riset-cuti-kontrak"));
  assert.deepEqual(a.spek.map((s) => s.name).sort(), [...ROUTER.riset].sort());
  assert.match(a.jalankan("tabel", {}), /tidak tersedia/);
});

test("alat hanya membaca fixture, tidak membaca disk", () => {
  const a = buatAlat(tugas("koding-baris-bug"));
  assert.match(a.jalankan("baca_berkas", { path: "src/rata.js" }), /3\| {2}for/);
  assert.match(a.jalankan("baca_berkas", { path: "../package.json" }), /tidak ada/);
  assert.match(a.jalankan("baca_berkas", { path: root + "/package.json" }), /tidak ada/);
});

test("hitungAman: aritmetika benar, menolak kode", () => {
  assert.equal(hitungAman("12000*3 + 4500*2"), 45000);
  assert.equal(hitungAman("(12+7+5+9+4)/5"), 7.4);
  assert.equal(hitungAman("-2^3"), -8);
  assert.throws(() => hitungAman("process.exit(1)"));
  assert.throws(() => hitungAman("1+"));
});

test("alat tabel menjumlah dengan filter dan perkalian kolom", () => {
  const a = buatAlat(tugas("data-pendapatan-jawa"));
  const out = JSON.parse(a.jalankan("tabel", { path: "penjualan.csv", operasi: "jumlah", kolom: "unit", kali: "harga", filterKolom: "wilayah", filterNilai: "Jawa" }));
  assert.equal(out.hasil, 270000);
  const m = JSON.parse(buatAlat(tugas("data-median")).jalankan("tabel", { path: "nilai.csv", operasi: "median", kolom: "nilai" }));
  assert.equal(m.hasil, 78);
  const g = JSON.parse(a.jalankan("tabel", { path: "penjualan.csv", operasi: "jumlah", kolom: "unit", kelompok: "wilayah" }));
  assert.deepEqual(g.hasil, { Jawa: 17, Bali: 11, Sumatra: 9 });
});

test("retrieval: dokumen relevan peringkat pertama", () => {
  const top = cariDokumen(tugas("riset-node-minimal").berkas, "Node minimal versi 2.4", 3);
  assert.equal(top[0].path, "docs/catatan-rilis-v2.md");
});

test("verifier: JSON, format publik, batasan publik, sumber riset harus ada di berkas", () => {
  const k = tugas("koding-nilai-fungsi");
  assert.equal(verifikasi(k, { jawaban: "38250", sumber: [] }).ok, true);
  assert.equal(verifikasi(k, { jawaban: "38.250 rupiah", sumber: [] }).ok, false);
  const r = tugas("riset-cuti-kontrak");
  assert.equal(verifikasi(r, { jawaban: "10", sumber: [] }).ok, false);
  assert.equal(verifikasi(r, { jawaban: "10", sumber: ["docs/karangan.md"] }).ok, false);
  assert.equal(verifikasi(r, { jawaban: "10", sumber: ["docs/kebijakan-lembur.md"] }).ok, true, "verifier tidak tahu kunci");
  const j = tugas("konten-judul-rapat");
  assert.equal(verifikasi(j, { jawaban: "Satu dua tiga empat lima enam tujuh delapan sembilan Senin 09.00", sumber: [] }).ok, false);
  assert.equal(verifikasi(k, null).ok, false);
});

function skrip(langkah) {
  const log = [];
  const panggil = async (req) => {
    log.push(req);
    const s = langkah.shift();
    if (!s) throw new Error("skrip habis");
    return { text: s.text || "", calls: s.calls || [], usage: { input: 10, output: 5 }, message: { role: "assistant", content: s.text || "", toolCalls: s.calls || [] } };
  };
  return { panggil, log };
}

test("polos: satu panggilan, tanpa alat, berkas disisipkan", async () => {
  const { panggil, log } = skrip([{ text: "38250" }]);
  const r = await jalankanPolos(tugas("koding-nilai-fungsi"), panggil);
  assert.equal(log.length, 1);
  assert.ok(!log[0].tools || log[0].tools.length === 0);
  assert.match(log[0].messages[0].content, /Math\.floor/);
  assert.equal(r.final, "38250");
  assert.equal(r.panggilan, 1);
  assert.deepEqual(r.usage, { input: 10, output: 5 });
});

test("backbone: rencana, alat, jawaban JSON, verifier mengulang lalu lulus", async () => {
  const { panggil, log } = skrip([
    { text: '{"langkah":["hitung kotor","kurangi diskon"]}' },
    { calls: [{ id: "c1", name: "hitung", args: { ekspresi: "45000 - 6750" } }] },
    { text: '{"jawaban":"38.250 rupiah","sumber":[]}' },
    { text: '{"jawaban":"38250","sumber":["src/harga.js"]}' },
  ]);
  const r = await jalankanBackbone(tugas("koding-nilai-fungsi"), panggil);
  assert.equal(r.final, "38250");
  assert.equal(nilai(tugas("koding-nilai-fungsi"), r).lulus, true);
  assert.equal(r.panggilan, 4);
  assert.equal(r.ulangVerifier, 1);
  assert.ok(log[1].tools.some((t) => t.name === "hitung"), "alat dari router");
  const toolMsg = log[2].messages.find((m) => m.role === "tool");
  assert.equal(toolMsg.content, "38250");
  assert.match(log[0].messages[0].content, /src\/harga\.js/, "retrieval disisipkan");
});

test("backbone: ulang verifier dibatasi 2, loop alat dibatasi 4", async () => {
  const salah = { text: '{"jawaban":"bukan angka","sumber":[]}' };
  const { panggil } = skrip([{ text: "rencana bukan json" }, salah, salah, salah, salah, salah]);
  const r = await jalankanBackbone(tugas("koding-nilai-fungsi"), panggil);
  assert.equal(r.ulangVerifier, 2);
  assert.equal(r.panggilan, 4);
  const terus = Array.from({ length: 10 }, (_, i) => ({ calls: [{ id: "c" + i, name: "daftar_berkas", args: {} }] }));
  const s2 = skrip([{ text: "{}" }, ...terus]);
  const r2 = await jalankanBackbone(tugas("koding-cari-fungsi"), s2.panggil);
  assert.ok(r2.panggilan <= 1 + 4 + 1 + 2, "rencana + 4 alat + final + 2 ulang");
});

test("backbone: galat model dihitung gagal, bukan dibuang", async () => {
  const panggil = async () => { throw new Error("koneksi putus"); };
  const r = await jalankanBackbone(tugas("koding-nilai-fungsi"), panggil);
  assert.equal(r.galat, "koneksi putus");
  assert.equal(nilai(tugas("koding-nilai-fungsi"), r).lulus, false);
});

test("compaction: pesan alat lama dipadatkan saat melewati anggaran", () => {
  const msgs = [{ role: "user", content: "tugas" }];
  for (let i = 0; i < 6; i++) msgs.push({ role: "tool", callId: "c" + i, name: "baca_berkas", content: "x".repeat(1000) });
  const p = padatkan(msgs, 3000);
  assert.equal(p[0].content, "tugas");
  assert.ok(JSON.stringify(p).length <= 3000 + 600);
  assert.match(p[1].content, /dipadatkan/);
  assert.equal(p.at(-1).content.length, 1000, "pesan terbaru utuh");
});

test("laporan: per kategori per lengan, kenaikan, pass^k, rasio plafon", () => {
  const hasil = [];
  for (const t of SET.tugas) for (let u = 0; u < 3; u++) {
    hasil.push({ id: t.id, kategori: t.kategori, lengan: "polos", lulus: false, ms: 10, usage: { input: 1, output: 1 }, biaya: 0 });
    hasil.push({ id: t.id, kategori: t.kategori, lengan: "backbone", lulus: t.kategori !== "konten", ms: 40, usage: { input: 2, output: 2 }, biaya: 0 });
  }
  for (const id of ["koding-nilai-fungsi", "riset-cuti-kontrak"]) hasil.push({ id, kategori: tugas(id).kategori, lengan: "plafon", lulus: true, ms: 5, biaya: 0.01 });
  const L = laporan(hasil, { subsetPlafon: ["koding-nilai-fungsi", "riset-cuti-kontrak"] });
  assert.equal(L.kategori.koding.polos, 0);
  assert.equal(L.kategori.koding.backbone, 1);
  assert.equal(L.kategori.konten.kenaikan, 0);
  assert.equal(L.total.kenaikan, 0.8);
  assert.ok(L.total.ci[0] > 0 && L.total.ci[1] <= 1);
  assert.equal(L.passK.backbone, 0.8);
  assert.equal(L.plafon.rasio, 1);
  assert.equal(L.klaimUmum, false);
  assert.equal(L.waktu.backbone.median, 40);
});

test("plafon: maks 10 tugas dan id harus dikenal", () => {
  const ids = SET.tugas.slice(0, 10).map((t) => t.id);
  assert.equal(pilihPlafon(SET, ids).length, 10);
  assert.throws(() => pilihPlafon(SET, SET.tugas.slice(0, 11).map((t) => t.id)), /10/);
  assert.throws(() => pilihPlafon(SET, ["tidak-ada"]), /dikenal/);
});

test("biaya: Ollama nol, penyedia berbayar butuh harga dari pemilik", () => {
  assert.equal(biaya("ollama", { input: 1e6, output: 1e6 }, null), 0);
  assert.equal(biaya("anthropic", { input: 1e6, output: 5e5 }, { input: 2, output: 10 }), 7);
  assert.equal(biaya("anthropic", { input: 1, output: 1 }, null), null);
});
