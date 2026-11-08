// Read-only "Apa yang baru" IPC (task 06xg part 2).
// The history file path is fixed inside the app (app.getAppPath()), never taken from the renderer
// and never resolved against the workspace or process cwd. The handler accepts no payload at all.
import fs from "node:fs/promises";
import path from "node:path";
import { uraiRiwayat } from "../core/riwayat-versi.mjs";

export const BERKAS_RELATIF = "docs/RIWAYAT-VERSI.md";
export const BATAS_BYTE = 256 * 1024;

const galat = (code, message) => Object.assign(new Error(message), { code });

// Pure loader: shared by the IPC handler and tests. Errors carry codes and the relative name only.
export async function muatApaYangBaru({ appRoot, version, readFile = fs.readFile }) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) {
    throw galat("APP_ROOT_TIDAK_SAH", "appRoot must be an absolute app path");
  }
  let buf;
  try {
    buf = await readFile(path.join(appRoot, ...BERKAS_RELATIF.split("/")));
  } catch (e) {
    throw galat(e?.code ?? "RIWAYAT_GAGAL_DIBACA", "Gagal membaca " + BERKAS_RELATIF + " (" + (e?.code ?? "unknown") + ")");
  }
  if (buf.length > BATAS_BYTE) throw galat("RIWAYAT_TERLALU_BESAR", BERKAS_RELATIF + " melebihi " + BATAS_BYTE + " byte");
  const bagian = uraiRiwayat(buf.toString("utf8")).map((s) => ({
    versi: s.versi,
    tanggal: s.tanggal,
    isi: s.isi,
    saatIni: s.versi === version,
  }));
  return { versiApp: String(version ?? ""), berkas: BERKAS_RELATIF, saatIniDitemukan: bagian.some((b) => b.saatIni), bagian };
}

export function createWhatsNewIpc({ appRoot, version, isTrusted, readFile }) {
  if (typeof appRoot !== "string" || !path.isAbsolute(appRoot)) {
    throw galat("APP_ROOT_TIDAK_SAH", "appRoot must be an absolute app path");
  }
  if (typeof isTrusted !== "function") throw new TypeError("isTrusted is required");
  return Object.freeze({
    methods: Object.freeze(["whatsNew"]),
    async handle(event, method, payload) {
      if (!isTrusted(event)) throw new Error("Untrusted IPC sender");
      if (method !== "whatsNew") throw new Error("Unknown or write method on read-only whatsNew IPC: " + method);
      if (payload !== undefined) throw new Error("whatsNew is read-only and takes no payload");
      return muatApaYangBaru({ appRoot, version, readFile });
    },
  });
}
