// Host authority is independent of provider-visible definitions and persona text.
import { definitions } from "../tools/registry.mjs";
import { BUILTIN_AGENT } from "./catalog.mjs";
const known = new Set(definitions.map((t) => t.name));
const reads = new Set(["list_files", "read_file", "search_files"]);
function names(value, fallback = []) {
  if (value === undefined) return new Set(fallback);
  if (value === null) return new Set();
  if (
    !Array.isArray(value) ||
    value.some((n) => typeof n !== "string" || !known.has(n))
  )
    throw Error("Invalid tool permissions");
  return new Set(value);
}
export function effectiveTools({
  owner,
  migan = BUILTIN_AGENT,
  agent,
  mode = "work",
  parent,
} = {}) {
  if (!["ask", "work", "build"].includes(mode))
    throw Error("Invalid permission mode");
  const sets = [
    names(owner, known),
    names(migan?.izinTool),
    names(agent?.izinTool),
    mode === "ask" ? reads : known,
  ];
  if (parent !== undefined)
    sets.push(names(Array.isArray(parent) ? parent : parent?.izinTool));
  return new Set([...known].filter((n) => sets.every((s) => s.has(n))));
}
export class ToolAuthority {
  #names;
  constructor(allowed) {
    this.#names = names([...allowed]);
  }
  allows(name) {
    return this.#names.has(name);
  }
  get allowed() {
    return new Set(this.#names);
  }
}
