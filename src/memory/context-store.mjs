import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
export function workspaceIdentity(workspace) {
  let canonical;
  try {
    canonical = realpathSync(workspace);
  } catch {
    canonical = path.resolve(workspace);
  }
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  return createHash("sha256").update(canonical).digest("hex");
}
// Topics and text are compared as whole words: punctuation and case are ignored, so
// "Harga-Paket" and "harga paket" are one topic and "harga untuk\npaket" still mentions it.
export function normalizeTopic(text) {
  return typeof text === "string"
    ? text.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
    : "";
}
export function mentionsTopic(content, topic) {
  const words = new Set(normalizeTopic(String(content)).split(" "));
  return normalizeTopic(topic)
    .split(" ")
    .every((word) => word && words.has(word));
}
export class ContextStore {
  constructor(file) {
    this.db = new DatabaseSync(file);
    // Runs on the Electron main thread: a short busy wait, then callers degrade (markas P2).
    try {
      this.db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100; CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT NOT NULL, trust TEXT NOT NULL, created TEXT NOT NULL); CREATE INDEX IF NOT EXISTS notes_scope ON notes(workspace,created);`,
      );
      // Owner facts (P1-c): an additive table, so existing notes are never rewritten. A facts table
      // that cannot be created (odd legacy shape, read-only file) disables facts, not notes.
      try {
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS facts(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, topic TEXT NOT NULL, statement TEXT NOT NULL, source TEXT NOT NULL, since TEXT NOT NULL, superseded_by TEXT); CREATE INDEX IF NOT EXISTS facts_scope ON facts(workspace,topic);",
        );
        this.factsAvailable = true;
      } catch {
        this.factsAvailable = false;
      }
      this.mode = "sqlite-fts5";
      try {
        this.db.exec(
          "CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(id UNINDEXED, workspace UNINDEXED, content); INSERT INTO notes_fts(id,workspace,content) SELECT id,workspace,content FROM notes WHERE id NOT IN (SELECT id FROM notes_fts);",
        );
      } catch (error) {
        if (!String(error.message).includes("no such module: fts5")) throw error;
        this.mode = "sqlite-bounded-lexical";
      }
    } catch (error) {
      // Release the file so a corrupt or locked database can be moved aside for recovery.
      try {
        this.db.close();
      } catch {}
      throw error;
    }
  }
  // The owner's current statement on a topic. A newer fact supersedes the older one on the same
  // topic; history is kept (superseded_by), never deleted. Only the owner IPC calls this.
  setFact({ workspace, topic, statement, source, now = new Date() }) {
    if (!this.factsAvailable) throw new Error("Local facts unavailable");
    const key = normalizeTopic(topic);
    if (
      key.length < 3 ||
      key.length > 80 ||
      typeof statement !== "string" ||
      !statement.trim() ||
      statement.length > 1000 ||
      typeof source !== "string" ||
      source.length > 500
    )
      throw new Error("Invalid fact");
    const scope = workspaceIdentity(workspace);
    const row = {
      id: randomUUID(),
      workspace: scope,
      topic: key,
      statement: statement.trim(),
      source,
      since: now.toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE facts SET superseded_by=? WHERE workspace=? AND topic=? AND superseded_by IS NULL",
        )
        .run(row.id, scope, key);
      this.db
        .prepare("INSERT INTO facts(id,workspace,topic,statement,source,since,superseded_by) VALUES(?,?,?,?,?,?,NULL)")
        .run(row.id, row.workspace, row.topic, row.statement, row.source, row.since);
      this.db.exec("COMMIT");
    } catch (e) {
      // SQLite may already have rolled back (e.g. disk full); keep the original error.
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    return row;
  }
  currentFacts(workspace) {
    if (!this.factsAvailable) return [];
    return this.db
      .prepare(
        "SELECT id,topic,statement,source,since FROM facts WHERE workspace=? AND superseded_by IS NULL ORDER BY since DESC LIMIT 100",
      )
      .all(workspaceIdentity(workspace));
  }
  add({ workspace, kind, content, source, trust }) {
    if (
      !["user-note", "session-summary"].includes(kind) ||
      !["explicit", "derived"].includes(trust) ||
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 8000 ||
      typeof source !== "string" ||
      source.length > 500
    )
      throw new Error("Invalid memory record");
    const row = {
      id: randomUUID(),
      workspace: workspaceIdentity(workspace),
      kind,
      content,
      source,
      trust,
      created: new Date().toISOString(),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO notes VALUES(?,?,?,?,?,?,?)")
        .run(
          row.id,
          row.workspace,
          row.kind,
          row.content,
          row.source,
          row.trust,
          row.created,
        );
      if (this.mode === "sqlite-fts5")
        this.db
          .prepare("INSERT INTO notes_fts(id,workspace,content) VALUES(?,?,?)")
          .run(row.id, row.workspace, row.content);
      this.db.exec("COMMIT");
    } catch (e) {
      // SQLite may already have rolled back (e.g. disk full); keep the original error.
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
    return row;
  }
  search(workspace, query = "") {
    const scope = workspaceIdentity(workspace);
    const words = [...String(query).matchAll(/[\p{L}\p{N}_-]{2,}/gu)]
      .slice(0, 12)
      .map((m) => '"' + m[0].replaceAll('"', '""') + '"');
    if (!words.length)
      return this.db
        .prepare(
          "SELECT * FROM notes WHERE workspace=? ORDER BY created DESC LIMIT 12",
        )
        .all(scope);
    if (this.mode === "sqlite-bounded-lexical") {
      const tokens = words.map((w) => w.slice(1, -1).toLowerCase());
      return this.db
        .prepare(
          "SELECT * FROM notes WHERE workspace=? ORDER BY created DESC LIMIT 1000",
        )
        .all(scope)
        .map((row) => ({
          row,
          score: tokens.reduce(
            (score, token) =>
              score + (row.content.toLowerCase().includes(token) ? 1 : 0),
            0,
          ),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map((x) => x.row);
    }
    return this.db
      .prepare(
        "SELECT notes.* FROM notes_fts JOIN notes ON notes.id=notes_fts.id WHERE notes_fts MATCH ? AND notes.workspace=? ORDER BY rank LIMIT 5",
      )
      .all(words.join(" OR "), scope);
  }
  close() {
    this.db.close();
  }
}
