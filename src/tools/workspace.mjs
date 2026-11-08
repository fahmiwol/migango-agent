import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
export const hash = (text) => createHash("sha256").update(text).digest("hex");
// A write that fails its precondition wrote nothing; the runtime hands it back to the model.
export const precondition = (message) => Object.assign(new Error(message), { code: "ERR_TOOL_PRECONDITION" });
const hidden =
  /(^\.|(?:secret|credential|token|password|rahasia)|^id_(rsa|ed25519)$|\.(pem|key|pfx|p12|kdbx)$)/i;
const skip = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  "coverage",
  "target",
  "__pycache__",
]);
export const allowedName = (value) => !hidden.test(value) && !skip.has(value);
// Folders that hold many generated or archived files; listed and searched after everything else.
const BULKY = new Set(["evidence", "fixtures", "snapshots", "logs", "tmp", "tmp-migan", "rujukan-pemilik"]);
export function safeBrowserURL(value) {
  const u = new URL(value);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password)
    throw new Error("Only HTTP(S) URLs without credentials are allowed");
  return u.href;
}
// The syntactic half of Workspace.resolve, with no file system access: absolute, drive-relative,
// UNC, traversal, control characters, reserved device names and hidden/sensitive names.
// Shared so the tool registry can refuse a path BEFORE asking the owner (S1, 8 Nov 2026).
// Returns the path parts; the filesystem half (junctions, realpath escape) stays in resolve.
export function checkPathSyntax(name, { internal = false } = {}) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 500 ||
    path.isAbsolute(name) ||
    /^[A-Za-z]:|[:\x00-\x1f]/.test(name)
  )
    throw new Error("Invalid workspace path");
  const parts = name.replaceAll("\\", "/").split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[ .]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(p) ||
        (!internal && !allowedName(p)),
    )
  )
    throw new Error("Path blocked: traversal, hidden or sensitive file");
  return parts;
}
export class Workspace {
  constructor(root) {
    this.root = path.resolve(root);
  }
  async resolve(name, { create = false, internal = false } = {}) {
    const parts = checkPathSyntax(name, { internal });
    const root = await fs.realpath(this.root);
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      try {
        const s = await fs.lstat(current);
        if (s.isSymbolicLink())
          throw new Error("Symlink/junction is not allowed");
        const real = await fs.realpath(current);
        const rel = path.relative(root, real);
        if (
          rel === ".." ||
          rel.startsWith(".." + path.sep) ||
          path.isAbsolute(rel)
        )
          throw new Error("Path escaped workspace");
        // 8.3 short names (ENV~1 -> .env) pass the literal check; re-check canonical names.
        if (!internal && !rel.split(path.sep).every(allowedName))
          throw new Error("Path blocked: traversal, hidden or sensitive file");
      } catch (e) {
        if (e.code === "ENOENT" && create) continue;
        throw e;
      }
    }
    return current;
  }
  // Whole text of a file within the read limit; edit_file works on this, never on one page.
  async readFull(name) {
    const p = await this.resolve(name);
    const s = await fs.stat(p);
    if (!s.isFile() || s.size > 128 * 1024)
      throw new Error("Read requires a text file <=128 KiB");
    const text = await fs.readFile(p, "utf8");
    if (text.includes("\0")) throw new Error("Binary file blocked");
    return { text, hash: hash(text) };
  }
  // One page of up to 24000 characters from offset; the hash always covers the whole file.
  async read(name, { offset = 0 } = {}) {
    const { text, hash: full } = await this.readFull(name);
    if (!Number.isInteger(offset) || offset < 0 || (offset > 0 && offset >= text.length))
      throw new Error("Invalid read offset");
    const end = offset + 24000;
    return {
      path: name,
      text: text.slice(offset, end),
      hash: full,
      truncated: text.length > end,
      offset,
      ...(text.length > end ? { nextOffset: end } : {}),
      totalChars: text.length,
    };
  }
  async write(name, text, expectedHash) {
    if (typeof text !== "string" || Buffer.byteLength(text) > 128 * 1024)
      throw new Error("Write must be text <=128 KiB");
    const p = await this.resolve(name, { create: true });
    await fs.mkdir(path.dirname(p), { recursive: true });
    await this.resolve(name, { create: true });
    const lockPath = p + ".workbench-lock";
    let lock;
    try {
      lock = await fs.open(lockPath, "wx");
    } catch (e) {
      if (e.code === "EEXIST")
        throw precondition("File changed: another write is in progress");
      throw e;
    }
    try {
      let before = null;
      try {
        before = await fs.readFile(p, "utf8");
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (before !== null && expectedHash === null)
        throw precondition("File already exists; read it first");
      if (before !== null && hash(before) !== expectedHash)
        throw precondition("File changed since reading; read again");
      if (before === null && expectedHash !== null)
        throw precondition("File changed or no longer exists");
      await this.resolve(name, { create: true });
      const temp = p + ".workbench-" + randomUUID() + ".tmp";
      try {
        await fs.writeFile(temp, text, { flag: "wx" });
        await fs.rename(temp, p);
      } finally {
        await fs.rm(temp, { force: true });
      }
      return { path: name, hash: hash(text), bytes: Buffer.byteLength(text) };
    } finally {
      await lock.close();
      await fs.rm(lockPath, { force: true });
    }
  }
  // Every allowed file (bounded walk), source and root files first, docs next, bulky evidence,
  // fixtures and scratch folders last: a 600-file cap must never hide src/ behind evidence/.
  async #allFiles() {
    const found = [];
    let visited = 0;
    const walk = async (dir, prefix = "", depth = 0) => {
      if (depth > 7 || visited > 20000) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (++visited > 20000) return;
        if (!allowedName(e.name) || e.isSymbolicLink()) continue;
        const rel = prefix + e.name;
        if (e.isDirectory())
          await walk(path.join(dir, e.name), rel + "/", depth + 1);
        else if (e.isFile()) found.push(rel);
      }
    };
    await walk(this.root);
    const rank = (rel) => {
      const parts = rel.split("/");
      if (parts.some((p) => BULKY.has(p.toLowerCase()))) return 2;
      return parts[0] === "docs" ? 1 : 0;
    };
    const files = found.map((rel, i) => ({ rel, i, r: rank(rel) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((f) => f.rel);
    return { files, partial: visited > 20000 };
  }
  async list() {
    const { files, partial } = await this.#allFiles();
    // Counts first: the runtime cuts a tool result at 26000 characters.
    return {
      total: files.length,
      truncated: partial || files.length > 600,
      files: files.slice(0, 600),
    };
  }
  // Whole-file lexical search over the ranked tree, up to 40 hits and 32 MB of text; says
  // whether every file was examined so a miss is never mistaken for absence.
  async search(query) {
    if (typeof query !== "string" || query.length < 2 || query.length > 150)
      throw new Error("Search text must be 2–150 characters");
    const { files, partial } = await this.#allFiles();
    const needle = query.toLowerCase();
    const results = [];
    let scanned = 0,
      bytes = 0;
    for (const file of files) {
      if (results.length >= 40 || bytes > 32 * 1024 * 1024) break;
      scanned++;
      try {
        const { text } = await this.readFull(file);
        bytes += text.length;
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && results.length < 40; i++)
          if (lines[i].toLowerCase().includes(needle))
            results.push({
              path: file,
              line: i + 1,
              text: lines[i].slice(0, 400),
            });
      } catch {}
    }
    return {
      results,
      scanned,
      total: files.length,
      complete: !partial && scanned === files.length && results.length < 40,
      scope: "Lexical search, source first; not a complete AST index",
    };
  }
  async skills() {
    const skills = [];
    for (const base of [".agents/skills", ".claude/skills", ".codex/skills"]) {
      let dirs;
      try {
        dirs = await fs.readdir(path.join(this.root, base), {
          withFileTypes: true,
        });
      } catch {
        continue;
      }
      for (const d of dirs.slice(0, 160)) {
        if (!d.isDirectory() || d.isSymbolicLink()) continue;
        const rel = base + "/" + d.name + "/SKILL.md";
        try {
          const p = await this.resolve(rel, { internal: true });
          const s = await fs.stat(p);
          if (s.size > 48000) continue;
          const text = await fs.readFile(p, "utf8");
          skills.push({
            path: rel,
            name: d.name,
            description: (
              text.match(/^description:\s*(.*)$/m)?.[1] ||
              "Skill lokal — pilih untuk membaca"
            ).slice(0, 250),
            hash: hash(text),
          });
        } catch {}
      }
    }
    return skills;
  }
  async loadSkill(name) {
    if (
      !/^\.(agents|claude|codex)\/skills\/[a-zA-Z0-9_-]+\/SKILL\.md$/.test(name)
    )
      throw new Error("Invalid skill path");
    const p = await this.resolve(name, { internal: true });
    const s = await fs.stat(p);
    if (s.size > 48000) throw new Error("Skill too large");
    return (await fs.readFile(p, "utf8")).slice(0, 16000);
  }
}
