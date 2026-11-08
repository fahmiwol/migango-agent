// Agents are data in userData, never in the repo (ARS-004 §1). Migan is built in and lives in code,
// so a missing, edited or corrupt agents.json can never remove it.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ROUTES } from "../core/model-registry.mjs";
import { definitions } from "../tools/registry.mjs";
import { validateEmployeeProfile } from "./employee-profiles.mjs";

export const MIGAN_ID = "migan";
export const BUILTIN_AGENT = Object.freeze({
  id: MIGAN_ID,
  jenis: "tetap",
  nama: "Migan",
  persona:
    "Agen utama miganGO. Menjawab sendiri bila mampu dan memanggil agen lain hanya bila perlu.",
  warna: "#ef4444",
  avatar: "migan",
  rute: Object.freeze(Object.keys(ROUTES)),
  profilModel: null,
  skill: Object.freeze([]),
  konektor: Object.freeze([]),
  izinTool: Object.freeze(definitions.map((t) => t.name)),
  induk: null,
  dibuatOleh: "pemilik",
});
const FIELDS = new Set([
  "id",
  "jenis",
  "nama",
  "persona",
  "warna",
  "avatar",
  "rute",
  "profilModel",
  "skill",
  "konektor",
  "izinTool",
  "induk",
  "dibuatOleh",
  "kedaluwarsa",
  "employeeProfile",
]);
const TOOL_NAMES = new Set(definitions.map((t) => t.name));
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const list = (value, field, allowed) => {
  if (!Array.isArray(value) || value.length > 64)
    throw new Error(field + " must be a list");
  for (const item of value)
    if (
      typeof item !== "string" ||
      !item ||
      item.length > 80 ||
      (allowed && !allowed.has(item))
    )
      throw new Error("Unknown " + field + ": " + item);
};

export function validateAgent(record) {
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Agent record must be an object");
  for (const key of Object.keys(record))
    if (!FIELDS.has(key)) throw new Error("Agent field not allowed: " + key);
  if (typeof record.id !== "string" || !NAME.test(record.id))
    throw new Error("Invalid agent id");
  if (!["tetap", "bayangan"].includes(record.jenis))
    throw new Error("jenis must be tetap or bayangan");
  if (
    typeof record.nama !== "string" ||
    !record.nama.trim() ||
    record.nama.length > 40
  )
    throw new Error("nama must be 1-40 characters");
  if (typeof record.persona !== "string" || record.persona.length > 600)
    throw new Error("persona must be at most 600 characters");
  if (!/^#[0-9a-f]{6}$/i.test(record.warna ?? ""))
    throw new Error("warna must be #rrggbb");
  if (typeof record.avatar !== "string" || !NAME.test(record.avatar))
    throw new Error("avatar must be a built-in asset name");
  list(record.rute, "rute", new Set(Object.keys(ROUTES)));
  if (
    record.profilModel !== null &&
    (typeof record.profilModel !== "string" || !record.profilModel)
  )
    throw new Error("profilModel must be a model profile id");
  list(record.skill, "skill");
  list(record.konektor, "konektor");
  list(record.izinTool, "izinTool", TOOL_NAMES);
  if (
    record.induk !== null &&
    (typeof record.induk !== "string" || !NAME.test(record.induk))
  )
    throw new Error("induk must be an agent id or null");
  if (!["pemilik", "migan"].includes(record.dibuatOleh))
    throw new Error("dibuatOleh must be pemilik or migan");
  if (record.jenis === "bayangan") {
    if (
      typeof record.kedaluwarsa !== "string" ||
      Number.isNaN(Date.parse(record.kedaluwarsa))
    )
      throw new Error("bayangan needs kedaluwarsa");
  } else if (record.kedaluwarsa !== undefined)
    throw new Error("tetap must not have kedaluwarsa");
  if (Object.hasOwn(record, "employeeProfile"))
    validateEmployeeProfile(record.employeeProfile);
  return record;
}

// For the app: a broken catalog file never stops miganGO. The panel shows Migan with a plain warning,
// the file is kept for recovery, and the catalog stays read-only until then.
export async function openCatalog({ root }) {
  const catalog = new AgentCatalog({ root });
  try {
    await catalog.load();
    return { catalog, warning: null };
  } catch {
    catalog.agents.clear();
    catalog.readOnly = true;
    return {
      catalog,
      warning:
        "Daftar agen rusak dan tidak bisa dibaca. Untuk sementara hanya Migan yang tampil; berkasnya disimpan untuk pemulihan.",
    };
  }
}

export class AgentCatalog {
  constructor({ root }) {
    if (typeof root !== "string" || !root)
      throw new Error("Catalog root (userData) is required");
    this.file = path.join(root, "agents.json");
    this.agents = new Map();
    this.loaded = false;
    this.readOnly = false;
  }
  async load() {
    let raw;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error(
          "Agent catalog is unreadable; preserve it for recovery",
        );
      this.agents.clear();
      this.loaded = true;
      return this;
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new Error("Agent catalog is invalid; preserve it for recovery");
    }
    if (!data || data.version !== 1 || !Array.isArray(data.agents))
      throw new Error("Agent catalog is invalid; preserve it for recovery");
    const next = new Map();
    for (const record of data.agents) {
      validateAgent(record);
      if (record.id === MIGAN_ID)
        throw new Error("Agent id 'migan' is reserved");
      next.set(record.id, record);
    }
    this.agents = next;
    this.loaded = true;
    return this;
  }
  list() {
    const order = (a) => (a.jenis === "tetap" ? 0 : 1);
    return [
      structuredClone(BUILTIN_AGENT),
      ...structuredClone([...this.agents.values()]).sort(
        (a, b) => order(a) - order(b),
      ),
    ];
  }
  get(id) {
    if (id === MIGAN_ID) return structuredClone(BUILTIN_AGENT);
    const record = this.agents.get(id);
    return record ? structuredClone(record) : undefined;
  }
  async add(record, { by } = {}) {
    if (this.readOnly)
      throw new Error("Agent catalog is read-only until recovery (pemulihan)");
    if (!this.loaded) throw new Error("Load the catalog first");
    if (!["pemilik", "migan"].includes(by))
      throw new Error("by must be pemilik or migan");
    if (record?.id === MIGAN_ID)
      throw new Error("Agent id 'migan' is reserved");
    validateAgent(record);
    if (record.dibuatOleh !== by)
      throw new Error("dibuatOleh must match the creator");
    if (this.agents.has(record.id))
      throw new Error("Agent already exists: " + record.id);
    const next = new Map(this.agents).set(record.id, structuredClone(record));
    await this.#save(next);
    this.agents = next;
  }
  async remove(id) {
    if (id === MIGAN_ID)
      throw new Error("Migan is built in and cannot be removed");
    if (this.readOnly)
      throw new Error("Agent catalog is read-only until recovery (pemulihan)");
    if (!this.agents.has(id)) throw new Error("Unknown agent: " + id);
    const next = new Map(this.agents);
    next.delete(id);
    await this.#save(next);
    this.agents = next;
  }
  panelCards() {
    return this.list().map((a) => ({
      id: a.id,
      nama: a.nama,
      jenis: a.jenis,
      warna: a.warna,
      avatar: a.avatar,
      rute: a.rute,
      profilModel: a.profilModel,
      lencana: a.dibuatOleh === "migan" ? "baru, dari Migan" : null,
      dapatDihapus: a.id !== MIGAN_ID,
      ...(Object.hasOwn(a, "employeeProfile")
        ? { employeeProfile: structuredClone(a.employeeProfile) }
        : {}),
    }));
  }
  async #save(agents) {
    // Atomic write: a crash leaves either the old or the new file, never half of one.
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const temp = this.file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(
        temp,
        JSON.stringify({ version: 1, agents: [...agents.values()] }, null, 2),
      );
      await fs.rename(temp, this.file);
    } catch (e) {
      await fs.rm(temp, { force: true });
      throw e;
    }
  }
}
