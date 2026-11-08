// 06xc: turn a HOLD journal row into a plain-language inspection the owner can approve.
// Pure and read-only: git and process state are injected by the caller; nothing is killed,
// nothing is acknowledged here. Unknown data always fails closed to "periksa-dulu".

const SETTLED_ABSENT = new Set(["absent", "identity-mismatch", "unbound"]);

function cut(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

function lastStep(run) {
  const trace = Array.isArray(run?.trace) ? run.trace : [];
  const step = trace[trace.length - 1];
  if (!step) return null;
  if (typeof step === "string") return cut(step, 200) || null;
  return cut(step.label || step.summary || step.tool || "", 200) || null;
}

// Number of live processes still owned by the task, or null when unverifiable.
function remainingProcesses(row, prosesHidup) {
  if (Number.isInteger(prosesHidup) && prosesHidup >= 0) return prosesHidup;
  if (row?.observation === "present") return 1;
  if (SETTLED_ABSENT.has(row?.observation)) return 0;
  return null;
}

// Changed paths from git status/diff, or null when git could not be read.
function changedFiles(git) {
  const files = Array.isArray(git) ? git : git?.files;
  if (!Array.isArray(files) || git?.error) return null;
  return files.filter((f) => typeof f === "string" && f).slice(0, 200);
}

export function periksaHold({ row, run, git, prosesHidup } = {}) {
  if (!row || typeof row.id !== "string") throw Error("periksaHold needs a journal row");
  const judul =
    cut(run?.title, 120) || "Tugas " + cut(row.kind, 40) + " · " + row.id.slice(0, 8);
  const tujuan = cut(run?.goal || run?.prompt, 160) || "Tujuan tidak tercatat.";
  const dimulai = row.pid != null || !!row.started;
  const selesaiTerbukti = Number.isInteger(row.exitCode);
  const perintahTerputus = {
    alat: String(row.kind || "tidak diketahui"),
    dimulai,
    selesaiTerbukti,
  };
  const berkasBerubah = changedFiles(git);
  const prosesSisa = remainingProcesses(row, prosesHidup);

  const alasan = [];
  if (berkasBerubah === null) alasan.push("perubahan berkas tidak bisa dibaca");
  else if (berkasBerubah.length > 0) alasan.push(berkasBerubah.length + " berkas berubah");
  if (prosesSisa === null) alasan.push("status proses tidak terverifikasi");
  else if (prosesSisa > 0) alasan.push("proses masih hidup");
  if (dimulai && !selesaiTerbukti) alasan.push("perintah sudah jalan tanpa bukti selesai");

  const aman =
    prosesSisa === 0 &&
    Array.isArray(berkasBerubah) &&
    berkasBerubah.length === 0 &&
    (!dimulai || selesaiTerbukti);
  const rekomendasi = aman ? "aman-diakui" : "periksa-dulu";

  const langkah = lastStep(run);
  const catatan = cut(
    [
      "Diperiksa otomatis untuk " + judul + ".",
      "Alat terputus: " + perintahTerputus.alat + ".",
      dimulai
        ? selesaiTerbukti
          ? "Perintah sudah jalan dan selesai (kode " + row.exitCode + ")."
          : "Perintah sudah jalan, hasil akhirnya tidak tercatat."
        : "Perintah belum pernah dimulai.",
      berkasBerubah === null
        ? "Perubahan berkas tidak bisa dibaca."
        : berkasBerubah.length
          ? "Berkas berubah: " + berkasBerubah.slice(0, 10).join(", ") +
            (berkasBerubah.length > 10 ? " dan lainnya." : ".")
          : "Tidak ada berkas berubah.",
      prosesSisa === null
        ? "Status proses tidak terverifikasi."
        : "Proses tersisa: " + prosesSisa + ".",
      aman
        ? "Rekomendasi: aman diakui."
        : "Rekomendasi: periksa dulu: " + alasan.join(" / ") + ".",
    ].join(" "),
    1000,
  );
  return {
    tugas: { judul, tujuan },
    langkahTerakhir: langkah,
    perintahTerputus,
    berkasBerubah,
    prosesSisa,
    rekomendasi,
    alasan,
    catatan,
  };
}
