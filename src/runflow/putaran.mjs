// Round runner (task 06b1). Each round is a NEW run with fresh context, built only from the goal
// and the current progress.md. The host (not the model) commits after every round, and the loop
// stops hard on: goal reached, max rounds, budget, or two run errors in a row.
// Pure logic: every side effect is injected.

export const BATAS_PROGRESS = 8000;
const STATUS_SELESAI = /^[ \t]*STATUS:[ \t]*SELESAI[ \t]*$/m;
// Run statuses that count as an error for the consecutive-error rule.
const STATUS_GALAT = new Set(["failed", "cancelled", "galat"]);
const PENANDA_POTONG = "[...awal progress dipotong...]\n";

export function potongEkor(teks, batas = BATAS_PROGRESS) {
  const s = String(teks ?? "");
  if (s.length <= batas) return s;
  return PENANDA_POTONG + s.slice(s.length - batas);
}

export function tujuanTercapai(progress, statusRun) {
  if (typeof progress !== "string" || !STATUS_SELESAI.test(progress)) return false;
  return !STATUS_GALAT.has(statusRun) && statusRun !== "verification-failed";
}

export function bangunPrompt({ tujuan, progress, ke, maksPutaran }) {
  const isi = potongEkor(progress);
  return [
    "Putaran " + ke + " dari " + maksPutaran + ". Ini run baru dengan konteks segar.",
    "",
    "## Tujuan",
    String(tujuan),
    "",
    "## Isi progress.md terkini",
    isi.trim() ? isi : "(progress.md belum ada atau kosong)",
    "",
    "## Instruksi",
    "- Lanjutkan dari isi progress.md di atas. Jangan membaca ulang semua sumber.",
    "- Sebelum selesai, perbarui progress.md dengan tiga bagian: Selesai, Sisa, Langkah berikut.",
    "- Tulis baris 'STATUS: SELESAI' di progress.md hanya bila tujuan tercapai dan tes hijau.",
    "- Jangan commit. Host yang commit sesudah putaran ini.",
  ].join("\n");
}

function cekOpsi(o) {
  if (typeof o?.tujuan !== "string" || !o.tujuan.trim()) throw new TypeError("tujuan wajib diisi");
  if (!Number.isInteger(o.maksPutaran) || o.maksPutaran < 1 || o.maksPutaran > 1000)
    throw new TypeError("maksPutaran harus bilangan bulat 1-1000");
  if (typeof o.anggaranUsd !== "number" || !Number.isFinite(o.anggaranUsd) || o.anggaranUsd <= 0)
    throw new TypeError("anggaranUsd harus angka positif");
  for (const k of ["mulaiRun", "bacaProgress", "commitPutaran", "hargaRun"])
    if (typeof o[k] !== "function") throw new TypeError(k + " harus fungsi");
}

const usdTeks = (n) => "US$" + (Math.round(n * 10000) / 10000);

export async function jalankanPutaran(opsi) {
  cekOpsi(opsi);
  const { tujuan, maksPutaran, anggaranUsd, mulaiRun, bacaProgress, commitPutaran, hargaRun } = opsi;
  const sekarang = typeof opsi.sekarang === "function" ? opsi.sekarang : () => new Date();
  const putaran = [];
  let totalUsd = 0;
  let galatBeruntun = 0;
  const selesai = (alasanBerhenti, alasan) => ({ alasanBerhenti, alasan, totalUsd, putaran });

  for (let ke = 1; ; ke++) {
    // Budget check BEFORE starting: the average of earlier rounds is the estimate for this one.
    if (putaran.length > 0) {
      const perkiraan = totalUsd / putaran.length;
      if (totalUsd + perkiraan > anggaranUsd)
        return selesai("anggaran", "Putaran " + ke + " tidak dimulai: total " + usdTeks(totalUsd) +
          " + perkiraan " + usdTeks(perkiraan) + " (rata-rata " + putaran.length + " putaran) melewati anggaran " +
          usdTeks(anggaranUsd) + ".");
    }

    const progress = await bacaProgress();
    const prompt = bangunPrompt({ tujuan, progress, ke, maksPutaran });
    const mulai = sekarang().toISOString();
    let run = null;
    let status;
    try {
      run = await mulaiRun({ prompt, ke });
      status = typeof run?.status === "string" ? run.status : "galat";
    } catch {
      status = "galat";
    }

    let usd = 0;
    if (run) {
      const harga = hargaRun(run);
      if (typeof harga !== "number" || !Number.isFinite(harga) || harga < 0) usd = null;
      else usd = harga;
    }
    const catatan = { ke, runId: run?.id ?? null, status, usd, commit: null, mulai };
    putaran.push(catatan);
    if (usd !== null) totalUsd += usd;

    try {
      catatan.commit = (await commitPutaran(ke, "putaran " + ke + ": " + status)) ?? null;
    } catch {
      return selesai("galat", "Commit host gagal sesudah putaran " + ke + ".");
    }

    if (usd === null) return selesai("anggaran", "Biaya putaran " + ke + " tidak diketahui; berhenti demi aman.");

    const progressBaru = await bacaProgress();
    if (tujuanTercapai(progressBaru, status))
      return selesai("tujuan-tercapai", "progress.md memuat STATUS: SELESAI dan run " + status + ".");

    galatBeruntun = STATUS_GALAT.has(status) ? galatBeruntun + 1 : 0;
    if (galatBeruntun >= 2) return selesai("galat", "Run galat 2 kali berturut-turut.");

    if (totalUsd > anggaranUsd)
      return selesai("anggaran", "Total " + usdTeks(totalUsd) + " melewati anggaran " + usdTeks(anggaranUsd) + ".");

    if (ke >= maksPutaran) return selesai("maks-putaran", "Batas " + maksPutaran + " putaran tercapai.");
  }
}
