// Mutation check for the bridge route decision (markas, 27 Oct 2026): a caller-named route is
// allowed only while the bridge stays loopback-only with its token, unknown routes are refused
// and dollars stay with the cost meter. Each mutant breaks one guarantee in place; the named
// tests must fail; the file is restored. Run: node tests/mutation/bridge-route.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = {
  ctl: path.join(root, "src/desktop/bridge-controller.mjs"),
  bridge: path.join(root, "src/desktop/local-bridge.mjs"),
  runtime: path.join(root, "src/agents/runtime.mjs"),
};
const TESTS = ["tests/unit/bridge-route.test.mjs", "tests/unit/bridge-route-guards.test.mjs", "tests/unit/local-bridge.test.mjs"];
const MUTANTS = [
  ["unknown route accepted", "ctl", "if (p.route !== undefined && p.route !== 'auto' && (typeof p.route !== 'string' || !Object.hasOwn(ROUTES, p.route)))", "if (false)"],
  ["inherited key accepted as route", "ctl", "!Object.hasOwn(ROUTES, p.route)", "!(p.route in ROUTES)"],
  ["route not passed to the runtime", "ctl", "...(p.route && p.route !== 'auto' ? {routeOverride:p.route} : {})},", "},"],
  ["route missing from the replay fingerprint", "ctl", "p.modelId || null, p.route && p.route !== 'auto' ? p.route : null]);", "p.modelId || null]);"],
  ["bridge listens on every interface", "bridge", "server.listen(0, '127.0.0.1', resolve);", "server.listen(0, '0.0.0.0', resolve);"],
  ["bridge token not required", "bridge", "return reply(401, {error:'Bridge authorization required'});", "{}"],
  ["model calls bypass the cost meter", "runtime", "this.provider = (req) => (this.meter ? this.meter.call(req, provider) : provider(req));", "this.provider = (req) => provider(req);"],
];
let ok = true;
for (const [name, key, from, to] of MUTANTS) {
  const file = files[key];
  const orig = fs.readFileSync(file, "utf8");
  if (!orig.includes(from)) { console.log("NOT APPLICABLE " + name); ok = false; continue; }
  fs.writeFileSync(file, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-reporter=dot", ...TESTS], { cwd: root, encoding: "utf8", timeout: 120000 });
    if (r.status === 0) { console.log("SURVIVED " + name); ok = false; } else console.log("KILLED " + name);
  } finally {
    fs.writeFileSync(file, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
