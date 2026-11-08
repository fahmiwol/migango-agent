import { statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RecoveryJournal } from "../recovery/journal.mjs";
import { safeErrorCode } from "../core/safe-error.mjs";

// The recovery journal stays fail-closed (markas, 25 Oct 2026): without it miganGO cannot
// promise that a restart never repeats an action with effects. A damaged journal becomes a
// plain Indonesian message with safe steps; the file is never moved, deleted or written here.
export class StartupBlockedError extends Error {
  constructor(message, codes) {
    super(message);
    this.name = "StartupBlockedError";
    this.title = "miganGO berhenti demi keamanan";
    this.codes = codes;
  }
}

function recoveryMessage(codes) {
  const code = [codes.code, codes.errcode].filter((v) => v !== undefined).join("/");
  return [
    `Jurnal pemulihan miganGO (recovery.db) tidak bisa dibuka${code ? ` (kode ${code})` : ""}.`,
    "Jurnal ini mencegah miganGO mengulang aksi yang mungkin sudah berjalan. Karena itu miganGO tidak dibuka tanpa jurnal ini.",
    "",
    "Langkah aman:",
    "1. Tutup semua jendela miganGO, lalu buka lagi. Kadang berkas itu sedang dipakai program lain dan lepas sendiri.",
    "2. Kalau tetap gagal, jangan hapus atau pindahkan recovery.db. Salin seluruh folder data miganGO (%APPDATA%\\migan-workbench) ke tempat lain sebagai cadangan.",
    "3. Hubungi pengembang miganGO sebelum mengubah berkas itu.",
  ].join("\n");
}

const blocked = (codes) => new StartupBlockedError(recoveryMessage(codes), codes);
const isDatabaseError = (error) =>
  error?.code === "ERR_SQLITE_ERROR" || Number.isInteger(error?.errcode);

// Read-only preflight: an empty or damaged journal is refused before any connection that
// could write to it (schema creation, reconcile UPDATEs or a WAL checkpoint on close).
function preflight(file) {
  let size;
  try {
    size = statSync(file).size;
  } catch (error) {
    if (error.code === "ENOENT") return; // first run: a new journal is created normally
    throw error;
  }
  if (size === 0) throw blocked({ code: "EMPTY_JOURNAL" });
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    db.exec("PRAGMA busy_timeout=3000");
    const result = db.prepare("PRAGMA quick_check").get()?.quick_check;
    if (result !== "ok") throw blocked({ code: "INTEGRITY_CHECK" });
  } catch (error) {
    if (error instanceof StartupBlockedError) throw error;
    if (!isDatabaseError(error)) throw error;
    throw blocked(safeErrorCode(error));
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

export async function openRecoveryJournal(file, { Journal = RecoveryJournal } = {}) {
  if (Journal === RecoveryJournal) preflight(file);
  let journal;
  try {
    journal = new Journal(file);
    await journal.reconcile();
    return journal;
  } catch (error) {
    try {
      journal?.close();
    } catch {}
    if (!isDatabaseError(error)) throw error;
    throw blocked(safeErrorCode(error));
  }
}
