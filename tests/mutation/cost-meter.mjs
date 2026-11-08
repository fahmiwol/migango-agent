// Mutation check for the PRD-019 cost meter, caps and CLI auto-approve (26 Oct 2026).
// Each mutant undoes one guarantee in a temporary copy next to the source; a named test in the
// cost-meter or CLI suite must fail for every mutant. Exit 0 only when the control passes and all die.
// Run: node tests/mutation/cost-meter.mjs
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const hook = pathToFileURL(path.join(here, "runtime-redirect-hook.mjs")).href;
const suites = ["../unit/cost-meter.test.mjs", "../unit/harga-bawaan.test.mjs", "../unit/anthropic-workspace.test.mjs", "../unit/model-per-tugas.test.mjs", "../unit/migango-tugas.test.mjs", "../unit/local-bridge.test.mjs"].map((s) => path.resolve(here, s));
const sources = {
  meter: "src/core/cost-meter.mjs",
  runtime: "src/agents/runtime.mjs",
  storage: "src/core/storage.mjs",
  cli: "scripts/migango-tugas.mjs",
  bridge: "src/desktop/bridge-controller.mjs",
  worktree: "src/core/worktree.mjs",
  price: "ui/price-table.js",
  providers: "src/core/providers.mjs",
  registry: "src/core/model-registry.mjs",
  workspace: "src/core/anthropic-workspace.mjs",
  taskmodel: "src/core/task-model.mjs",
  choice: "ui/model-choice.js",
};
const MUTANTS = [
  ["token cap removed", "meter", ["if (entry.tokens + estimatedInput + maxOutput > tokenCap)", "if (false)"]],
  ["dollar cap removed", "meter", ["if (usdCap !== undefined && price && (entry.usd || 0) + worstUsd > usdCap)", "if (false)"]],
  ["input left out of the cap check", "meter", ["if (entry.tokens + estimatedInput + maxOutput > tokenCap)", "if (entry.tokens + maxOutput > tokenCap)"]],
  ["missing maxOutput costed as zero", "meter", [": DEFAULT_MAX_OUTPUT;", ": 0;"]],
  ["unreported usage charged nothing", "meter", [": { input: estimatedInput, output: maxOutput, cached: 0, cacheCreated: 0 };", ": { input: 0, output: 0, cached: 0, cacheCreated: 0 };"]],
  ["no reservation before the call", "meter", [
    "    CostMeter.#apply(ledger, keys, reservation, 1);\n    try {\n      await this.#write(ledger);\n    } catch {\n      throw new CostError(\"ERR_COST_LEDGER\", \"Catatan biaya tidak bisa ditulis; panggilan model berbayar tidak dikirim.\");\n    }\n",
    "    CostMeter.#apply(ledger, keys, reservation, 1);\n",
  ]],
  ["a failed call is refunded", "meter", [
    "      CostMeter.#apply(ledger, keys, { reserved: 1, usd: null }, -1);\n",
    "      CostMeter.#apply(ledger, keys, reservation, -1);\n",
  ]],
  // Not listed: a non-ENOENT lookup error (EACCES from an ACL) cannot be produced portably in a
  // test; on Windows a file in place of the costs folder gives ENOENT and the write refuses.
  ["corrupt ledger read as empty", "meter", ["      throw refuse(\"rusak\");\n    }\n    if (ledger?.v", "      return emptyLedger(date);\n    }\n    if (ledger?.v"]],
  ["ledger entries not validated", "meter", ["!validBucket(ledger.providers) || !validBucket(ledger.models)", "false"]],
  ["huge ledger accepted", "meter", ["if (stat.size > MAX_LEDGER_BYTES) throw refuse(\"terlalu besar\");", ""]],
  ["broken settings ignored", "meter", ['      throw new CostError("ERR_COST_SETTINGS",', '      return { prices: {}, caps: {} }; throw new CostError("ERR_COST_SETTINGS",']],
  ["UTC day instead of WIB", "meter", ["new Date(now + 7 * 3600 * 1000)", "new Date(now)"]],
  ["defaults changed", "meter", ["kimi: Object.freeze({ usd: 3 })", "kimi: Object.freeze({ usd: 30 })"]],
  ["caps replaced instead of merged", "meter", ["  for (const [provider, cap] of Object.entries(next)) out[provider] = { ...(out[provider] || {}), ...cap };", "  for (const [provider, cap] of Object.entries(next)) out[provider] = cap;"]],
  ["required dollar caps dropped", "meter", ["    if (out[provider]?.usd === undefined) out[provider] = { ...(out[provider] || {}), usd: DEFAULT_CAPS[provider].usd };", ""]],
  ["unpriced paid model allowed", "meter", ["    if (PAID_PROVIDERS.includes(provider) && !price)\n", "    if (false)\n"]],
  ["Ollama not metered", "meter", ['const CAPPED = [...PAID_PROVIDERS, "ollama"];', "const CAPPED = [...PAID_PROVIDERS];"]],
  ["invalid maxOutput forwarded unchanged", "meter", ["      reply = await invoke({ ...req, maxOutput });", "      reply = await invoke(req);"]],
  ["fractional maxOutput not floored", "meter", ["Math.floor(req.maxOutput)", "req.maxOutput"]],
  ["zero maxOutput accepted", "meter", ["Number.isSafeInteger(floored) && floored > 0", "Number.isSafeInteger(floored) && floored >= 0"]],
  ["string maxOutput accepted", "meter", ['typeof req.maxOutput === "number" ? Math.floor(req.maxOutput) : NaN', "Math.floor(req.maxOutput)"]],
  ["built-in prices ignored", "meter", ["return { prices: effectivePrices(s.modelPrices), caps", "return { prices: validatePrices(s.modelPrices), caps"]],
  ["built-ins override the owner", "meter", ["return { ...validatePrices(BUILTIN_PRICES), ...validatePrices(owner) };", "return { ...validatePrices(owner), ...validatePrices(BUILTIN_PRICES) };"]],
  ["stale built-in never flagged", "meter", ["    kedaluwarsa: now > staleAt(row.tanggal),", "    kedaluwarsa: false,"]],
  ["stale window widened", "meter", ["export const STALE_PRICE_DAYS = 90;", "export const STALE_PRICE_DAYS = 900;"]],
  ["overridden rows still warned", "meter", [".filter((r) => r.kedaluwarsa && !r.ditimpa)", ".filter((r) => r.kedaluwarsa)"]],
  ["price refusal names no step", "meter", ["Buka Pengaturan › Harga model, isi", "Isi"]],
  ["meter error code not carried", "runtime", ['      if (typeof e.code === "string" && /^ERR_(COST|ANTHROPIC)_/.test(e.code)) run.errorCode = e.code;\n', ""]],
  ["Settings gets no built-in rows", "storage", ["      builtinPrices: builtinPriceInfo(this.settings.modelPrices),\n", ""]],
  ["unchanged built-in saved as owner price", "price", ["      if (!same) out[model] = entry;", "      out[model] = entry;"]],
  ["price range unchecked", "price", ["!Number.isFinite(value) || value < 0 || value > 1000", "!Number.isFinite(value)"]],
  ["required price field optional", "price", ["      if (required) throw new Error", "      if (false) throw new Error"]],
  ["no fix offered for a price refusal", "price", ['if (code === "ERR_COST_PRICE") return', "if (false) return"]],
  ["workspace header not sent", "providers", ["    if (workspaceId) headers[\"anthropic-workspace-id\"] = workspaceId;\n", ""]],
  ["workspace 400 not mapped", "providers", ["if (provider === \"anthropic\" && isUnscopedKeyError(response.status, detail))", "if (false)"]],
  ["workspace ID format unchecked", "workspace", ["const WORKSPACE_ID = /^wrkspc_[A-Za-z0-9]{1,64}$/;", "const WORKSPACE_ID = /^/;"]],
  ["Settings drops the workspace ID", "storage", ["        if (workspaceId) profiles[name].workspaceId = workspaceId;\n", ""]],
  ["registry drops the workspace ID", "registry", ["      if (workspaceId) result.workspaceId = workspaceId;\n", ""]],
  ["workspace code not carried", "runtime", ["/^ERR_(COST|ANTHROPIC)_/", "/^ERR_COST_/"]],
  ["no fix offered for the workspace refusal", "price", ["if (code === \"ERR_ANTHROPIC_WORKSPACE\") return", "if (false) return"]],
  ["receipt ignores the price", "runtime", ["const turnCost = costOf(price, reply.usage);", "const turnCost = null;"]],
  ["receipt uses another price key", "runtime", ["const priceKey = profile.provider + \"/\" + profile.model;", "const priceKey = profile.model;"]],
  ["unreported usage priced", "runtime", ["  if (run.usage.available === false)\n    return { cost: null, costNote: \"Pemakaian", "  if (false)\n    return { cost: null, costNote: \"Pemakaian"]],
  ["cost formula prices output as input", "meter", ["n(\"output\") * price.output", "n(\"output\") * price.input"]],
  ["unpriced model offered", "taskmodel", ["        : !local && !prices[key]", "        : false"]],
  ["light task not cheapest", "taskmodel", ["    light\n      ? unitPrice(a) - unitPrice(b)", "    false\n      ? unitPrice(a) - unitPrice(b)"]],
  ["caps ignored in Otomatis", "taskmodel", ["if (cap !== undefined && (spent[c.provider] || 0) >= cap) {", "if (false) {"]],
  ["Otomatis reason not recorded", "runtime", ["    if (autoPicked)\n      note({ type: \"model.dipilih\"", "    if (false)\n      note({ type: \"model.dipilih\""]],
  ["Otomatis falls back to priority order", "runtime", ["      autoPicked?.profile ||\n", ""]],
  ["unpriced option enabled", "choice", ["        disabled: !c.usable,", "        disabled: false,"]],
  ["unbilled refusals keep the worst case", "meter", ["|| UNBILLED_STATUS.includes(error?.status)) {", ") {"]],
  ["429 and 5xx released as unbilled", "meter", ["const UNBILLED_STATUS = [400, 401, 403, 404, 413];", "const UNBILLED_STATUS = [400, 401, 403, 404, 413, 429, 500, 529];"]],
  ["released call not counted", "meter", ["CostMeter.#apply(ledger, keys, { calls: 1, failed: 1, unpriced: reservation.unpriced, usd: price ? 0 : null }, 1);", ""]],
  ["provider error carries no status", "providers", ["      { status: response.status },\n", "      {},\n"]],
  ["zero paid price accepted", "meter", [" || !(price.input > 0 && price.output > 0))", ")"]],
  ["Settings accepts a zero price", "price", ["        if (required && v === 0) throw new Error", "        if (false) throw new Error"]],
  ["not-sent errors not marked", "providers", ["    if (!state.sent && error && typeof error === \"object\") error.notSent = true;\n", ""]],
  ["sent never recorded", "providers", ["  state.sent = true;\n", ""]],
  ["not-sent failures keep the worst case", "meter", ["error?.notSent === true || ", ""]],
  ["runtime bypasses the meter", "runtime", ["(this.meter ? this.meter.call(req, provider) : provider(req))", "provider(req)"]],
  ["no local duration cap", "runtime", ["          this.now() - runStartedAt > localRunMinutes * 60000\n", "          false\n"]],
  ["tampered duration accepted", "runtime", ["        this.store.settings.localRunMinutes <= 480\n", "        true\n"]],
  ["caps not merged on save", "storage", ["      dailyCaps: mergeCaps(this.settings.dailyCaps, input.dailyCaps),", "      dailyCaps: input.dailyCaps ?? this.settings.dailyCaps,"]],
  ["server grants writes anywhere", "bridge", ["        if (p.yes && !canGrantWrites(workspace()).ok)\n", "        if (false)\n"]],
  ["worktree check passes the main checkout", "worktree", ['    if (canonical(gitDir) === canonical(common)) return { ok: false, reason: "bukan worktree terpisah (checkout utama)" };\n', ""]],
  ["worktree check passes main branches", "worktree", ['    if (["main", "master", "head"].includes(branch.toLowerCase()))', "    if (false)"]],
  ["worktree check case-sensitive", "worktree", ['["main", "master", "head"].includes(branch.toLowerCase())', '["main", "master", "HEAD"].includes(branch)']],
  ["worktree check passes subfolders", "worktree", ['    if (canonical(top) !== canonical(workspace)) return { ok: false, reason: "workspace bukan akar worktree" };\n', ""]],
  ["CLI approves non-file tools", "cli", ['        ["write_file", "edit_file"].includes(item.tool) &&\n', ""]],
  ["CLI approves non-approvable writes", "cli", ["        item.approvable === true &&\n", ""]],
  ["CLI approves another task's approvals", "cli", ["      if (item.operationId !== op.operationId) continue;\n", ""]],
  ["CLI does not retry a lost start", "cli", ["      if (attempt >= 3 || !/timed out|connection failed/i.test(error.message)) throw error;", "      throw error;"]],
  ["CLI hides the request id", "cli", ['  console.error("migango-tugas: requestId " + requestId);\n', ""]],
  // Not listed: the input-price max (Math.max(input, cacheCreated)) only raises the worst case for
  // models whose cache-write price exceeds input; no default price table has such a model yet.
];

async function verdict(key, text) {
  const source = path.resolve(here, "../..", sources[key]);
  const file = path.join(path.dirname(source), `.mutant-${randomUUID()}.mjs`);
  await fs.writeFile(file, text);
  try {
    // The CLI runs as its own process in its tests, so its mutant replaces the file it spawns.
    const env = { ...process.env, MUTANT_RUNTIME: file, MUTANT_TARGET: "/" + sources[key] };
    let restore = null;
    if (key === "cli" || key === "worktree" || key === "price" || key === "choice") {
      restore = await fs.readFile(source);
      await fs.writeFile(source, text);
    }
    try {
      const r = spawnSync(process.execPath, ["--import", hook, "--test", ...suites], { env, encoding: "utf8", timeout: 240000 });
      const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
      return { exit: r.status, failed };
    } finally {
      if (restore) await fs.writeFile(source, restore);
    }
  } finally {
    await fs.rm(file, { force: true });
  }
}

const originals = {};
for (const [key, rel] of Object.entries(sources))
  originals[key] = (await fs.readFile(path.resolve(here, "../..", rel), "utf8")).replace(/\r\n/g, "\n");

let ok = true;
const control = await verdict("meter", originals.meter);
console.log(`control: ${control.exit === 0 ? "PASS" : "FAIL " + control.failed.join(", ")}`);
if (control.exit !== 0) ok = false;
for (const [name, key, ...pairs] of MUTANTS) {
  if (pairs.some(([from]) => !originals[key].includes(from))) {
    console.log(`mutant ${name}: NOT APPLICABLE (pattern missing)`);
    ok = false;
    continue;
  }
  const result = await verdict(key, pairs.reduce((text, [from, to]) => text.replace(from, to), originals[key]));
  // A crash, syntax error or timeout is not a kill: a named test must fail.
  const killed = Number.isInteger(result.exit) && result.exit !== 0 && result.failed.length > 0;
  console.log(`mutant ${name}: ${killed ? "KILLED by " + result.failed.slice(0, 3).join(" | ") : "SURVIVED"}`);
  if (!killed) ok = false;
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
