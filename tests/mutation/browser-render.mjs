// Mutation check for the on-demand render guard (06xh). Each mutant removes one guarantee in place;
// the browser-render suite must fail by a named test; the file is restored.
// Run: node tests/mutation/browser-render.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const files = { render: "src/desktop/browser-render.mjs", staged: "src/core/web-read-bertahap.mjs" };
const suites = { render: "tests/unit/browser-render.test.mjs", staged: "tests/unit/web-read-bertahap.test.mjs" };
const MUTANTS = [
  ["nodeIntegration true", "render", "    nodeIntegration: false,\n", "    nodeIntegration: true,\n"],
  ["persist partition", "render", 'export const PARTITION_PREFIX = "mg-render-";', 'export const PARTITION_PREFIX = "persist:mg-render-";'],
  ["sandbox false", "render", "    sandbox: true,\n", "    sandbox: false,\n"],
  ["contextIsolation false", "render", "    contextIsolation: true,\n", "    contextIsolation: false,\n"],
  ["subresource DNS not checked", "render", "      return cache.get(key);", "      return true;"],
  // Removing the explicit http(s) check is an equivalent mutant (checkResolved also refuses other
  // schemes), so the scheme guard is tested through the local-scheme allowlist instead.
  ["file scheme treated as local", "render", 'new Set(["data:", "blob:"])', 'new Set(["data:", "blob:", "file:"])'],
  ["start URL not checked before window", "render", "        const checked = await checkResolved(input, lookup);", "        const checked = { url: new URL(input).href };"],
  ["window not destroyed on timeout", "render", "      clearTimeout(timer);\n      destroy(win);\n", "      clearTimeout(timer);\n"],
  ["timeout not enforced", "render", "      return await Promise.race([work, aborted]);", "      return await work;"],
  ["concurrency unlimited", "render", "    if (active < lim.maxConcurrent) {", "    if (true) {"],
  ["permission granted", "render", "callback) => callback(false));", "callback) => callback(true));"],
  ["popup allowed", "render", '() => ({ action: "deny" })', '() => ({ action: "allow" })'],
  ["download not prevented", "render", "      event.preventDefault();\n", ""],
  ["temporary storage not cleared", "render", "          await ses.clearStorageData();", "          void 0;"],
  ["threshold off by one", "staged", "export const MIN_STATIC_CHARS = 200;", "export const MIN_STATIC_CHARS = 199;"],
  ["selalu falls back silently", "staged", '    if (render === "selalu") throw failed("Render tidak tersedia', '    if (false) throw failed("Render tidak tersedia'],
  ["selalu render error swallowed", "staged", '    if (render === "selalu") throw error;', ""],
  ["static denial rendered anyway", "staged", "  const statis = await webRead(input, { signal, ...rest });", "  const statis = await webRead(input, { signal, ...rest }).catch(() => ({ teks: \"\", byte: 0 }));"],
  ["unknown mode accepted", "staged", "  if (!RENDER_MODES.includes(render))", "  if (false)"],
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
