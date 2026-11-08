// Task generators for benchmark v2 (pilot first, then a fresh seed for the locked set). Each
// generator builds a task from a seeded RNG and computes its own answer in code, so ground truth
// never comes from a model. The grader is the same for every arm: answers are normalized first.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
const pick = (r, xs) => xs[Math.floor(r() * xs.length)];
const KOTA = ["Bandung", "Surabaya", "Medan", "Makassar", "Semarang", "Denpasar"];
const KAT = ["kopi", "teh", "roti", "susu", "gula"];
const NAMA = ["Adi", "Bayu", "Citra", "Dewi", "Eka", "Fajar", "Gita", "Hadi", "Indah", "Joko", "Kiki", "Lina", "Made", "Nina", "Oki", "Putu", "Rina", "Sari", "Tono", "Uli", "Vina", "Wati", "Yudi", "Zaki"];

export const GENERATOR = {
  // Revenue sum with two filters over 150 rows.
  "jumlah-bersyarat": (r) => {
    const rows = Array.from({ length: 150 }, () => ({ kota: pick(r, KOTA), kat: pick(r, KAT), unit: int(r, 1, 40), harga: int(r, 5, 95) * 500 }));
    const kota = pick(r, KOTA), kat = pick(r, KAT);
    const jawab = rows.filter((x) => x.kota === kota && x.kat === kat).reduce((a, x) => a + x.unit * x.harga, 0);
    return { prompt: `Berkas penjualan.csv berisi penjualan. Berapa total pendapatan (unit x harga) untuk kategori ${kat} di kota ${kota}? Jawab satu bilangan bulat rupiah tanpa pemisah ribuan.`, berkas: { "penjualan.csv": "kota,kategori,unit,harga\n" + rows.map((x) => [x.kota, x.kat, x.unit, x.harga].join(",")).join("\n") + "\n" }, jenis: "angka", jawab };
  },
  // Median of 151 integers.
  "median-ganjil": (r) => {
    const xs = Array.from({ length: 151 }, () => int(r, 100, 9999));
    const s = [...xs].sort((a, b) => a - b);
    return { prompt: "Berkas angka.txt berisi 151 bilangan bulat, satu per baris. Berapa mediannya? Jawab satu bilangan bulat.", berkas: { "angka.txt": xs.join("\n") + "\n" }, jenis: "angka", jawab: s[75] };
  },
  // Non-overlapping count of a two-letter string in random text.
  "hitung-pasangan": (r) => {
    const suku = ["ka", "ma", "an", "ng", "ra", "si", "tu", "pe", "la", "da", "na", "ba"];
    const kata = Array.from({ length: 140 }, () => Array.from({ length: int(r, 2, 4) }, () => pick(r, suku)).join(""));
    const teks = kata.join(" ");
    const cari = pick(r, ["an", "ka", "ng", "ra"]);
    const jawab = teks.split(cari).length - 1;
    return { prompt: `Berkas teks.txt berisi satu paragraf. Berapa kali dua huruf "${cari}" muncul di dalamnya (hitung tanpa tumpang tindih, termasuk di tengah kata)? Jawab satu bilangan bulat.`, berkas: { "teks.txt": teks + "\n" }, jenis: "angka", jawab };
  },
  // Working days between two dates, minus listed holidays.
  "hari-kerja": (r) => {
    const mulai = new Date(Date.UTC(2026, int(r, 0, 5), int(r, 1, 28)));
    const panjang = int(r, 120, 220);
    const akhir = new Date(mulai.getTime() + panjang * 86400000);
    const libur = new Set();
    while (libur.size < 6) libur.add(new Date(mulai.getTime() + int(r, 1, panjang - 1) * 86400000).toISOString().slice(0, 10));
    let n = 0;
    for (let d = new Date(mulai); d <= akhir; d = new Date(d.getTime() + 86400000)) {
      const w = d.getUTCDay();
      if (w !== 0 && w !== 6 && !libur.has(d.toISOString().slice(0, 10))) n++;
    }
    const f = (d) => d.toISOString().slice(0, 10);
    return { prompt: `Berapa hari kerja (Senin–Jumat) dari ${f(mulai)} sampai ${f(akhir)}, kedua tanggal ikut dihitung, dikurangi hari libur di berkas libur.txt? Jawab satu bilangan bulat.`, berkas: { "libur.txt": [...libur].sort().join("\n") + "\n" }, jenis: "angka", jawab: n };
  },
  // Trace a small program over 40 numbers.
  "jejak-program": (r) => {
    const xs = Array.from({ length: 40 }, () => int(r, 1, 97));
    const k = int(r, 3, 7), m = int(r, 2, 5);
    let acc = 0;
    for (let i = 0; i < xs.length; i++) acc = xs[i] % k === 0 ? acc + xs[i] * m : acc - (i % 3);
    const src = `const xs = [${xs.join(", ")}];\nlet acc = 0;\nfor (let i = 0; i < xs.length; i++) acc = xs[i] % ${k} === 0 ? acc + xs[i] * ${m} : acc - (i % 3);\nconsole.log(acc);\n`;
    return { prompt: "Berapa angka yang dicetak program hitung.js? Jawab satu bilangan bulat.", berkas: { "hitung.js": src }, jenis: "angka", jawab: acc };
  },
  // Multi-hop join across three tables.
  "gabung-tabel": (r) => {
    const wil = ["Barat", "Timur", "Utara", "Selatan"];
    const pel = Array.from({ length: 30 }, (_, i) => ({ id: "P" + (100 + i), wil: pick(r, wil) }));
    const pes = Array.from({ length: 90 }, (_, i) => ({ id: "O" + (500 + i), pel: pick(r, pel).id, status: pick(r, ["lunas", "lunas", "tertunda", "batal"]), nilai: int(r, 10, 900) * 1000 }));
    const w = pick(r, wil);
    const ids = new Set(pel.filter((p) => p.wil === w).map((p) => p.id));
    const jawab = pes.filter((o) => ids.has(o.pel) && o.status === "lunas").length;
    return { prompt: `Berapa jumlah pesanan berstatus lunas milik pelanggan di wilayah ${w}? Data ada di pelanggan.csv dan pesanan.csv. Jawab satu bilangan bulat.`, berkas: { "pelanggan.csv": "id,wilayah\n" + pel.map((p) => p.id + "," + p.wil).join("\n") + "\n", "pesanan.csv": "id,pelanggan,status,nilai\n" + pes.map((o) => [o.id, o.pel, o.status, o.nilai].join(",")).join("\n") + "\n" }, jenis: "angka", jawab };
  },
  // k-th place with a tie-break rule.
  "peringkat-ke-k": (r) => {
    const orang = NAMA.flatMap((n) => [n + " " + pick(r, ["A", "B", "C"])]).concat(NAMA.map((n) => n + " D"));
    const uniq = [...new Set(orang)];
    const skor = uniq.map((n) => ({ n, s: int(r, 40, 70) }));
    const urut = [...skor].sort((a, b) => b.s - a.s || a.n.localeCompare(b.n));
    const k = int(r, 15, 35);
    return { prompt: `Berkas skor.csv berisi nama dan skor. Urutkan skor dari terbesar; bila skor sama, urutkan nama secara alfabet. Siapa di peringkat ke-${k}? Jawab nama lengkapnya saja.`, berkas: { "skor.csv": "nama,skor\n" + skor.map((x) => x.n + "," + x.s).join("\n") + "\n" }, jenis: "nama", jawab: urut[k - 1].n, kandidat: uniq };
  },
  // Sum of 60 durations.
  "jumlah-durasi": (r) => {
    const d = Array.from({ length: 60 }, () => [int(r, 0, 3), int(r, 0, 59), int(r, 0, 59)]);
    const jawab = d.reduce((a, [j, m, s]) => a + j * 3600 + m * 60 + s, 0);
    return { prompt: "Berkas durasi.txt berisi 60 durasi berformat J:MM:SS. Berapa total semuanya dalam detik? Jawab satu bilangan bulat.", berkas: { "durasi.txt": d.map(([j, m, s]) => `${j}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`).join("\n") + "\n" }, jenis: "angka", jawab };
  },
};

export function buatSet(seed, perGenerator) {
  const tugas = [];
  for (const [nama, gen] of Object.entries(GENERATOR))
    for (let i = 0; i < perGenerator; i++) {
      const t = gen(rng(seed * 1000 + i * 37 + nama.length * 7919));
      tugas.push({ id: `${nama}-${i + 1}`, generator: nama, ...t });
    }
  return tugas;
}

// Normalization shared by all arms: drop markdown, keep the last non-empty line, then extract.
export function normalisasi(final) {
  const baris = String(final || "").replace(/[*`_#>]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return baris.at(-1) || "";
}
export function nilaiV2(t, final) {
  const inti = normalisasi(final);
  if (!inti) return { lulus: false, alasan: "kosong" };
  if (t.jenis === "angka") {
    const angka = (inti.match(/-?\d[\d.,\s]*\d|-?\d/g) || []).map((s) => Number(s.replace(/[.,\s]/g, "")));
    if (!angka.length) return { lulus: false, alasan: "tanpa angka" };
    return angka.at(-1) === t.jawab ? { lulus: true } : { lulus: false, alasan: `jawab ${angka.at(-1)}, benar ${t.jawab}` };
  }
  const low = inti.toLowerCase();
  const disebut = t.kandidat.filter((n) => low.includes(n.toLowerCase()));
  return disebut.length === 1 && disebut[0] === t.jawab ? { lulus: true } : { lulus: false, alasan: `disebut ${disebut.join("/") || "-"}, benar ${t.jawab}` };
}
