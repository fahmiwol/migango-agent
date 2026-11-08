// Mutation check for the built-in browser panel (06xj part 1). Each mutant removes one guarantee
// in place; the browser-panel suite must fail by a named test; the file is restored.
// Run: node tests/mutation/browser-panel.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "../..");
const FILE = path.join(root, "src/desktop/browser-panel.mjs");
const SUITE = path.join(root, "tests/unit/browser-panel.test.mjs");
const MUTANTS = [
  ["nodeIntegration true", "    nodeIntegration: false,\n", "    nodeIntegration: true,\n"],
  ["sandbox false", "    sandbox: true,\n", "    sandbox: false,\n"],
  ["contextIsolation false", "    contextIsolation: true,\n", "    contextIsolation: false,\n"],
  ["preload injected", "    spellcheck: false,\n", "    spellcheck: false,\n    preload: \"panel-preload.cjs\",\n"],
  ["subframe Node", "    nodeIntegrationInSubFrames: false,\n", "    nodeIntegrationInSubFrames: true,\n"],
  ["webview tag allowed", "    webviewTag: false,\n", "    webviewTag: true,\n"],
  ["partition is app partition", 'export const BROWSER_PARTITION = "persist:migango-browser";', 'export const BROWSER_PARTITION = "persist:migango";'],
  ["partition check removed", "  if (partition !== BROWSER_PARTITION)\n", "  if (false)\n"],
  ["permission granted", "callback) => callback(false));", "callback) => callback(true));"],
  ["permission check granted", "setPermissionCheckHandler(() => false)", "setPermissionCheckHandler(() => true)"],
  ["download not prevented", "      event.preventDefault();\n      item?.cancel?.();\n", ""],
  ["popup allowed", '() => ({ action: "deny" })', '() => ({ action: "allow" })'],
  ["webview attach allowed", '    wc.on("will-attach-webview", (event) => event.preventDefault());\n', ""],
  ["subresource DNS not checked", "      await checkResolved(u.href, lookup);\n      return true;", "      return true;"],
  ["file scheme treated as local", 'new Set(["data:", "blob:"])', 'new Set(["data:", "blob:", "file:"])'],
  ["top-level navigation unchecked", '    wc.on("will-navigate", topLevelCheck);\n', ""],
  ["buka DNS unchecked", "    await checkResolved(target, lookup);\n    await tab.view", "    await tab.view"],
  ["bukaTab DNS unchecked", "    if (target) await checkResolved(target, lookup);\n", ""],
  ["tab limit off by one", "    if (tabs.length >= PANEL_LIMITS.maxTabs)", "    if (tabs.length > PANEL_LIMITS.maxTabs)"],
  ["open_url guard bypassed", "    const { href } = periksaUrlBuka(find(id).view.webContents.getURL());", "    const href = find(id).view.webContents.getURL();"],
  ["tabs left open on wipe", "    for (const tab of tabs.splice(0)) release(tab);", "    tabs.splice(0);"],
  ["storage not cleared", "      await s.clearStorageData();\n", ""],
  ["wipe error swallowed", "      throw error;\n", ""],
];
let ok = true;
const orig = fs.readFileSync(FILE, "utf8");
for (const [name, from, to] of MUTANTS) {
  if (!orig.includes(from)) {
    console.log("NOT APPLICABLE " + name);
    ok = false;
    continue;
  }
  fs.writeFileSync(FILE, orig.replace(from, to));
  try {
    const r = spawnSync(process.execPath, ["--test", "--test-timeout=5000", SUITE], { encoding: "utf8", timeout: 60000 });
    const failed = [...r.stdout.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
    const killed = r.status !== 0 && failed.length > 0;
    console.log((killed ? "KILLED " : "SURVIVED ") + name + (killed ? " by " + failed[0] : ""));
    if (!killed) ok = false;
  } finally {
    fs.writeFileSync(FILE, orig);
  }
}
console.log(ok ? "MUTATION OK" : "MUTATION FAIL");
process.exitCode = ok ? 0 : 1;
