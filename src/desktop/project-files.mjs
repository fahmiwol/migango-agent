// Project files for the UI (ARS-004 §13, K05/K06): a lazy one-level listing that never truncates silently,
// and new project folders created only directly under an owner-chosen projects root.
import fs from "node:fs/promises";
import path from "node:path";
import { allowedName } from "../tools/workspace.mjs";
import { scaffoldProjectStandard, validateProfile } from "../core/project-standard.mjs";

export async function listDirectory(workspace, dir = "", { limit = 200, offset = 0 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
    throw new Error("Invalid limit: must be an integer 1-500");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid offset");
  if (typeof dir !== "string") throw new Error("Invalid directory");
  // Every non-root path goes through the workspace guard (D-002): traversal, absolute, 8.3 aliases.
  const full = dir === "" ? await fs.realpath(workspace.root) : await workspace.resolve(dir);
  if (!(await fs.stat(full)).isDirectory()) throw new Error("Not a directory");
  const visible = [];
  for (const entry of await fs.readdir(full, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !allowedName(entry.name)) continue;
    if (entry.isDirectory()) visible.push({ name: entry.name, kind: "dir" });
    else if (entry.isFile()) {
      const { size } = await fs.stat(path.join(full, entry.name));
      visible.push({ name: entry.name, kind: "file", size });
    }
  }
  visible.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
  );
  const entries = visible.slice(offset, offset + limit);
  const more = Math.max(0, visible.length - offset - entries.length);
  return {
    dir,
    entries,
    total: visible.length,
    offset,
    shown: entries.length,
    more,
    moreLabel: more ? `ada ${more} lagi` : null,
    nextOffset: more ? offset + entries.length : null,
  };
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
export function validateProjectName(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 64 ||
    !/^[A-Za-z0-9 ._-]+$/.test(name) ||
    name.startsWith(".") ||
    /[ .]$/.test(name) ||
    name.includes("..") ||
    RESERVED.test(name)
  )
    throw new Error(
      "Nama proyek tidak valid: 1-64 huruf/angka/spasi/-/_/., tidak diawali titik, tidak diakhiri titik/spasi, bukan nama cadangan Windows",
    );
  return name;
}

export async function createProject({ projectsRoot, name, profile = "dasar", scaffold = scaffoldProjectStandard }) {
  validateProjectName(name);
  // Checked before the folder exists so a bad profile leaves nothing behind.
  validateProfile(profile);
  let root;
  try {
    root = await fs.realpath(projectsRoot);
    if (!(await fs.stat(root)).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("Akar proyek (projects root) harus folder yang sudah ada");
  }
  const target = path.join(root, name);
  // Non-recursive and exclusive: an existing folder is never reused or overwritten.
  await fs.mkdir(target);
  // New projects start on the project standard (markas, 25 Oct 2026).
  let standard;
  try {
    standard = await scaffold({ root: target, name, profile });
  } catch (error) {
    // The folder was created exclusively just above, so only this call's partial scaffold is removed.
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return { root: target, standard };
}
