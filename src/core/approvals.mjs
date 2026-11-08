import { randomUUID } from "node:crypto";
export class Approvals {
  constructor(emit, ttl = 120000) {
    this.emit = emit;
    this.ttl = ttl;
    this.pending = new Map();
  }
  request(tool, args, signal, actor) {
    if (signal.aborted) return Promise.reject(new Error("Cancelled"));
    const snapshot = structuredClone(args);
    let identity;
    if (actor !== undefined) {
      if (
        !actor ||
        Array.isArray(actor) ||
        Object.keys(actor).some(
          (k) => !["agentId", "runId", "parentRunId"].includes(k),
        ) ||
        typeof actor.agentId !== "string" ||
        !actor.agentId ||
        actor.agentId.length > 40 ||
        (actor.runId !== undefined &&
          (typeof actor.runId !== "string" || actor.runId.length > 80)) ||
        (actor.parentRunId !== undefined &&
          actor.parentRunId !== null &&
          (typeof actor.parentRunId !== "string" ||
            actor.parentRunId.length > 80))
      )
        return Promise.reject(Error("Invalid approval actor"));
      identity = structuredClone(actor);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        this.pending.delete(id);
      };
      const abort = () => {
        cleanup();
        this.emit({
          type: "approval-closed",
          id,
          ...(identity ? { actor: identity } : {}),
        });
        reject(new Error("Cancelled"));
      };
      const timer = setTimeout(() => {
        cleanup();
        this.emit({
          type: "approval-closed",
          id,
          ...(identity ? { actor: identity } : {}),
        });
        reject(new Error("Approval expired"));
      }, this.ttl);
      this.pending.set(id, (yes, denial, via) => {
        cleanup();
        this.emit({
          type: "approval-closed",
          id,
          ...(identity ? { actor: identity } : {}),
          ...(via ? { via } : {}),
        });
        if (denial) reject(denial);
        // A grant with a source marker (bridge build) resolves to a truthy record the tool call keeps.
        else resolve(yes && via ? { approved: true, via } : yes);
      });
      signal.addEventListener("abort", abort, { once: true });
      this.emit({
        type: "approval",
        id,
        tool,
        args: snapshot,
        ...(identity ? { actor: identity } : {}),
        expiresAt: Date.now() + this.ttl,
      });
    });
  }
  // A refusal by automatic policy (never by the owner's UI) is passed as
  // { policy: true, reason } and rejects with ERR_POLICY_DENIED so the runtime can
  // return it to the model. A plain "no" still resolves false (Owner rejected).
  resolve(id, yes, decision) {
    const p = this.pending.get(id);
    if (!p) return false;
    if (yes !== true && decision?.policy === true) {
      const reason = String(decision.reason ?? "automatic policy").slice(0, 200);
      p(false, Object.assign(new Error("Policy denied this action: " + reason), { code: "ERR_POLICY_DENIED", reason }));
    } else if (yes === true && decision?.via === "otomatis-bridge-build") p(true, null, decision.via);
    else p(yes === true);
    return true;
  }
}
