// Bridge build target guard (markas, 27 Oct 2026: "ya build bridge"). A build started through the
// Local Bridge may only write into a folder that, AFTER realpath, is strictly inside one of the
// owner's devRoots and is not the miganGO repo or one of its worktrees, the live app folder,
// userData, or a system folder. The bridge never changes devRoots or any setting; only the owner
// does that in the UI. All OS access goes through injectable dependencies.
import fs from "node:fs/promises";
import path from "node:path";
import { gitCommonDir } from "../core/folder-kerja.mjs";

const denied = (message) => Object.assign(new Error(message), { code: "ERR_BUILD_TARGET_DENIED" });

export function systemRoots(env = process.env) {
  const list = [env.SystemRoot, env.windir, env.ProgramFiles, env["ProgramFiles(x86)"], env.ProgramData, env.ProgramW6432,
    "C:\\Windows", "C:\\Program Files", "C:\\Program Files (x86)", "C:\\ProgramData"];
  return [...new Set(list.filter((p) => typeof p === "string" && p))];
}

export async function checkBridgeBuildTarget(target, {
  devRoots = [], forbidden = [], repoCommonDir, realpath = fs.realpath, commonDir = gitCommonDir,
  system = systemRoots(), platform = process.platform,
} = {}) {
  const P = platform === "win32" ? path.win32 : path.posix;
  const canon = (p) => (platform === "win32" ? P.resolve(p).toLowerCase() : P.resolve(p));
  const within = (child, parent) => {
    const rel = P.relative(canon(parent), canon(child));
    return rel === "" || (!rel.startsWith("..") && !P.isAbsolute(rel));
  };
  const strictlyWithin = (child, parent) => within(child, parent) && canon(child) !== canon(parent);
  const okPath = (p) => typeof p === "string" && p.length > 0 && p.length <= 500 && P.isAbsolute(p) && !/[\x00-\x1f]/.test(p);
  const realOr = async (p) => { try { return await realpath(p); } catch { return P.resolve(p); } };

  if (!okPath(target)) throw denied("buildTarget harus path absolut tanpa karakter kendali");
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw denied("buildTarget tidak ada; pemilik membuat foldernya lebih dulu");
  }
  // Both the raw path and its real path must sit strictly inside a devRoot (roots are realpath'd
  // too), so a junction inside a root that leads elsewhere is seen for what it is.
  const roots = [];
  for (const r of devRoots) if (okPath(r)) roots.push(await realOr(r));
  if (!roots.some((r) => strictlyWithin(real, r) && strictlyWithin(P.resolve(target), r)))
    throw denied("buildTarget tidak berada di dalam akar dev (devRoots) milik pemilik");
  for (const s of system)
    if (okPath(s) && within(real, await realOr(s))) throw denied("buildTarget berada di folder sistem");
  for (const f of forbidden) {
    if (!okPath(f)) continue;
    const rf = await realOr(f);
    if (within(real, rf) || within(rf, real)) throw denied("buildTarget menyentuh folder live atau data aplikasi");
  }
  let common = null;
  try {
    common = commonDir(real);
  } catch {
    common = null; // not inside any git repository: fine for a new build folder
  }
  if (typeof common === "string" && okPath(repoCommonDir) && canon(common) === canon(repoCommonDir))
    throw denied("buildTarget berada di dalam repo miganGO atau salah satu worktree-nya");
  return { root: real };
}

// Per-file check for bridge-granted writes in a bridge build (markas, 27 Oct 2026, option b). The
// target is re-validated with the guard above on every call, then the file (relative to the
// target, which is the workspace) must lie strictly inside it both lexically and after realpath of
// its nearest existing ancestor, so a junction or file link inside the target cannot lead out.
export async function checkBuildWriteTarget(target, file, deps = {}) {
  const { realpath = fs.realpath, platform = process.platform } = deps;
  const P = platform === "win32" ? path.win32 : path.posix;
  const canon = (p) => (platform === "win32" ? P.resolve(p).toLowerCase() : P.resolve(p));
  const strictlyWithin = (child, parent) => {
    const rel = P.relative(canon(parent), canon(child));
    return !!rel && !rel.startsWith("..") && !P.isAbsolute(rel);
  };
  const { root } = await checkBridgeBuildTarget(target, deps);
  if (typeof file !== "string" || !file || file.length > 500 || /[\x00-\x1f]/.test(file))
    throw denied("berkas tulis harus path tanpa karakter kendali");
  const abs = P.resolve(root, file);
  if (!strictlyWithin(abs, root)) throw denied("berkas tulis di luar buildTarget");
  // Walk up to the nearest existing ancestor (the file itself when it exists) and realpath it.
  let probe = abs, rest = [];
  for (;;) {
    try {
      const realProbe = await realpath(probe);
      const realFile = rest.length ? P.join(realProbe, ...rest) : realProbe;
      if (!strictlyWithin(realFile, root)) throw denied("berkas tulis di luar buildTarget");
      return { root, file: abs };
    } catch (error) {
      if (error?.code === "ERR_BUILD_TARGET_DENIED") throw error;
      const parent = P.dirname(probe);
      if (parent === probe || !strictlyWithin(parent, root) && canon(parent) !== canon(root))
        throw denied("berkas tulis di luar buildTarget");
      rest.unshift(P.basename(probe));
      probe = parent;
    }
  }
}
