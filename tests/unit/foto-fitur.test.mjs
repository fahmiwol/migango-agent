// 06u1: isolated feature screenshots. Guards: temp userData, hidden window, network blocked.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  windowOptions,
  blockDecision,
  makeUserDataPath,
  assertSafeUserData,
  forbiddenPath,
  visibleCount,
  STATES,
  fixtureFor,
  stubPreloadSource,
} from "../../scripts/foto-fitur.mjs";

const source = readFileSync(new URL("../../scripts/foto-fitur.mjs", import.meta.url), "utf8");

test("window is hidden and offscreen, isolated web preferences", () => {
  const o = windowOptions("C:/tmp/stub.cjs");
  assert.equal(o.show, false);
  assert.equal(o.webPreferences.offscreen, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.preload, "C:/tmp/stub.cjs");
  assert.equal(o.skipTaskbar, true);
});

test("network blocked: everything but file: is cancelled", () => {
  for (const url of ["https://api.openai.com/v1", "http://127.0.0.1:11434", "ws://x", "data:text/html,x", "devtools://x"])
    assert.equal(blockDecision(url).cancel, true, url);
  assert.equal(blockDecision("file:///C:/repo/ui/index.html").cancel, false);
});

test("userData is a fresh temp folder, never the real app profile", () => {
  const p = makeUserDataPath("abc");
  assert.ok(p.startsWith(path.resolve(os.tmpdir())), p);
  assert.equal(forbiddenPath(p), false);
  assert.doesNotThrow(() => assertSafeUserData(p));
  const real = path.join(os.homedir(), "AppData", "Roaming", "migan-workbench");
  assert.equal(forbiddenPath(real), true);
  assert.throws(() => assertSafeUserData(real), /userData/);
  assert.equal(forbiddenPath("C:\\Users\\x\\AppData\\Roaming\\Migan-Workbench\\vault"), true);
  assert.throws(() => assertSafeUserData(path.join(os.homedir(), "foto")), /userData/);
});

test("visible window count only counts visible windows", () => {
  assert.equal(visibleCount([{ isVisible: () => false }, { isVisible: () => false }]), 0);
  assert.equal(visibleCount([{ isVisible: () => true }]), 1);
});

test("script wiring: no main.mjs/vault/bridge, dialog replaced, temp removed, guards applied", () => {
  assert.doesNotMatch(source, /import\b[^;]*(desktop\/main\.mjs|vault|recovery|bridge)/i);
  assert.doesNotMatch(source, /require\(["'][^"']*(main\.mjs|vault|recovery|bridge)/i);
  assert.match(source, /dialog\.showErrorBox\s*=/);
  assert.match(source, /app\.setPath\(\s*["']userData["']/);
  assert.match(source, /assertSafeUserData\(/);
  assert.match(source, /onBeforeRequest\(/);
  assert.match(source, /blockDecision\(/);
  assert.match(source, /rmSync\(userData,/, "temp userData must be deleted after the run");
  assert.match(source, /windowsHide:\s*true/);
  assert.match(source, /visibleCount\(/);
  assert.match(source, /render terisolasi dari kode live b4ea5de, bukan tangkapan app pemilik/);
});

// 06u1 lanjutan: run 2 crashed (exit 0xFFFF7003) and left the run-1 report untouched.
// A crash must leave evidence: per-state flush, process-gone listeners, parent exit code.
test("crash leaves evidence: report flushed per state, process-gone logged, exit code recorded", () => {
  const loop = source.slice(source.indexOf("for (const state of STATES)"), source.indexOf("const touched"));
  assert.match(loop, /writeReport\(/, "report must be flushed inside the state loop");
  assert.match(source, /render-process-gone/);
  assert.match(source, /child-process-gone/);
  assert.match(source, /appendFileSync\(report/);
});

// 06u2: Settings > Connections with an EMPTY Gemini slot (no key, configured false).
test("f-koneksi-gemini: empty Gemini slot fixture, opened via settings, checked by id", () => {
  const state = STATES.find((s) => s.name === "f-koneksi-gemini");
  assert.ok(state, "state f-koneksi-gemini must exist");
  const f = fixtureFor(state);
  assert.equal(f.settings.configured.gemini, false);
  assert.ok(!(f.settings.credentialInfo || []).some((c) => c.provider === "gemini" && c.configured));
  // Fields showSettingsData reads must exist, or the dialog never renders.
  for (const k of ["profiles", "routes", "mcp", "taskModels", "devRoots"]) assert.ok(k in f.settings, k);
  // Other states keep the base fixture.
  assert.deepEqual(fixtureFor(STATES[0]).settings, fixtureFor({}).settings);
  assert.ok(state.nav.includes("#settingsBtn"));
  assert.ok(state.keys.includes("#geminiConfigured|Kosong: belum ada kunci tersimpan."));
  const stub = stubPreloadSource(["settings"], f);
  assert.doesNotMatch(stub, /AIza|sk-[A-Za-z0-9]/, "no key-like text in the stub");
  assert.match(source, /stubPreloadSource\([^)]*fixtureFor\(state\)/);
});

// Root cause of ERR_FAILED (-2): destroying the only window triggers Electron's default
// quit on window-all-closed, aborting the next state's loadURL. The runner must own quitting.
test("app does not auto-quit between states", () => {
  assert.match(source, /app\.on\(\s*["']window-all-closed["']/);
  const handler = source.slice(source.indexOf("window-all-closed"), source.indexOf("window-all-closed") + 200);
  assert.doesNotMatch(handler.split("\n")[0], /quit\(/);
});
