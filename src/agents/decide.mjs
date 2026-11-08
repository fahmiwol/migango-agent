import { classifyTask } from "../core/model-registry.mjs";
import { usableVerdict } from "./gate.mjs";
export async function decide({
  task,
  catalog,
  override,
  gate,
  auto = false,
  signal,
}) {
  signal?.throwIfAborted();
  const self = (alasan, sanad = []) => ({
    jalur: "sendiri",
    agen: [],
    alasan,
    sanad,
  });
  const lookup = (id) => {
    const a = catalog?.get(id);
    if (!a || id === "migan") throw Error("Agen tidak tersedia: " + id);
    if (a.jenis === "bayangan" && !(Date.parse(a.kedaluwarsa) > Date.now()))
      throw Error("Agen kedaluwarsa: " + id);
    return a;
  };
  if (override !== undefined) {
    if (
      !override ||
      Array.isArray(override) ||
      Object.keys(override).some(
        (k) => !["jalur", "agen", "temporary"].includes(k),
      ) ||
      !Object.hasOwn(override, "jalur") ||
      !Object.hasOwn(override, "agen") ||
      ("temporary" in override && typeof override.temporary !== "boolean") ||
      !["sendiri", "panggil", "majelis"].includes(override.jalur) ||
      !Array.isArray(override.agen)
    )
      throw Error("Invalid delegation override");
    const ids = override.agen;
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => typeof id !== "string" || !id) ||
      (override.jalur === "sendiri"
        ? ids.length !== 0
        : override.jalur === "panggil"
          ? ids.length !== 1
          : ids.length < 2 || ids.length > 4)
    )
      throw Error("Invalid delegation members");
    ids.forEach(lookup);
    return {
      jalur: override.jalur,
      agen: [...ids],
      alasan: "Pilihan tim eksplisit pemilik",
      sanad: [
        {
          penilai: "owner-ui",
          versi: "1",
          kalibrasi: null,
          buktiRefs: [],
          waktu: new Date().toISOString(),
        },
      ],
    };
  }
  const route =
    task?.route || classifyTask(task?.prompt || String(task || "")).route;
  const candidates = (catalog?.list() || []).filter(
    (a) => a.id !== "migan" && a.jenis === "tetap" && a.rute?.includes(route),
  );
  if (auto && gate && candidates.length) {
    let v;
    try {
      v = await gate.tanya({
        jenis: "cukup-sendiri",
        pertanyaan: task?.prompt || String(task),
        bukti: candidates.map((a) => ({ id: a.id })),
        signal,
      });
    } catch {}
    signal?.throwIfAborted();
    if (usableVerdict(v) && v.jawab === "tidak")
      return {
        jalur: "panggil",
        agen: [candidates[0].id],
        alasan: "Gerbang lokal terkalibrasi",
        sanad: [v.sanad],
      };
    return self(
      v?.jawab === "ya" && usableVerdict(v)
        ? "Cukup sendiri"
        : "belum-tahu; tetap bersama Migan",
      v?.sanad ? [v.sanad] : [],
    );
  }
  return self("Bawaan: tanpa delegasi tambahan");
}
