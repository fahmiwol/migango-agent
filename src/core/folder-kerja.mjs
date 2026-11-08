// ARS-014 modul "folder kerja + pindah-workspace".
// Pindah workspace hanya ke worktree git terisolasi milik repo ini, di bawah akar dev yang
// didaftarkan pemilik (settings.devRoots). Folder live (app.getAppPath), userData dan vault
// ditolak. Tidak pindah saat run atau persetujuan aktif. Setiap percobaan dicatat.
// Semua akses OS lewat dependensi yang bisa disuntik, sehingga tes tidak menyentuh sistem.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isolatedWorktree } from "./worktree.mjs";
import { precondition } from "../tools/workspace.mjs";

const canon = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
// true bila child sama dengan parent atau berada di dalamnya.
const within = (child, parent) => {
  const rel = path.relative(canon(parent), canon(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const strictlyWithin = (child, parent) => within(child, parent) && canon(child) !== canon(parent);
const okPath = (p) => typeof p === "string" && p.length > 0 && p.length <= 500 && path.isAbsolute(p) && !/[\x00-\x1f]/.test(p);
const denied = (message) => Object.assign(new Error(message), { code: "ERR_SWITCH_DENIED" });
const busy = () => Object.assign(new Error("Tidak bisa pindah workspace saat run atau persetujuan aktif"), { code: "ERR_SWITCH_BUSY" });

/** Daftar akar dev milik pemilik: array path absolut, unik, maks 5. */
export function validateDevRoots(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 5) throw new Error("devRoots harus array berisi maks 5 path");
  const seen = new Set();
  return value.map((p) => {
    if (!okPath(p)) throw new Error("devRoots harus path absolut tanpa karakter kendali");
    const key = canon(p);
    if (seen.has(key)) throw new Error("devRoots berisi duplikat");
    seen.add(key);
    return path.resolve(p);
  });
}

// Bawaan nyata: direktori git bersama milik sebuah worktree (perintah git baca-saja).
export function gitCommonDir(dir) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const out = execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], {
    encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], env,
  }).trim();
  return path.resolve(dir, out);
}

async function realOrResolved(realpath, p) {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Memeriksa target pindah. Mengembalikan { path, branch } atau melempar ERR_SWITCH_DENIED.
 * deps: devRoots, forbidden (live/userData/vault), repoCommonDir, realpath, isolated, commonDir.
 */
export async function checkSwitchTarget(target, {
  devRoots = [], forbidden = [], repoCommonDir, realpath = fs.realpath,
  isolated = isolatedWorktree, commonDir = gitCommonDir,
} = {}) {
  if (!okPath(target)) throw denied("Target harus path absolut");
  if (!okPath(repoCommonDir)) throw denied("Repo asal tidak diketahui");
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw denied("Target tidak ada");
  }
  // Akar juga di-realpath: symlink/junction keluar akar terlihat sebagai path luar.
  const roots = [];
  for (const r of devRoots) if (okPath(r)) roots.push(await realOrResolved(realpath, r));
  if (!roots.some((r) => strictlyWithin(real, r) && strictlyWithin(path.resolve(target), r)))
    throw denied("Target tidak berada di bawah akar dev terdaftar");
  for (const f of forbidden) {
    if (typeof f !== "string" || !f) continue;
    const rf = await realOrResolved(realpath, f);
    if (within(real, rf) || within(rf, real)) throw denied("Target menyentuh folder live, data aplikasi atau vault");
  }
  let iso;
  try {
    iso = isolated(real);
  } catch {
    iso = null;
  }
  if (!iso || iso.ok !== true) throw denied("Target bukan worktree git terisolasi pada cabang non-main");
  let common;
  try {
    common = commonDir(real);
  } catch {
    throw denied("Repo target tidak bisa diperiksa");
  }
  if (typeof common !== "string" || canon(common) !== canon(repoCommonDir))
    throw denied("Worktree bukan milik repo ini");
  return { path: real, branch: iso.branch };
}

/** Pemindah workspace: tolak saat sibuk (cek sebelum dan sesudah pemeriksaan), catat semua. */
export function createWorkspaceSwitcher({ check, isBusy, apply, audit = () => {}, now = Date.now }) {
  const isBusyNow = () => {
    try {
      return isBusy() !== false;
    } catch {
      return true;
    }
  };
  const record = (entry) => {
    try {
      audit({ type: "workspace-switch", at: now(), ...entry });
    } catch {}
  };
  let switching = false;
  return {
    async switchTo(target, { actor = "owner" } = {}) {
      const to = typeof target === "string" ? target.slice(0, 500) : null;
      if (switching || isBusyNow()) {
        record({ ok: false, actor, to, reason: "busy" });
        throw busy();
      }
      switching = true;
      try {
        let checked;
        try {
          checked = await check(target);
        } catch (error) {
          record({ ok: false, actor, to, reason: String(error.message).slice(0, 200) });
          if (error?.code !== "ERR_SWITCH_DENIED") throw denied(String(error.message).slice(0, 200));
          throw error;
        }
        if (isBusyNow()) {
          record({ ok: false, actor, to, reason: "busy" });
          throw busy();
        }
        await apply(checked.path);
        record({ ok: true, actor, to: checked.path });
        return { ok: true, workspace: checked.path, branch: checked.branch };
      } finally {
        switching = false;
      }
    },
  };
}

/** Membuat folder di dalam akar workspace (tahan symlink/junction lewat Workspace.resolve). */
export async function makeDir(workspace, rel) {
  const p = await workspace.resolve(rel, { create: true });
  await fs.mkdir(p, { recursive: true });
  await workspace.resolve(rel); // periksa ulang sesudah dibuat
  return { path: rel, created: true };
}

/** Memindah berkas/folder di dalam akar. Tujuan tidak boleh ada; folder tidak ke dalam dirinya. */
export async function moveInside(workspace, from, to) {
  const src = await workspace.resolve(from);
  const dst = await workspace.resolve(to, { create: true });
  // Precondition failures move nothing: ERR_TOOL_PRECONDITION goes back to the model without a HOLD.
  if (within(dst, src)) throw precondition("Tidak bisa memindah folder ke dalam dirinya sendiri");
  try {
    await fs.lstat(dst);
    throw precondition("Tujuan sudah ada");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  // Periksa ulang tepat sebelum rename: tautan yang dibuat sesudah pemeriksaan pertama ditolak.
  await workspace.resolve(from);
  await workspace.resolve(to, { create: true });
  await fs.rename(src, dst);
  return { from, to };
}
