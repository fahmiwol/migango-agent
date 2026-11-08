// Parser for the user-facing version history (docs/RIWAYAT-VERSI.md, task 06xg).
// Pure functions only: shared by scripts/naik-versi.mjs and, later, the read-only "Apa yang baru" page.
// Format: one "## <version> — <date>" section per version, newest first, "### " subheadings inside.

const VERSI = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-alpha\.(0|[1-9]\d*))?$/;
const ALPHA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/;
const HEADING_VERSI = /^## (\d\S*)(?:[ \t]+[—-][ \t]+(.*?))?[ \t]*$/;
const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];

export const SUBJUDUL = Object.freeze(["Yang baru", "Yang diperbaiki", "Cara kembali ke versi sebelumnya"]);

const galat = (code, message) => Object.assign(new Error(message), { code });

// Returns sections in document order. Headings inside ``` or ~~~ fences are content, not sections.
export function uraiRiwayat(text) {
  if (typeof text !== "string") throw galat("RIWAYAT_BUKAN_TEKS", "Riwayat versi harus berupa teks");
  const sections = [];
  const seen = new Set();
  let fence = null;
  let offset = 0;
  let current = null;
  const close = (end) => {
    if (!current) return;
    current.akhir = end;
    current.teks = text.slice(current.mulai, end);
    current.isi = text.slice(current.isiMulai, end);
    delete current.isiMulai;
    sections.push(current);
    current = null;
  };
  for (const raw of text.split("\n")) {
    const start = offset;
    offset += raw.length + 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const marker = /^[ \t]{0,3}(```|~~~)/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1];
      else if (marker[1] === fence) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line.startsWith("## ")) {
      close(start);
      const m = HEADING_VERSI.exec(line);
      if (!m) continue; // non-version level-2 heading: ends the previous section, starts none
      if (!VERSI.test(m[1])) throw galat("RIWAYAT_HEADING_TIDAK_SAH", "Judul versi tidak sah: " + line.slice(0, 80));
      if (seen.has(m[1])) throw galat("RIWAYAT_VERSI_GANDA", "Bagian versi muncul dua kali: " + m[1]);
      seen.add(m[1]);
      current = { versi: m[1], tanggal: m[2] ?? "", judul: line, subjudul: [], mulai: start, isiMulai: Math.min(offset, text.length) };
    } else if (current && line.startsWith("### ")) {
      current.subjudul.push(line.slice(4).trim());
    }
  }
  close(text.length);
  return sections;
}

export function cariVersi(sections, versi) {
  return sections.find((s) => s.versi === versi) ?? null;
}

// alpha.N -> alpha.N+1; anything that is not x.y.z-alpha.N is refused.
export function versiBerikutnya(versi) {
  const m = typeof versi === "string" ? ALPHA.exec(versi) : null;
  if (!m) throw galat("VERSI_BUKAN_ALPHA", "Versi harus berbentuk x.y.z-alpha.N: " + String(versi));
  return `${m[1]}.${m[2]}.${m[3]}-alpha.${BigInt(m[4]) + 1n}`;
}

// Calendar date in WIB (Asia/Jakarta) with Indonesian month names, e.g. "28 Oktober 2026".
export function formatTanggalWIB(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${Number(parts.day)} ${BULAN[Number(parts.month) - 1]} ${parts.year}`;
}

// Skeleton for a new version; the rollback commit does not exist yet, so it carries a placeholder.
export function kerangkaBagian(versi, tanggal, versiSebelum) {
  return [
    `## ${versi} — ${tanggal}`,
    "",
    `### ${SUBJUDUL[0]}`,
    "- (isi sebelum rilis)",
    "",
    `### ${SUBJUDUL[1]}`,
    "- (isi sebelum rilis)",
    "",
    `### ${SUBJUDUL[2]}`,
    `- Kembali ke ${versiSebelum}: commit (isi sebelum rilis).`,
    "",
  ].join("\n");
}
