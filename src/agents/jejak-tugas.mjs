// `jejak-tugas/1`: one local trace per task (ARS-019 M-1, cldx/ux-kognitif f19a4f3; S2 8 Nov 2026).
// Built from the run record at the end of every run and kept WITH that record (no new store).
// It never holds keys, tool output or written file content: only what the owner was shown
// (the redacted request), step names, timings, tokens and cost.
// `bolehLatih` (may be used as training data) can only be active with the owner's consent AND an
// apache-2.0/mit output licence AND a route that is not a closed/BYOK model (D-020, D-018).
export const VERSI_JEJAK = "jejak-tugas/1";
const TERBUKA = new Set(["apache-2.0", "mit"]);
// GATE S2 P4 (9 Nov 2026): the licence is never read from the Ollama tag. A tag is free text the
// owner (or a Modelfile) chooses, and the old name table was wrong (Qwen2.5 3B/72B are not
// Apache-2.0). A local model is open only through an owner-verified licence card keyed by the
// model DIGEST, with the source it was read from: { [digest]: { lisensi, sumber } }. No card, no
// source, a closed API route or a team run whose children cannot be verified → not open. The
// exporter (ARS-019) fills digests; until then every trace stays out of training (fail closed).
/** Output licence: open id from a verified card, "tertutup" or "tidak-diketahui". */
export function lisensiKeluaran(profile = {}, kartuLisensi = {}) {
  if (profile.provider !== "ollama") return "tertutup";
  const kartu = typeof profile.digest === "string" && kartuLisensi && Object.hasOwn(kartuLisensi, profile.digest) ? kartuLisensi[profile.digest] : null;
  if (!kartu || !TERBUKA.has(kartu.lisensi) || typeof kartu.sumber !== "string" || !kartu.sumber.startsWith("https://")) return "tidak-diketahui";
  return kartu.lisensi;
}

const detik = (a, b) => {
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 100) / 10 : null;
};

/** Pure: run record → jejak-tugas/1. `redact` is the host's secret redactor. */
export function buatJejak(run, { redact = (s) => s, kartuLisensi = {} } = {}) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const cadangan = events.find((e) => e.type === "model.cadangan");
  const langkah = [];
  const mulaiAlat = new Map();
  for (const e of events) {
    if (e.type === "turn-usage")
      langkah.push({ jenis: "model", nama: run.profile?.model || null, mulai: e.at || null, dtk: null, token: (Number(e.input) || 0) + (Number(e.output) || 0), biayaUsd: null, hasil: "ok" });
    else if (e.type === "tool-start") mulaiAlat.set(e.id, e);
    else if (e.type === "tool-result") {
      const s = mulaiAlat.get(e.id);
      langkah.push({ jenis: "alat", nama: e.name || s?.name || null, mulai: s?.at || null, dtk: s ? detik(s.at, e.at) : null, token: 0, biayaUsd: 0, hasil: e.error ? "gagal" : "ok" });
    }
  }
  const pemakaian = events.filter((e) => e.type === "agen.pemakaian" && Number.isFinite(e.cost));
  return {
    versi: VERSI_JEJAK,
    runId: run.id,
    kanal: run.origin === "bridge" ? "bridge" : "desktop",
    permintaan: String(redact(String(run.prompt || ""))).slice(0, 2000),
    rute: {
      model: run.profile?.id || run.profile?.model || null,
      alasan: run.profile?.selectionReason ? String(redact(run.profile.selectionReason)).slice(0, 300) : null,
      cadangan: cadangan ? { dari: cadangan.dari, ke: cadangan.ke } : null,
    },
    langkah,
    // Approvals are not recorded as run events yet; filled when the approval trail lands (ARS-019 §gerbang).
    persetujuan: [],
    biayaUsd: pemakaian.length ? pemakaian.at(-1).cost : null,
    status: run.status || null,
    nilaiPemilik: null,
    koreksi: null,
    // A team answer mixes children whose models are not recorded per licence: closed (P4).
    lisensiKeluaran: run.teamMerge || (Array.isArray(run.delegations) && run.delegations.length) ? "tertutup" : lisensiKeluaran(run.profile, kartuLisensi),
    bolehLatih: { aktif: false, versiTeks: null, pada: null, dicabutPada: null },
  };
}

/** Pure: owner consent → bolehLatih active, or an error naming the rule that blocks it. */
export function setujuiLatih(jejak, { setuju, versiTeks, pada }) {
  if (setuju !== true) throw new Error("bolehLatih butuh persetujuan pemilik yang eksplisit");
  if (typeof versiTeks !== "string" || !versiTeks.trim()) throw new Error("bolehLatih butuh versiTeks persetujuan yang disetujui");
  if (!TERBUKA.has(jejak?.lisensiKeluaran))
    throw new Error(`bolehLatih ditolak: lisensi keluaran ${jejak?.lisensiKeluaran} (hanya apache-2.0/mit; model tertutup/BYOK tidak pernah, D-020)`);
  return { ...jejak, bolehLatih: { aktif: true, versiTeks, pada, dicabutPada: null } };
}

/** Pure: revocation; applies from the next dataset snapshot (ARS-019). */
export function cabutLatih(jejak, { pada }) {
  return { ...jejak, bolehLatih: { ...jejak.bolehLatih, aktif: false, dicabutPada: pada } };
}
