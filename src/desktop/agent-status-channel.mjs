// Read-only agen.status channel for external readers such as dashboards (ARS-004 §2, D-005).
// Pure Node so it is testable without Electron. Nothing flows back from readers to agents.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const KEYS = ["agentId", "at", "label", "parentRunId", "runId", "seq", "state", "task", "type", "v"];
const STATES = new Set([
  "siaga", "berpikir", "bekerja", "menunggu-izin", "perlu-dicek", "selesai", "gagal", "dihentikan",
]);
const FILE = "agen-status.jsonl";
const nullableString = (v) => v === null || (typeof v === "string" && v.length <= 200);

export function isAgentStatusV1(e) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return false;
  const keys = Object.keys(e).sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i])) return false;
  return (
    e.type === "agen.status" &&
    e.v === 1 &&
    Number.isSafeInteger(e.seq) &&
    e.seq >= 0 &&
    typeof e.at === "string" &&
    e.at.length <= 40 &&
    typeof e.agentId === "string" &&
    /^[a-z0-9][a-z0-9-]{1,39}$/.test(e.agentId) &&
    nullableString(e.runId) &&
    nullableString(e.parentRunId) &&
    STATES.has(e.state) &&
    typeof e.label === "string" &&
    e.label.length <= 120 &&
    typeof e.task === "string" &&
    e.task.length <= 60
  );
}

export class AgentStatusChannel {
  constructor({ root, maxBytes = 1048576, keep = 2 }) {
    if (typeof root !== "string" || !root) throw new Error("Channel root (userData) is required");
    this.dir = path.join(root, "agen-status");
    this.file = path.join(this.dir, FILE);
    this.maxBytes = maxBytes;
    this.keep = keep;
    this.lastSeq = -1;
    this.latest = new Map();
    this.pending = [];
    this.size = 0;
    this.writing = Promise.resolve();
  }
  // A new generation per app start: seq restarts at 1 after a restart.
  async open() {
    await fsp.mkdir(this.dir, { recursive: true });
    if (fs.existsSync(this.file)) await this.#rotate();
    this.size = 0;
    this.lastSeq = -1;
    return this;
  }
  accept(event) {
    if (!isAgentStatusV1(event) || event.seq <= this.lastSeq) return false;
    this.lastSeq = event.seq;
    const copy = structuredClone(event);
    this.latest.set(copy.agentId, copy);
    this.pending.push(JSON.stringify(copy) + "\n");
    this.writing = this.writing.then(() => this.#drain()).catch(() => {});
    return true;
  }
  wrap(emit) {
    return (event) => {
      emit(event);
      if (event?.type === "agen.status") this.accept(event);
    };
  }
  snapshot() {
    return structuredClone([...this.latest.values()]);
  }
  async flush() {
    await this.writing;
  }
  async #drain() {
    while (this.pending.length) {
      const line = this.pending.shift();
      const bytes = Buffer.byteLength(line);
      if (this.size > 0 && this.size + bytes > this.maxBytes) {
        await this.#rotate();
        this.size = 0;
      }
      await fsp.appendFile(this.file, line);
      this.size += bytes;
    }
  }
  async #rotate() {
    for (let i = this.keep; i >= 1; i--) {
      const from = i === 1 ? this.file : this.file + "." + (i - 1);
      const to = this.file + "." + i;
      if (!fs.existsSync(from)) continue;
      await fsp.rm(to, { force: true });
      await fsp.rename(from, to);
    }
  }
}

// External reader: latest state per agent from the current generation. A truncated last line
// (writer stopped mid-line) is skipped, not treated as an error.
export async function readAgentStatus(root) {
  let text;
  try {
    text = await fsp.readFile(path.join(root, "agen-status", FILE), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const latest = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isAgentStatusV1(event)) continue;
    const prev = latest.get(event.agentId);
    if (!prev || event.seq > prev.seq) latest.set(event.agentId, event);
  }
  return [...latest.values()];
}

// Read-only IPC handler; main.mjs delegates agentStatus and agentCatalog here. No method takes input.
export function createReadOnlyIpc({ methods, isTrusted }) {
  const table = new Map(Object.entries(methods));
  const names = Object.freeze([...table.keys()].sort());
  return Object.freeze({
    methods: names,
    handle(event, method, payload) {
      if (!isTrusted(event)) throw new Error("Untrusted IPC sender");
      if (!table.has(method)) throw new Error("Unknown or write method on read-only agent IPC: " + method);
      if (payload !== undefined && payload !== null) throw new Error(method + " is read-only and takes no payload");
      return structuredClone(table.get(method)());
    },
  });
}
export function createAgentStatusIpc({ snapshot, isTrusted }) {
  return createReadOnlyIpc({ methods: { agentStatus: snapshot }, isTrusted });
}
