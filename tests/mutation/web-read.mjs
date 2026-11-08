// Mutation check for the web_read guard (06xd). Each mutant removes one guarantee in place;
// the web_read suite must fail by a named test; the file is restored.
// Run: node tests/mutation/web-read.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { web: "src/core/browser-terisolasi.mjs", registry: "src/tools/registry.mjs" };
const suites = { web: "tests/unit/web-read.test.mjs", registry: "tests/unit/web-read-registry.test.mjs" };
const MUTANTS = [
  ["DNS answers not checked", "web", '  for (const a of addresses) if (!isPublicAddress(a)) throw denied("Host mengarah ke alamat bukan publik");\n', ""],
  ["redirect hops not re-checked", "web", "    const checked = await checkResolved(current, lookup);", "    const checked = hop === 0 ? await checkResolved(current, lookup) : { url: new URL(current).href, host: new URL(current).hostname, addresses: [\"93.184.216.34\"] };"],
  ["redirect count unlimited", "web", "if (hop + 1 > lim.maxRedirects)", "if (false)"],
  ["UNTRUSTED label dropped", "web", "    return {\n      trust: UNTRUSTED,\n", "    return {\n"],
  ["streaming size limit dropped", "web", "    if (total > maxBytes) {", "    if (false) {"],
  ["declared size limit dropped", "web", "  if (Number.isFinite(declared) && declared > maxBytes) {", "  if (false) {"],
  ["private literal IP accepted", "web", '    if (!isPublicAddress(host)) throw denied("Alamat IP bukan publik");\n', ""],
  ["registry label re-application dropped", "registry", "          return { ...page, trust: UNTRUSTED };", "          return page;"],
  ["registry web_read moved behind approval", "registry", "      // Read-only public page fetch; private/local targets refused per hop; output untrusted.\n      \"web_read\",\n", ""],
  ["timeout not enforced", "web", "    return await Promise.race([fetchPage(input, { transport, lookup, lim, signal: combined }), aborted]);", "    return await fetchPage(input, { transport, lookup, lim, signal: combined });"],
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
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=5000", path.join(root, suites[key])], { encoding: "utf8", timeout: 60000 });
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
