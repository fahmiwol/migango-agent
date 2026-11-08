// Agent states and the public agen.status v1 event (ARS-004 §2). External readers rely on this contract
// from outside, so the key set is fixed; a new key means a new version, never a silent change.
import { summarizeTitle } from "./title.mjs";

const LABELS = Object.freeze({
  siaga: "Siap membantu",
  berpikir: "Sedang berpikir",
  bekerja: "Sedang bekerja",
  "menunggu-izin": "Menunggu izinmu",
  "perlu-dicek": "Perlu kamu cek",
  selesai: "Selesai",
  gagal: "Gagal, lihat catatan",
  dihentikan: "Dihentikan",
});
export const AGENT_STATES = Object.freeze(Object.keys(LABELS));
const FINISH = Object.freeze({
  "needs-validation": "perlu-dicek",
  responded: "selesai",
  failed: "gagal",
  // The host verifier ran checks on changed files and they failed (task 06a2).
  "verification-failed": "gagal",
  cancelled: "dihentikan",
});

export function humanLabel(state) {
  if (!Object.hasOwn(LABELS, state)) throw new Error("Unknown agent state: " + state);
  return LABELS[state];
}

export function stateFromRunEvent(event) {
  switch (event?.type) {
    case "start":
    case "thinking":
      return "berpikir";
    case "tool-start":
    case "tool-result":
    case "approval-closed":
      return "bekerja";
    case "approval":
      return "menunggu-izin";
    case "finish":
      return FINISH[event.status] ?? null;
    default:
      return null;
  }
}

export class StatusBoard {
  constructor({ redact = (s) => s, now = () => new Date() } = {}) {
    this.redact = redact;
    this.now = now;
    this.seq = 0;
    this.latest = new Map();
  }
  update({ agentId, runId = null, parentRunId = null, state, task = "", detail }) {
    if (typeof agentId !== "string" || !agentId) throw new Error("agentId is required");
    let label = humanLabel(state);
    if (detail !== undefined) {
      const text = String(detail).replace(/\s+/g, " ").trim().slice(0, 40);
      // Final states read as "Gagal · …"; ongoing ones keep the full label.
      if (text) label = (state === "gagal" ? "Gagal" : label) + " · " + text;
    }
    const event = {
      type: "agen.status",
      v: 1,
      seq: ++this.seq,
      at: this.now().toISOString(),
      agentId,
      runId,
      parentRunId,
      state,
      label,
      task: task ? summarizeTitle(this.redact(String(task))) : "",
    };
    this.latest.set(agentId, event);
    return structuredClone(event);
  }
  ensure(agentId) {
    if (!this.latest.has(agentId))
      this.latest.set(agentId, {
        type: "agen.status",
        v: 1,
        seq: 0,
        at: this.now().toISOString(),
        agentId,
        runId: null,
        parentRunId: null,
        state: "siaga",
        label: humanLabel("siaga"),
        task: "",
      });
  }
  snapshot() {
    return structuredClone([...this.latest.values()]);
  }
}
