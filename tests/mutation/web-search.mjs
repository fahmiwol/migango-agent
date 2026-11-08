// Mutation check for web_search (06xe part 1). Each mutant removes one guarantee in place;
// the web_search suite must fail by a named test; the file is restored.
// Run: node tests/mutation/web-search.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { ws: "src/core/web-search.mjs", reg: "src/tools/registry.mjs" };
const suite = "tests/unit/web-search.test.mjs";
const MUTANTS = [
  ["result SSRF filter dropped", "ws", "        url = checkPublicURL(row.url).url;", "        url = new URL(row.url).href;"],
  ["per-engine 2 s interval dropped", "ws", "    if (start > t) await sleep(start - t, signal);\n", ""],
  ["cache dropped", "ws", "    if (hit && now() - hit.at < lim.cacheMs) {", "    if (false) {"],
  ["cache never expires", "ws", "    if (hit && now() - hit.at < lim.cacheMs) {", "    if (hit) {"],
  ["user-agent rotated", "ws", '    const headers = { "user-agent": USER_AGENT,', '    const headers = { "user-agent": USER_AGENT + " r" + Math.random(),'],
  ["explicit open engine without owner opt-in", "ws", '    if (ENGINES[mesin].jenis === "terbuka" && !izinkanTerbuka()) throw denied(', "    if (false) throw denied("],
  ["default open engine without owner opt-in", "ws", '      if (izinkanTerbuka()) return "ddg";', '      return "ddg";'],
  ["BYOK engine without key", "ws", '    if (ENGINES[mesin].jenis === "byok" && !kunci) throw denied(', "    if (false) throw denied("],
  ["max 10 results cap dropped", "ws", "    const jumlah = Math.min(n, lim.maxResults);", "    const jumlah = n;"],
  ["query length bounds dropped", "ws", "    if (q.length < lim.minQuery || q.length > lim.maxQuery) throw", "    if (false) throw"],
  ["bot page treated as zero results", "ws", "    if (!hasil.length && ENGINES[nama].blocked?.(body)) {", "    if (false) {"],
  ["registry label can be overridden by searcher", "reg", "          return { ...found, trust: UNTRUSTED, petunjuk: SEARCH_GUIDE };", "          return { trust: UNTRUSTED, petunjuk: SEARCH_GUIDE, ...found };"],
  ["registry web_search moved behind approval", "reg", '      // Read-only search; engines gated by owner Settings, result URLs SSRF-filtered, output untrusted.\n      "web_search",\n', ""],
  ["registry optional limit not checked", "reg", '    if (Object.hasOwn(args, "limit") &&', "    if (false &&"],
  ["registry optional engine not checked", "reg", '    if (Object.hasOwn(args, "engine") && !SEARCH_ENGINES.includes(args.engine))', "    if (false)"],
];
let ok = true;
for (const [name, key, from, to] of MUTANTS) {
  const file = path.join(root, files[key]);
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=5000", path.join(root, suite)], { encoding: "utf8", timeout: 60000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
