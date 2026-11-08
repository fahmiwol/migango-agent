// A registered evaluator is host code, not a network sandbox. No evaluator is installed by default.
const answers = new Set(["ya", "tidak", "belum-tahu"]);
export function usableVerdict(v) {
  return !!(
    v &&
    answers.has(v.jawab) &&
    v.sanad?.penilai &&
    v.sanad?.versi &&
    typeof v.sanad.kalibrasi === "string" &&
    v.sanad.kalibrasi
  );
}
export class LocalGateRegistry {
  constructor({ now = () => new Date() } = {}) {
    this.judges = new Map();
    this.now = now;
  }
  register({ penilai, versi, lokal, kalibrasi = null, evaluate }) {
    if (lokal !== true) throw Error("Penilai wajib lokal: true");
    if (
      typeof penilai !== "string" ||
      !penilai ||
      typeof versi !== "string" ||
      !versi ||
      typeof evaluate !== "function" ||
      (kalibrasi !== null && (typeof kalibrasi !== "string" || !kalibrasi))
    )
      throw Error("Invalid local evaluator");
    const old = this.judges.get(penilai),
      same = old?.kalibrasi === kalibrasi;
    this.judges.set(penilai, {
      penilai,
      versi,
      kalibrasi,
      evaluate,
      last: same ? old.last : null,
      count: same ? old.count : 0,
      macet: same ? old.macet : false,
    });
  }
  state(id) {
    const j = this.judges.get(id);
    return j
      ? { kalibrasi: j.kalibrasi, consecutive: j.count, macet: j.macet }
      : null;
  }
  async tanya({ jenis, pertanyaan, bukti = [], penilai } = {}) {
    const j = penilai
      ? this.judges.get(penilai)
      : this.judges.values().next().value;
    const sanad = {
      penilai: j?.penilai || "aturan-lokal-abstain",
      versi: j?.versi || "1",
      kalibrasi: j?.kalibrasi || null,
      buktiRefs: Array.isArray(bukti)
        ? bukti
            .map((b) => b?.id || b?.runId)
            .filter(Boolean)
            .slice(0, 20)
        : [],
      waktu: this.now().toISOString(),
    };
    const abstain = (reason) => ({
      jawab: "belum-tahu",
      skor: null,
      sanad,
      macet: !!j?.macet,
      reason,
    });
    if (!j?.kalibrasi || j.macet)
      return abstain(j?.macet ? "macet" : "belum terkalibrasi");
    let v;
    try {
      v = await j.evaluate({ jenis, pertanyaan, bukti });
    } catch {
      return abstain("penilai tidak tersedia");
    }
    if (
      !v ||
      !answers.has(v.jawab) ||
      !(
        v.skor === null ||
        (typeof v.skor === "number" &&
          Number.isFinite(v.skor) &&
          v.skor >= 0 &&
          v.skor <= 1)
      )
    )
      return abstain("verdict tidak sah");
    if (v.skor !== null) {
      j.count =
        j.last !== null && Math.abs(j.last - v.skor) <= 1e-6 ? j.count + 1 : 1;
      j.last = v.skor;
      if (j.count >= 20) {
        j.macet = true;
        return abstain("macet");
      }
    }
    return { jawab: v.jawab, skor: v.skor, sanad, macet: false };
  }
}
