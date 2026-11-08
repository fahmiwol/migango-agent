// Mutation check for feed_read (06xe part 2). Each mutant removes one guarantee in place;
// the feed suite must fail by a named test; the file is restored.
// Run: node tests/mutation/feed-berita.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { fb: "src/core/feed-berita.mjs", reg: "src/tools/registry.mjs" };
const suite = "tests/unit/feed-berita.test.mjs";
const MUTANTS = [
  ["feed allowlist dropped", "fb", "    if (!daftar().feeds.includes(href)) throw denied(", "    if (false) throw denied("],
  ["owner list accepts http", "fb", '      if (u.protocol !== "https:") {', "      if (false) {"],
  ["owner list accepts private hosts", "fb", "      checkPublicURL(href);\n    } catch {\n      ditolak.push", "      void href;\n    } catch {\n      ditolak.push"],
  ["owner list max 20 dropped", "fb", "    if (feeds.length >= lim.maxFeeds) {", "    if (false) {"],
  ["item SSRF filter dropped", "fb", "      url = checkPublicURL(new URL(r.link, baseUrl).href).url;", "      url = new URL(r.link, baseUrl).href;"],
  ["DOCTYPE accepted", "fb", '    if (text.startsWith("<!", lt)) throw broken(', '    if (false) throw broken('],
  ["mismatched close tag accepted", "fb", "      if (stack.length === 1 || top.name !== name) {", "      if (stack.length === 1) {"],
  ["cache dropped", "fb", "    if (hit && now() - hit.at < lim.cacheMs) return", "    if (false) return"],
  ["cache never expires", "fb", "    if (hit && now() - hit.at < lim.cacheMs) return", "    if (hit) return"],
  ["redirect followed as success", "fb", "    if (status !== 200) {", "    if (false) {"],
  ["user-agent rotated", "fb", '      "user-agent": FEED_USER_AGENT,', '      "user-agent": FEED_USER_AGENT + " r" + Math.random(),'],
  ["registry label can be overridden by reader", "reg", "          return { ...news, trust: UNTRUSTED, petunjuk: FEED_GUIDE };", "          return { trust: UNTRUSTED, petunjuk: FEED_GUIDE, ...news };"],
  ["registry feed_read moved behind approval", "reg", '      // Read-only; only feeds on the owner\'s https list, item URLs SSRF-filtered, output untrusted.\n      "feed_read",\n', ""],
  ["registry optional limit not checked", "reg", '    if (Object.hasOwn(args, "limit") && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > FEED_LIMITS.maxItems))', "    if (false)"],
  ["registry optional url not checked", "reg", '    if (Object.hasOwn(args, "url") && (typeof args.url !== "string"', '    if (false && (typeof args.url !== "string"'],
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
