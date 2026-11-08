// Benchmark v2, second pilot (markas round 3): the same eight task families scaled 6-25x and given
// as FILES on disk (tmp-migan/bench2/<id>/) instead of pasted into the prompt, so a tool-using arm
// has a reason to compute. Each file stays <= 20 KB: ask mode (the plain arm) caps one request at
// 48 KB, and a bigger file would fail on the harness limit, not on the model. Answers are computed
// here in code; nothing comes from a model.
import { rng } from "./generator.mjs";
export { normalisasi, nilaiV2 } from "./generator.mjs";

const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const KOTA = ["Bandung", "Surabaya", "Medan", "Makassar", "Semarang", "Denpasar"];
const KAT = ["kopi", "teh", "roti", "susu", "gula"];
const NAMA = ["Adi", "Bayu", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hadi", "Indah", "Joko", "Kiki", "Lina", "Made", "Nina", "Oki", "Putu", "Rina", "Sari", "Tono", "Uli", "Vina", "Wati", "Yudi", "Zaki"];
const MARGA = ["Abdi", "Barus", "Chandra", "Daulay", "Effendi", "Fauzi", "Gunawan", "Harahap", "Irawan", "Jaya", "Kusuma", "Lubis"];

export const GENERATOR2 = {
  "jumlah-bersyarat": (r) => {
    const rows = Array.from({ length: 900 }, () => ({ kota: pick(r, KOTA), kat: pick(r, KAT), unit: int(r, 1, 40), harga: int(r, 5, 95) * 500 }));
    const kota = pick(r, KOTA), kat = pick(r, KAT);
    const jawab = rows.filter((x) => x.kota === kota && x.kat === kat).reduce((a, x) => a + x.unit * x.harga, 0);
    return { tanya: `Berapa total pendapatan (unit x harga) untuk kategori ${kat} di kota ${kota} pada penjualan.csv? Jawab satu bilangan bulat rupiah tanpa pemisah ribuan.`, berkas: { "penjualan.csv": "kota,kategori,unit,harga\n" + rows.map((x) => [x.kota, x.kat, x.unit, x.harga].join(",")).join("\n") + "\n" }, jenis: "angka", jawab };
  },
  "median-ganjil": (r) => {
    const xs = Array.from({ length: 2001 }, () => int(r, 1000, 99999));
    const s = [...xs].sort((a, b) => a - b);
    return { tanya: "angka.txt berisi 2001 bilangan bulat, satu per baris. Berapa mediannya? Jawab satu bilangan bulat.", berkas: { "angka.txt": xs.join("\n") + "\n" }, jenis: "angka", jawab: s[1000] };
  },
  "hitung-pasangan": (r) => {
    const suku = ["ka", "ma", "an", "ng", "ra", "si", "tu", "pe", "la", "da", "na", "ba"];
    const teks = Array.from({ length: 2000 }, () => Array.from({ length: int(r, 2, 4) }, () => pick(r, suku)).join("")).join(" ");
    const cari = pick(r, ["an", "ka", "ng", "ra"]);
    return { tanya: `Berapa kali dua huruf "${cari}" muncul di teks.txt (hitung tanpa tumpang tindih, termasuk di tengah kata)? Jawab satu bilangan bulat.`, berkas: { "teks.txt": teks + "\n" }, jenis: "angka", jawab: teks.split(cari).length - 1 };
  },
  "hari-kerja": (r) => {
    const mulai = new Date(Date.UTC(2024, int(r, 0, 11), int(r, 1, 28)));
    const panjang = int(r, 900, 1300);
    const akhir = new Date(mulai.getTime() + panjang * 86400000);
    const libur = new Set();
    while (libur.size < 60) libur.add(new Date(mulai.getTime() + int(r, 1, panjang - 1) * 86400000).toISOString().slice(0, 10));
    let n = 0;
    for (let d = new Date(mulai); d <= akhir; d = new Date(d.getTime() + 86400000)) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6 && !libur.has(d.toISOString().slice(0, 10))) n++;
    }
    const f = (d) => d.toISOString().slice(0, 10);
    return { tanya: `Berapa hari kerja (Senin–Jumat) dari ${f(mulai)} sampai ${f(akhir)}, kedua tanggal ikut dihitung, dikurangi hari libur di libur.txt (libur yang jatuh di Sabtu/Minggu tidak mengurangi lagi)? Jawab satu bilangan bulat.`, berkas: { "libur.txt": [...libur].sort().join("\n") + "\n" }, jenis: "angka", jawab: n };
  },
  "jejak-program": (r) => {
    const xs = Array.from({ length: 400 }, () => int(r, 1, 997));
    const k = int(r, 3, 7), m = int(r, 2, 5);
    let acc = 0;
    for (let i = 0; i < xs.length; i++) for (let j = 0; j < 3; j++) acc = (xs[i] + j) % k === 0 ? acc + xs[i] * m - j : acc - ((i + j) % 4);
    const src = `const xs = [${xs.join(", ")}];\nlet acc = 0;\nfor (let i = 0; i < xs.length; i++)\n  for (let j = 0; j < 3; j++)\n    acc = (xs[i] + j) % ${k} === 0 ? acc + xs[i] * ${m} - j : acc - ((i + j) % 4);\nconsole.log(acc);\n`;
    return { tanya: "Berapa angka yang dicetak program hitung.js? Jawab satu bilangan bulat.", berkas: { "hitung.js": src }, jenis: "angka", jawab: acc };
  },
  "gabung-tabel": (r) => {
    const wil = ["Barat", "Timur", "Utara", "Selatan", "Tengah"];
    const pel = Array.from({ length: 200 }, (_, i) => ({ id: "P" + (1000 + i), wil: pick(r, wil) }));
    const pes = Array.from({ length: 700 }, (_, i) => ({ id: "O" + (5000 + i), pel: pick(r, pel).id, status: pick(r, ["lunas", "lunas", "tertunda", "batal"]), nilai: int(r, 10, 900) * 1000 }));
    const w = pick(r, wil);
    const ids = new Set(pel.filter((p) => p.wil === w).map((p) => p.id));
    const jawab = pes.filter((o) => ids.has(o.pel) && o.status === "lunas").reduce((a, o) => a + o.nilai, 0);
    return { tanya: `Berapa total nilai pesanan berstatus lunas milik pelanggan di wilayah ${w}? Data di pelanggan.csv dan pesanan.csv. Jawab satu bilangan bulat rupiah tanpa pemisah ribuan.`, berkas: { "pelanggan.csv": "id,wilayah\n" + pel.map((p) => p.id + "," + p.wil).join("\n") + "\n", "pesanan.csv": "id,pelanggan,status,nilai\n" + pes.map((o) => [o.id, o.pel, o.status, o.nilai].join(",")).join("\n") + "\n" }, jenis: "angka", jawab };
  },
  "peringkat-ke-k": (r) => {
    const uniq = [...new Set(Array.from({ length: 420 }, () => pick(r, NAMA) + " " + pick(r, MARGA)))];
    const skor = uniq.map((n) => ({ n, s: int(r, 400, 700) / 10 }));
    const urut = [...skor].sort((a, b) => b.s - a.s || a.n.localeCompare(b.n));
    const k = int(r, 60, 180);
    return { tanya: `skor.csv berisi nama dan skor (satu desimal). Urutkan skor dari terbesar; bila skor sama, urutkan nama secara alfabet. Siapa di peringkat ke-${k}? Jawab nama lengkapnya saja.`, berkas: { "skor.csv": "nama,skor\n" + skor.map((x) => x.n + "," + x.s.toFixed(1)).join("\n") + "\n" }, jenis: "nama", jawab: urut[k - 1].n, kandidat: uniq };
  },
  "jumlah-durasi": (r) => {
    const d = Array.from({ length: 1500 }, () => [int(r, 0, 3), int(r, 0, 59), int(r, 0, 59)]);
    return { tanya: "durasi.txt berisi 1500 durasi berformat J:MM:SS. Berapa total semuanya dalam detik? Jawab satu bilangan bulat.", berkas: { "durasi.txt": d.map(([j, m, s]) => `${j}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`).join("\n") + "\n" }, jenis: "angka", jawab: d.reduce((a, [j, m, s]) => a + j * 3600 + m * 60 + s, 0) };
  },
};

export function buatSet2(seed, perGenerator) {
  const tugas = [];
  for (const [nama, gen] of Object.entries(GENERATOR2))
    for (let i = 0; i < perGenerator; i++) {
      const id = `${nama}-${i + 1}`;
      const t = gen(rng(seed * 1000 + i * 37 + nama.length * 7919));
      const dir = `tmp-migan/bench2/${id}`;
      const daftar = Object.keys(t.berkas).map((p) => dir + "/" + p).join(", ");
      tugas.push({ id, generator: nama, dir, ...t, prompt: `${t.tanya}\nBerkas ada di folder kerja: ${daftar}.` });
    }
  return tugas;
}
