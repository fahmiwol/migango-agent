// Shadow pool: ephemeral agents (bayangan) with strict bounds.
// No disk writes, no catalog mutation, no learning. Runtime integrator wires with Brain.
import { randomUUID } from "node:crypto";
import { validateAgent } from "./catalog.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const ALLOWED_SPEC = new Set([
  "nama",
  "persona",
  "rute",
  "profilModel",
  "izinTool",
  "kedaluwarsa",
  "warna",
  "avatar",
]);
const MODES = new Set(["ask", "work", "build"]);
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_LIVE = 4;

function assertPositiveMax(max) {
  if (!Number.isInteger(max) || max < 1 || max > MAX_LIVE)
    throw new Error("max must be a positive integer <= " + MAX_LIVE);
}

function assertNonEmptyString(v, label) {
  if (typeof v !== "string" || !v)
    throw new Error(label + " must be a non-empty string");
}

function assertParent(parent) {
  if (!parent || typeof parent !== "object")
    throw new Error("parent must be an object");
  assertNonEmptyString(parent.id, "parent.id");
  if (!NAME.test(parent.id)) throw new Error("parent.id must be a valid name");
  if (!Array.isArray(parent.izinTool))
    throw new Error("parent.izinTool must be an array");
}

function toISO(d) {
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "number") return new Date(d).toISOString();
  if (typeof d === "string" && !Number.isNaN(Date.parse(d)))
    return new Date(d).toISOString();
  throw new Error("Invalid datetime");
}

function subset(childTools, parentTools) {
  const parentSet = new Set(parentTools);
  return childTools.every((t) => parentSet.has(t));
}

export class ShadowPool {
  constructor({ max = MAX_LIVE, now = () => Date.now() } = {}) {
    assertPositiveMax(max);
    this.max = max;
    this.now = now;
    this.envelopes = new Map(); // id -> { record, runId }
  }

  birth(spec, { parent, runId, deadline, mode = "work" } = {}) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec))
      throw new Error("spec must be an object");

    assertParent(parent);
    assertNonEmptyString(runId, "runId");
    if (!MODES.has(mode)) throw new Error("mode must be ask, work, or build");

    // Strict spec keys only
    for (const key of Object.keys(spec)) {
      if (!ALLOWED_SPEC.has(key))
        throw new Error("Spec field not allowed: " + key);
    }

    // Time bounds
    const t = this.now();
    if (!Number.isFinite(t)) throw new Error("now must be a finite number");
    const defaultDeadline = t + DEFAULT_TTL_MS;
    const dl = deadline != null ? Date.parse(toISO(deadline)) : defaultDeadline;
    if (Number.isNaN(dl)) throw new Error("deadline must be a valid datetime");
    if (dl > t + DEFAULT_TTL_MS)
      throw new Error("deadline exceeds maximum TTL");

    const specExpiry =
      spec.kedaluwarsa != null ? Date.parse(toISO(spec.kedaluwarsa)) : dl;
    if (Number.isNaN(specExpiry))
      throw new Error("kedaluwarsa must be a valid datetime");

    if (specExpiry > dl)
      throw new Error("Shadow expiry cannot exceed deadline");
    const expiry = specExpiry;
    if (t >= expiry) throw new Error("Shadow must expire in the future");

    // Validate required spec fields using catalog schema
    const candidate = {
      id: "bayangan-" + randomUUID().slice(0, 8),
      jenis: "bayangan",
      nama: spec.nama,
      persona: spec.persona ?? "",
      warna: spec.warna ?? "#888888",
      avatar: spec.avatar ?? "default",
      rute: spec.rute ?? [],
      profilModel: spec.profilModel ?? null,
      skill: [],
      konektor: [],
      izinTool: spec.izinTool ?? [],
      induk: parent.id,
      dibuatOleh: "migan",
      kedaluwarsa: new Date(expiry).toISOString(),
    };
    validateAgent(candidate);

    // Privilege: child izinTool must be subset of parent
    if (!subset(candidate.izinTool, parent.izinTool))
      throw new Error("Shadow izinTool must be a subset of parent.izinTool");

    // Max live check (purge first, then enforce)
    this.#purge();
    const live = [...this.envelopes.values()].filter(
      (e) => Date.parse(e.record.kedaluwarsa) > t,
    ).length;
    if (live >= this.max) throw new Error("Shadow limit reached: " + this.max);

    this.envelopes.set(candidate.id, { record: candidate, runId });
    return structuredClone(candidate);
  }

  get(id) {
    this.#purge();
    const env = this.envelopes.get(id);
    return env ? structuredClone(env.record) : undefined;
  }

  list() {
    this.#purge();
    return [...this.envelopes.values()].map((e) => structuredClone(e.record));
  }

  snapshot() {
    this.#purge();
    const out = [];
    for (const env of this.envelopes.values())
      out.push(structuredClone(env.record));
    return out;
  }

  finish(runId) {
    assertNonEmptyString(runId, "runId");
    for (const [id, env] of this.envelopes) {
      if (env.runId === runId) this.envelopes.delete(id);
    }
  }

  close() {
    this.envelopes.clear();
  }

  #purge() {
    const t = this.now();
    for (const [id, env] of this.envelopes) {
      if (Date.parse(env.record.kedaluwarsa) <= t) this.envelopes.delete(id);
    }
  }
}
