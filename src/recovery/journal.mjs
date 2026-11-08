import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { nativeExecutable } from "./native-artifact.mjs";

const workspaceKey = (value) => path.resolve(value).toLowerCase();
const now = () => new Date().toISOString();
export function processArgsHash(command, args, cwd) {
  return createHash("sha256")
    .update(JSON.stringify({ command, args, cwd }))
    .digest("hex");
}
async function identityCommand(mode, pid, identity) {
  if (!Number.isInteger(pid) || pid < 1) return { state: "unknown", pid };
  if (process.platform !== "win32") return { state: "unknown", pid };
  const args = ["-Mode", mode, "-TargetId", String(pid)];
  if (identity)
    args.push(
      "-ExpectedStarted",
      identity.started,
      "-ExpectedExecutable",
      identity.executable,
    );
  return new Promise((resolve) => {
    const env = {};
    for (const key of [
      "SystemRoot",
      "WINDIR",
      "PATH",
      "PATHEXT",
      "TEMP",
      "TMP",
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "COMSPEC",
    ])
      if (process.env[key]) env[key] = process.env[key];
    let executable;
    try {
      executable = nativeExecutable("process-identity");
    } catch {
      resolve({ state: "unknown", pid });
      return;
    }
    const child = spawn(executable, args, {
      env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ state: "unknown", pid });
    }, 8000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.length > 65536) {
        child.kill();
        finish({ state: "unknown", pid });
      }
    });
    child.stderr.resume();
    child.on("error", () => finish({ state: "unknown", pid }));
    child.on("close", (code) => {
      try {
        finish(code === 0 ? JSON.parse(output) : { state: "unknown", pid });
      } catch {
        finish({ state: "unknown", pid });
      }
    });
  });
}
export const inspectProcess = (pid) => identityCommand("Inspect", pid);
export function identityMatches(expected, actual) {
  return (
    actual?.state === "present" &&
    expected.pid === actual.pid &&
    expected.started === actual.started &&
    typeof expected.executable === "string" &&
    expected.executable.toLowerCase() === actual.executable?.toLowerCase()
  );
}
export class RecoveryJournal {
  constructor(file) {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS recovery_jobs(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,kind TEXT NOT NULL,argsHash TEXT NOT NULL,status TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL,pid INTEGER,started TEXT,executable TEXT,custody TEXT,reason TEXT NOT NULL DEFAULT '',observation TEXT,exitCode INTEGER,resolution TEXT); CREATE INDEX IF NOT EXISTS recovery_jobs_workspace ON recovery_jobs(workspace,status);",
      );
    } catch (error) {
      // Keep the journal untouched but released, so the owner can copy it for support.
      try {
        this.db.close();
      } catch {}
      throw error;
    }
    this.closed = false;
  }
  integrityCheck() {
    return this.db.prepare("PRAGMA integrity_check").get().integrity_check;
  }
  list({ workspace, status } = {}) {
    const clauses = [],
      args = [];
    if (workspace) {
      clauses.push("workspace=?");
      args.push(workspaceKey(workspace));
    }
    if (status) {
      clauses.push("status=?");
      args.push(status);
    }
    return this.db
      .prepare(
        "SELECT * FROM recovery_jobs" +
          (clauses.length ? " WHERE " + clauses.join(" AND ") : "") +
          " ORDER BY created DESC,id DESC",
      )
      .all(...args);
  }
  get(id) {
    const row = this.db
      .prepare("SELECT * FROM recovery_jobs WHERE id=?")
      .get(id);
    if (!row) throw Error("Unknown recovery operation");
    return row;
  }
  assertSafe(workspace) {
    if (
      this.db
        .prepare(
          "SELECT id FROM recovery_jobs WHERE workspace=? AND status='hold' LIMIT 1",
        )
        .get(workspaceKey(workspace))
    )
      throw Error(
        "Recovery HOLD: inspect and resolve previous effects before starting another consequential operation",
      );
  }
  recordIntent({ id = randomUUID(), workspace, kind = "process", argsHash }) {
    if (
      typeof workspace !== "string" ||
      typeof id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,120}$/.test(id) ||
      !/^[a-zA-Z0-9_-]{1,60}$/.test(kind) ||
      !/^[a-f0-9]{64}$/.test(argsHash)
    )
      throw Error("Invalid recovery intent");
    this.assertSafe(workspace);
    this.db
      .prepare(
        "INSERT INTO recovery_jobs(id,workspace,kind,argsHash,status,created,updated) VALUES(?,?,?,?,'intent',?,?)",
      )
      .run(id, workspaceKey(workspace), kind, argsHash, now(), now());
    return this.get(id);
  }
  bindProcess(id, identity) {
    if (
      identity?.state !== "present" ||
      !Number.isInteger(identity.pid) ||
      !/^\d+$/.test(identity.started) ||
      typeof identity.executable !== "string"
    )
      throw Error("Unverifiable process identity");
    const row = this.get(id);
    if (!["intent", "running"].includes(row.status))
      throw Error("Cannot bind interrupted or settled operation");
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status='running',pid=?,started=?,executable=?,custody=?,updated=? WHERE id=?",
      )
      .run(
        identity.pid,
        identity.started,
        identity.executable,
        identity.custody || "unmanaged",
        now(),
        id,
      );
    return this.get(id);
  }
  finish(id, { code = null, uncertain = false, reason = "" } = {}) {
    const row = this.get(id);
    if (row.status === "hold" || row.status === "resolved") return row;
    if (uncertain)
      return this.hold(
        id,
        reason || "Process effect or termination is unconfirmed",
      );
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status=?,exitCode=?,updated=? WHERE id=?",
      )
      .run(
        code === 0 ? "completed" : "failed",
        Number.isInteger(code) ? code : null,
        now(),
        id,
      );
    return this.get(id);
  }
  // The target command was provably never delivered and the worker exit was confirmed.
  // 'not-started' is not a HOLD, so it does not block the workspace. Never downgrades a
  // HOLD or settled row.
  notStarted(id, reason) {
    const row = this.get(id);
    if (!["intent", "running"].includes(row.status)) return row;
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status='not-started',reason=?,updated=? WHERE id=?",
      )
      .run(String(reason).slice(0, 500), now(), id);
    return this.get(id);
  }
  hold(id, reason) {
    this.get(id);
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status='hold',reason=?,updated=? WHERE id=?",
      )
      .run(String(reason).slice(0, 500), now(), id);
    return this.get(id);
  }
  async inspect(id) {
    const row = this.get(id);
    const observed = row.pid
      ? await inspectProcess(row.pid)
      : { state: "unbound" };
    const observation =
      observed.state === "present"
        ? identityMatches(row, observed)
          ? "present"
          : "identity-mismatch"
        : observed.state;
    this.db
      .prepare("UPDATE recovery_jobs SET observation=?,updated=? WHERE id=?")
      .run(observation, now(), id);
    return { ...this.get(id), observed };
  }
  async reconcile() {
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status='hold',reason='Host interrupted; external effects are unknown and will not be replayed',updated=? WHERE status IN ('intent','running')",
      )
      .run(now());
    for (const row of this.list({ status: "hold" })) await this.inspect(row.id);
    return this.list({ status: "hold" });
  }
  async terminateOwned(id) {
    const row = await this.inspect(id);
    if (row.status !== "hold")
      throw Error("Recovery termination requires HOLD");
    if (row.observation !== "present" || row.custody !== "windows-job")
      return { ...row, terminated: false };
    const result = await identityCommand("Terminate", row.pid, row);
    const inspected = await this.inspect(id);
    return {
      ...inspected,
      terminated:
        result.terminated === true && inspected.observation === "absent",
    };
  }
  async resolve(id, { decision, note } = {}) {
    if (
      decision !== "acknowledge-effects" ||
      typeof note !== "string" ||
      note.trim().length < 10 ||
      note.length > 1000
    )
      throw Error(
        "Recovery resolution requires explicit decision and inspection note",
      );
    const row = await this.inspect(id);
    if (row.status !== "hold") throw Error("Only HOLD can be resolved");
    if (!["absent", "identity-mismatch", "unbound"].includes(row.observation))
      throw Error(
        "Cannot resolve live/present or unverifiable process; inspect and terminate verified ownership first",
      );
    this.db
      .prepare(
        "UPDATE recovery_jobs SET status='resolved',resolution=?,updated=? WHERE id=?",
      )
      .run(JSON.stringify({ decision, note: note.trim() }), now(), id);
    return this.get(id);
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
