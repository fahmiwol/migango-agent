import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
export class SkillLibrary {
  constructor(workspace, extraRoots = []) {
    this.workspace = workspace;
    this.extraRoots = extraRoots;
    this.records = new Map();
  }
  roots() {
    return [
      ...[".agents", ".claude", ".codex"].map((dir) => ({
        path: path.join(this.workspace, dir, "skills"),
        source: "project",
      })),
      ...[".agents", ".claude", ".codex"].map((dir) => ({
        path: path.join(os.homedir(), dir, "skills"),
        source: dir.slice(1) + " global",
      })),
      ...this.extraRoots.map((p) => ({ path: p, source: "workbench" })),
    ];
  }
  async list() {
    this.records.clear();
    const result = [];
    const seen = new Set();
    let visited = 0;
    for (const root of this.roots()) {
      let real;
      try {
        real = await fs.realpath(root.path);
      } catch {
        continue;
      }
      const walk = async (dir, depth = 0) => {
        if (depth > 3 || visited > 1200 || result.length >= 600) return;
        let entries;
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (visited++ > 1200 || result.length >= 600) return;
          if (entry.isSymbolicLink()) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith("."))
            await walk(full, depth + 1);
          if (!entry.isFile() || entry.name !== "SKILL.md") continue;
          const canonical = await fs.realpath(full);
          const relative = path.relative(real, canonical);
          if (
            relative.startsWith("..") ||
            path.isAbsolute(relative) ||
            seen.has(canonical.toLowerCase())
          )
            continue;
          const stat = await fs.stat(full);
          if (stat.size > 48000) continue;
          const handle = await fs.open(full, "r");
          let text;
          try {
            const buffer = Buffer.alloc(4096);
            const { bytesRead } = await handle.read(buffer, 0, 4096, 0);
            text = buffer.subarray(0, bytesRead).toString("utf8");
          } finally {
            await handle.close();
          }
          if (!text.startsWith("---")) continue;
          const name = (
            text.match(/^name:\s*(.+)$/m)?.[1] || path.basename(dir)
          ).replace(/^["']|["']$/g, "");
          const description = (
            text.match(/^description:\s*(.+)$/m)?.[1] || "Local skill"
          )
            .replace(/^["']|["']$/g, "")
            .slice(0, 250);
          const id = createHash("sha256")
            .update(canonical)
            .digest("hex")
            .slice(0, 24);
          this.records.set(id, { path: canonical, root: real });
          seen.add(canonical.toLowerCase());
          result.push({ path: id, name, description, source: root.source });
        }
      };
      await walk(real);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async load(id) {
    const record = this.records.get(id);
    if (!record) throw new Error("Unknown skill; refresh skill list first");
    const actual = await fs.realpath(record.path);
    if (
      actual !== record.path ||
      (await fs.lstat(record.path)).isSymbolicLink()
    )
      throw new Error("Skill source changed");
    const rel = path.relative(record.root, actual);
    if (rel.startsWith("..") || path.isAbsolute(rel))
      throw new Error("Skill escaped registered source");
    const stat = await fs.stat(actual);
    if (stat.size > 48000) throw new Error("Skill too large");
    const text = await fs.readFile(actual, "utf8");
    return {
      text: text.slice(0, 16000),
      source: actual,
      hash: createHash("sha256").update(text).digest("hex"),
      truncated: text.length > 16000,
    };
  }
}
