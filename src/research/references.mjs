import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { workspaceIdentity } from "../memory/context-store.mjs";
const stages = [
  "queued",
  "source-read",
  "primary-checked",
  "adopted",
  "deferred",
  "inaccessible",
];
// Short-post platform whose post links carry tracking-only queries (host assembled from parts).
const SHORT_POST_DOMAIN = ["insta", "gram.com"].join("");
const SHORT_POST_HOST = new RegExp("(^|\\.)" + SHORT_POST_DOMAIN.replace(".", "\\.") + "$", "i");
export function canonicalReferenceURL(value) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /\bsk-[a-z0-9_-]{12,}/i.test(value)
  )
    throw Error("Invalid reference URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw Error("Reference must be HTTP(S) without credentials");
  for (const key of [...url.searchParams.keys()]) {
    if (
      /^(utm_|gclid$|gbraid$|wbraid$|fbclid$|igsh$|srtk$|vrfl$|rpxt$|exln$|dlrf$|psln$|xmt$)/i.test(
        key,
      )
    )
      url.searchParams.delete(key);
    else if (
      /^(api[_-]?key|access[_-]?token|token|password|secret|signature|authorization|auth|code|key)$/i.test(
        key,
      )
    )
      throw Error("Authentication data is not allowed in reference URLs");
  }
  if (/(^|\.)instagram\.com$/i.test(url.hostname)) {
    url.search = "";
    const post = url.pathname.match(
      /^\/(?:[a-zA-Z0-9_.]+\/)?(p|reel)\/([a-zA-Z0-9_-]+)\/?$/,
    );
    if (post) {
      url.hostname = "www." + SHORT_POST_DOMAIN;
      url.pathname = "/" + post[1] + "/" + post[2] + "/";
    }
  }
  return url.href;
}
const text = (value, max) => {
  if (typeof value !== "string" || value.length > max)
    throw Error("Reference text exceeds limit");
  return value;
};
const markdownText = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_[\]])/g, "\\$1");
export class ReferenceLibrary {
  constructor(file) {
    this.db = new DatabaseSync(file);
    // Runs on the Electron main thread: a short busy wait, then callers degrade (markas P2).
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS research_refs(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,url TEXT NOT NULL,title TEXT NOT NULL,note TEXT NOT NULL,stage TEXT NOT NULL,source TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,UNIQUE(workspace,url));",
      );
    } catch (error) {
      // Release the file so a corrupt or locked database can be moved aside for recovery.
      try {
        this.db.close();
      } catch {}
      throw error;
    }
  }
  import(workspace, input) {
    text(input, 50000);
    const lines = input
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length || lines.length > 100)
      throw Error("Import 1–100 URL lines at once");
    const urls = [...new Set(lines.map(canonicalReferenceURL))];
    const scope = workspaceIdentity(workspace);
    let added = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM research_refs WHERE workspace=?")
        .get(scope).n;
      if (count + urls.length > 2000)
        throw Error("Reference library limit reached");
      for (const url of urls) {
        const now = new Date().toISOString(),
          u = new URL(url);
        added += this.db
          .prepare(
            "INSERT OR IGNORE INTO research_refs VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            randomUUID(),
            scope,
            url,
            (u.hostname + u.pathname).slice(0, 200),
            "",
            "queued",
            "owner-import",
            now,
            now,
          ).changes;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return {
      added,
      duplicates: lines.length - added,
      sourceRead: false,
      modelCalls: 0,
    };
  }
  list(workspace, query = "") {
    text(query, 300);
    const rows = this.db
      .prepare(
        "SELECT id,url,title,note,stage,source,created,updated FROM research_refs WHERE workspace=? ORDER BY updated DESC,id LIMIT 2000",
      )
      .all(workspaceIdentity(workspace));
    const q = query.toLowerCase();
    return rows
      .filter(
        (r) =>
          !q ||
          [r.url, r.title, r.note, r.stage].join(" ").toLowerCase().includes(q),
      )
      .slice(0, 100);
  }
  annotate(workspace, input) {
    if (!stages.includes(input?.stage)) throw Error("Invalid reference stage");
    const title = text(input.title, 200),
      note = text(input.note, 4000);
    const result = this.db
      .prepare(
        "UPDATE research_refs SET title=?,note=?,stage=?,source=?,updated=? WHERE id=? AND workspace=?",
      )
      .run(
        title,
        note,
        input.stage,
        "owner-asserted",
        new Date().toISOString(),
        input.id,
        workspaceIdentity(workspace),
      );
    if (!result.changes)
      throw Error("Reference missing or outside workspace scope");
    return {
      updated: true,
      verification: "owner-asserted; no automatic source validation",
    };
  }
  markdown(workspace) {
    const rows = this.db
      .prepare(
        "SELECT * FROM research_refs WHERE workspace=? ORDER BY updated DESC LIMIT 2000",
      )
      .all(workspaceIdentity(workspace));
    return (
      "# miganGO — Referensi riset\n\nMetadata lokal. Status adalah owner-asserted, bukan bukti validator otomatis. Import tidak mengambil halaman atau memanggil model.\n\n" +
      rows
        .map(
          (r) =>
            "## " +
            markdownText(r.title) +
            "\n\n<" +
            r.url.replace(/[<>]/g, encodeURIComponent) +
            ">\n\n- Status: " +
            r.stage +
            "\n- Sumber catatan: " +
            r.source +
            "\n- Diubah: " +
            r.updated +
            "\n\n" +
            r.note
              .split("\n")
              .map((line) => "> " + markdownText(line))
              .join("\n"),
        )
        .join("\n\n")
    );
  }
  close() {
    this.db.close();
  }
}
