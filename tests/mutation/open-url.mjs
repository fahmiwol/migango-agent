// Mutation check for the open_url guards (06xf part 1). Each mutant undoes one guarantee in place;
// tests/unit/open-url.test.mjs must fail by a named test; the file is restored.
// Run: node tests/mutation/open-url.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { guard: "src/core/open-url.mjs", registry: "src/tools/registry.mjs", bridge: "src/desktop/bridge-controller.mjs" };
const MUTANTS = [
  ["scheme check dropped", "guard", 'if (parsed.protocol !== "http:" && parsed.protocol !== "https:")', "if (false)"],
  ["credentials accepted", "guard", "if (parsed.username || parsed.password || /^[a-z]+:\\/\\/[^/?#]*@/i.test(url))", "if (false)"],
  ["control characters accepted", "guard", "if (/[\\u0000-\\u0020\\u007f-\\u009f]/.test(url)) throw", "if (false) throw"],
  ["URL limit relaxed", "guard", "maxUrl: 2048", "maxUrl: 4096"],
  ["wildcard match is a bare endsWith", "guard", 'if (h.length > base.length + 1 && h.endsWith("." + base)) return true;', "if (h.endsWith(base)) return true;"],
  ["exact entry match is endsWith", "guard", "} else if (h === entry) return true;", "} else if (h.endsWith(entry)) return true;"],
  ["wildcard on a TLD accepted", "guard", '(wild && (!host.includes(".") || /^[\\d.]+$/.test(host)))', "(wild && false)"],
  ["host list over 50 accepted", "guard", "if (out.length > OPEN_URL_LIMITS.maxHosts)", "if (false)"],
  ["registry opens without asking", "registry", 'if (openUrl?.auto === true) automatic.add("open_url");', 'automatic.add("open_url");'],
  ["registry skips URL validation", "registry", "const target = periksaUrlBuka(args.url);", 'const target = { href: args.url, host: "" };'],
  ["registry opens the raw model string", "registry", "await this.openExternal(openUrl.href);", "await this.openExternal(args.url);"],
  ["invalid owner list fails open", "registry", "daftarIzin = \"tidak valid (\" + error.message + \"); setiap URL ditanyakan\";", "daftar = this.openUrlAllow(); daftarIzin = \"tidak valid\";"],
  ["bridge may approve open_url", "bridge", "const file = ['write_file', 'edit_file'].includes(item.tool);", "const file = ['write_file', 'edit_file', 'open_url'].includes(item.tool);"],
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
    const r = spawnSync(process.execPath, ["--test", path.join(root, "tests/unit/open-url.test.mjs")], { encoding: "utf8", timeout: 120000 });
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
