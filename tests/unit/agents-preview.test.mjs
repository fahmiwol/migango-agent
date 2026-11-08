// ARS-004 §13: Canvas-like artifact preview. The guest is isolated (no preload, no node), reads the
// workspace read-only within the artifact's folder, and cannot reach the network, navigate away,
// open popups, ask for permissions or download. Pure Node with fake Electron objects.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Workspace } from "../../src/tools/workspace.mjs";

const load = () => import("../../src/desktop/preview.mjs");
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mg-preview-"));
  await fs.mkdir(path.join(root, "app", "css"), { recursive: true });
  await fs.mkdir(path.join(root, "other"));
  await fs.writeFile(path.join(root, "app", "index.html"), "<h1>Kalkulator</h1>");
  await fs.writeFile(path.join(root, "app", "css", "style.css"), "h1{color:red}");
  await fs.writeFile(path.join(root, "app", ".env"), "KEY=fixture-only");
  await fs.writeFile(path.join(root, "other", "private.txt"), "not in scope");
  await fs.writeFile(path.join(root, "tool.exe"), "MZ");
  const outside = path.join(path.dirname(root), path.basename(root) + "-outside.txt");
  await fs.writeFile(outside, "outside workspace");
  return { root, ws: new Workspace(root) };
}

test("open() only previews supported files inside the workspace", async () => {
  const { PreviewRegistry } = await load();
  const { ws } = await fixture();
  const reg = new PreviewRegistry();
  const p = await reg.open({ workspace: ws, path: "app/index.html" });
  assert.match(p.token, /^[a-f0-9]{32}$/);
  assert.equal(p.url, `mgpreview://${p.token}/index.html`);
  for (const bad of ["tool.exe", "app/.env", "../x.html", "C:/Windows/win.ini", "app/missing.html"])
    await assert.rejects(() => reg.open({ workspace: ws, path: bad }), undefined, bad);
});

test("respond() serves the scope read-only and refuses everything else", async () => {
  const { PreviewRegistry, PREVIEW_CSP } = await load();
  const { ws } = await fixture();
  const reg = new PreviewRegistry();
  const { token } = await reg.open({ workspace: ws, path: "app/index.html" });
  const ok = await reg.respond(`mgpreview://${token}/index.html`);
  assert.equal(ok.status, 200);
  assert.match(ok.mimeType, /text\/html/);
  assert.equal(ok.headers["Content-Security-Policy"], PREVIEW_CSP);
  assert.equal(ok.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(Buffer.from(ok.data).toString(), "<h1>Kalkulator</h1>");
  assert.equal((await reg.respond(`mgpreview://${token}/css/style.css`)).status, 200);
  const refused = {
    otherToken: [`mgpreview://${"0".repeat(32)}/index.html`, 404],
    encodedTraversal: [`mgpreview://${token}/%2e%2e/other/private.txt`, 403],
    backslashTraversal: [`mgpreview://${token}/..%5Cother%5Cprivate.txt`, 403],
    secretInScope: [`mgpreview://${token}/.env`, 403],
    otherScheme: [`file:///C:/Windows/win.ini`, 403],
  };
  for (const [name, [url, status]] of Object.entries(refused))
    assert.equal((await reg.respond(url)).status, status, name);
});

test("respond() refuses files over 8 MB and closed previews", async () => {
  const { PreviewRegistry } = await load();
  const { root, ws } = await fixture();
  await fs.writeFile(path.join(root, "app", "big.json"), Buffer.alloc(8 * 1024 * 1024 + 1, 32));
  const reg = new PreviewRegistry();
  const { token } = await reg.open({ workspace: ws, path: "app/index.html" });
  assert.equal((await reg.respond(`mgpreview://${token}/big.json`)).status, 413);
  reg.close(token);
  assert.equal((await reg.respond(`mgpreview://${token}/index.html`)).status, 404);
});

test("CSP keeps the guest self-contained", async () => {
  const { PREVIEW_CSP } = await load();
  for (const rule of ["default-src 'self'", "connect-src 'self'", "frame-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"])
    assert.ok(PREVIEW_CSP.includes(rule), rule);
  assert.doesNotMatch(PREVIEW_CSP, /https?:|\*/);
});

test("guest web preferences: no preload, no node, sandboxed, isolated", async () => {
  const { guestWebPreferences } = await load();
  const prefs = guestWebPreferences({ id: "fake-session" });
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.deepEqual(prefs.session, { id: "fake-session" });
});

function fakeSession() {
  const s = { handlers: {}, on: (name, fn) => (s.handlers[name] = fn) };
  s.setPermissionRequestHandler = (fn) => (s.permissionRequest = fn);
  s.setPermissionCheckHandler = (fn) => (s.permissionCheck = fn);
  s.webRequest = { onBeforeRequest: (filter, fn) => (s.beforeRequest = fn) };
  return s;
}
const decide = (s, url) => new Promise((resolve) => s.beforeRequest({ url }, (r) => resolve(!r.cancel)));

test("preview session allows only its own mgpreview origin; network, localhost and file are cancelled", async () => {
  const { hardenPreviewSession } = await load();
  const s = fakeSession();
  const token = "a".repeat(32);
  hardenPreviewSession(s, token);
  assert.equal(await decide(s, `mgpreview://${token}/index.html`), true);
  assert.equal(await decide(s, "data:image/png;base64,AA=="), true);
  for (const url of ["https://example.com/", "http://127.0.0.1:11434/api/chat", "file:///C:/Windows/win.ini", `mgpreview://${"b".repeat(32)}/x`, "ws://example.com/"])
    assert.equal(await decide(s, url), false, url);
  let granted;
  s.permissionRequest({}, "media", (yes) => (granted = yes));
  assert.equal(granted, false);
  assert.equal(s.permissionCheck(), false);
  let prevented = false, cancelled = false;
  s.handlers["will-download"]({ preventDefault: () => (prevented = true) }, { cancel: () => (cancelled = true) });
  assert.ok(prevented && cancelled);
});

test("preview contents deny popups, outside navigation and webviews", async () => {
  const { hardenPreviewContents } = await load();
  const token = "a".repeat(32);
  const wc = { handlers: {}, on: (n, fn) => (wc.handlers[n] = fn), setWindowOpenHandler: (fn) => (wc.open = fn) };
  hardenPreviewContents(wc, token);
  assert.deepEqual(wc.open({ url: "https://example.com" }), { action: "deny" });
  const nav = (event, url) => {
    let blocked = false;
    wc.handlers[event]({ preventDefault: () => (blocked = true) }, url);
    return blocked;
  };
  assert.equal(nav("will-navigate", `mgpreview://${token}/about.html`), false);
  for (const url of ["https://example.com", "file:///C:/", `mgpreview://${"b".repeat(32)}/x`])
    for (const e of ["will-navigate", "will-redirect"]) assert.equal(nav(e, url), true, e + " " + url);
  let attach = false;
  wc.handlers["will-attach-webview"]({ preventDefault: () => (attach = true) });
  assert.ok(attach);
});

test("a finished write inside an open preview's scope produces preview.invalidated; others do not", async () => {
  const { PreviewRegistry } = await load();
  const { ws } = await fixture();
  const reg = new PreviewRegistry();
  const { token } = await reg.open({ workspace: ws, path: "app/index.html" });
  const start = (id, p, name = "write_file") => ({ type: "tool-start", id, name, args: { path: p } });
  const done = (id, name = "write_file") => ({ type: "tool-result", id, name, result: "{}" });
  // Nothing on start: the file is not written yet.
  assert.deepEqual(reg.observe(start("w1", "app/css/style.css")), []);
  assert.deepEqual(reg.observe(done("w1")), [{ type: "preview.invalidated", token, path: "app/css/style.css" }]);
  reg.observe(start("w2", "app/index.html", "edit_file"));
  assert.equal(reg.observe(done("w2", "edit_file")).length, 1);
  reg.observe(start("w3", "other/private.txt"));
  assert.deepEqual(reg.observe(done("w3")), []);
  reg.observe({ type: "tool-start", id: "r1", name: "read_file", args: { path: "app/index.html" } });
  assert.deepEqual(reg.observe(done("r1", "read_file")), []);
});
