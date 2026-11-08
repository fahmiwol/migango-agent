// Isolated-worktree check shared by the bridge controller (server side) and the task CLI
// (markas, 26 Oct 2026): writes may be granted without the owner only in a linked git worktree
// whose root is the workspace and whose branch is not main/master. Read-only git queries.
import path from "node:path";
import { execFileSync } from "node:child_process";

const canonical = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
// GIT_DIR, GIT_WORK_TREE and friends must not steer the answer.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));

/** Returns { ok: true, branch } or { ok: false, reason }. */
export function isolatedWorktree(workspace) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace)) return { ok: false, reason: "workspace bukan path absolut" };
  const git = (...args) =>
    execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
      env: cleanEnv(),
    }).trim();
  try {
    const top = git("rev-parse", "--show-toplevel");
    if (canonical(top) !== canonical(workspace)) return { ok: false, reason: "workspace bukan akar worktree" };
    const gitDir = path.resolve(workspace, git("rev-parse", "--git-dir"));
    const common = path.resolve(workspace, git("rev-parse", "--git-common-dir"));
    if (canonical(gitDir) === canonical(common)) return { ok: false, reason: "bukan worktree terpisah (checkout utama)" };
    const branch = git("rev-parse", "--abbrev-ref", "HEAD");
    if (["main", "master", "head"].includes(branch.toLowerCase())) return { ok: false, reason: `cabang ${branch} tidak terisolasi` };
    return { ok: true, branch };
  } catch {
    return { ok: false, reason: "bukan repositori git" };
  }
}
