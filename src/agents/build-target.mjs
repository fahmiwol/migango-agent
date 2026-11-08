// "Bangun aplikasi" writes into a project folder chosen for it, never into the active repo unless the
// owner explicitly chose that repo (ARS-004 §12). Runs before any provider call.
import fs from "node:fs/promises";
import path from "node:path";
import { isFreshScaffold } from "../core/project-standard.mjs";

async function canonical(p) {
  const resolved = path.resolve(p);
  let real = resolved;
  try {
    // fs/promises realpath resolves through libuv, which expands 8.3 short names (D-002).
    real = await fs.realpath(resolved);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
};

export async function checkBuildTarget({ target, workspaceRoot } = {}) {
  if (!target || typeof target !== "object" || typeof target.root !== "string" || !target.root)
    throw new Error("Bangun aplikasi butuh folder proyek (project folder); pilih folder lebih dulu");
  if (!["new", "existing"].includes(target.kind))
    throw new Error("Build target kind must be new or existing");
  if (typeof target.activeRoot !== "string" || !target.activeRoot)
    throw new Error("Build target needs the active workspace root");
  const root = await canonical(target.root);
  const active = await canonical(target.activeRoot);
  const insideActive = within(root, active);
  if (insideActive && !(target.kind === "existing" && target.confirmedByOwner === true))
    throw new Error(
      "Bangun aplikasi tidak menulis ke repo aktif (active repo) tanpa konfirmasi pemilik; pilih folder proyek baru",
    );
  if (target.kind === "new") {
    let entries = [];
    try {
      entries = await fs.readdir(target.root);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    // "Proyek baru" lays out the project standard first; a folder holding only those paths is still new.
    if (entries.length && !(await isFreshScaffold(target.root)))
      throw new Error("Folder proyek baru harus kosong (new project folder must be empty)");
  }
  if ((await canonical(workspaceRoot ?? "")) !== root)
    throw new Error(
      "Ruang kerja aktif belum menunjuk folder proyek; buka folder proyek sebagai workspace lebih dulu",
    );
  return { root: path.resolve(target.root), kind: target.kind, confirmedByOwner: target.confirmedByOwner === true };
}
