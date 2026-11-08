// ARS-014 §4: screen_capture + ocr_read. The OS layer is always a fake here: no real screen,
// window or PowerShell action happens during tests. Artifacts go to a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ScreenOcr, SCREEN_LIMITS } from "../../src/tools/screen-ocr.mjs";
import { Tools, definitions, TOOL_GROUPS } from "../../src/tools/registry.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const sig = () => new AbortController().signal;

function fakeOs(overrides = {}) {
  const log = [];
  const state = {
    windows: [
      { handle: "101", pid: 500, title: "Notepad - catatan.txt" },
      { handle: "202", pid: 77, title: "miganGO" },
      { handle: "303", pid: 600, title: "Password Manager - Vault" },
    ],
  };
  const layer = {
    log,
    state,
    async windows() { log.push("windows"); return state.windows.map((w) => ({ ...w })); },
    async hideSelf() { log.push("hide"); return true; },
    async showSelf() { log.push("show"); },
    async capture(target) { log.push("capture:" + target.target + ":" + (target.handle || "")); return { png: PNG, width: 640, height: 480 }; },
    async ocr({ file, language }) { log.push("ocr:" + language + ":" + path.basename(file)); return { text: "Halo dunia", lines: [{ text: "Halo dunia", box: { x: 1, y: 2, w: 3, h: 4 } }] }; },
    ...overrides,
  };
  return layer;
}

async function setup(overrides = {}, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "screen-ocr-"));
  const layer = fakeOs(overrides);
  const screen = new ScreenOcr({ os: layer, artifactDir: dir, selfPid: 77, ...extra });
  return { dir, layer, screen };
}

test("window capture is revalidated after approval and rejects a changed title", async () => {
  const { screen, layer } = await setup();
  const obs = await screen.prepare({ target: "jendela", handle: "101", pid: 500 }, sig());
  assert.equal(obs.title, "Notepad - catatan.txt");
  layer.state.windows[0].title = "Notepad - rahasia.txt";
  await assert.rejects(screen.capture(obs, sig()), /changed/i);
  assert.ok(!layer.log.some((l) => l.startsWith("capture")));
});

test("window capture rejects a window whose pid changed (stale handle)", async () => {
  const { screen, layer } = await setup();
  const obs = await screen.prepare({ target: "jendela", handle: "101", pid: 500 }, sig());
  layer.state.windows[0].pid = 999;
  await assert.rejects(screen.capture(obs, sig()), /changed|stale/i);
});

test("own app window and sensitive titles are refused before capture", async () => {
  const { screen } = await setup();
  await assert.rejects(screen.prepare({ target: "jendela", handle: "202", pid: 77 }, sig()), /own/i);
  await assert.rejects(screen.prepare({ target: "jendela", handle: "303", pid: 600 }, sig()), /sensitive/i);
});

test("sensitive title appearing after approval is refused at capture time", async () => {
  const { screen, layer } = await setup();
  const obs = await screen.prepare({ target: "jendela", handle: "101", pid: 500 }, sig());
  obs.title = "Login - kata sandi"; // tampered observation must still be checked
  layer.state.windows[0].title = "Login - kata sandi";
  await assert.rejects(screen.capture(obs, sig()), /sensitive/i);
});

test("full screen hides the app first and aborts if hiding fails", async () => {
  const { screen, layer } = await setup({ async hideSelf() { return false; } });
  const obs = await screen.prepare({ target: "layar" }, sig());
  await assert.rejects(screen.capture(obs, sig()), /hide/i);
  assert.ok(!layer.log.some((l) => l.startsWith("capture")));
});

test("full screen capture writes a PNG artifact with sha256 and restores the app", async () => {
  const { screen, layer, dir } = await setup();
  const obs = await screen.prepare({ target: "layar" }, sig());
  const r = await screen.capture(obs, sig());
  assert.deepEqual(layer.log, ["hide", "capture:layar:", "show"]);
  assert.equal(r.width, 640);
  assert.equal(r.sha256, createHash("sha256").update(PNG).digest("hex"));
  assert.equal(r.sentToModel, false);
  assert.match(r.artifact, /^[0-9a-f-]{36}$/);
  const files = await fs.readdir(dir);
  assert.equal(files.length, 1);
  assert.ok(files[0].endsWith(".png"));
});

test("app is restored even when capture throws", async () => {
  const { screen, layer } = await setup({ async capture() { throw Error("boom"); } });
  await assert.rejects(screen.capture(await screen.prepare({ target: "layar" }, sig()), sig()), /boom/);
  assert.equal(layer.log.at(-1), "show");
});

test("oversized or non-PNG images are refused and nothing is written", async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(SCREEN_LIMITS.maxBytes)]);
  const a = await setup({ async capture() { return { png: big, width: 10, height: 10 }; } });
  await assert.rejects(a.screen.capture(await a.screen.prepare({ target: "layar" }, sig()), sig()), /8 MB|too large/i);
  assert.equal((await fs.readdir(a.dir)).length, 0);
  const b = await setup({ async capture() { return { png: Buffer.from("GIF89a"), width: 10, height: 10 }; } });
  await assert.rejects(b.screen.capture(await b.screen.prepare({ target: "layar" }, sig()), sig()), /PNG/);
  const b2 = await setup({ async capture() { return { png: Buffer.from("GIF89a-long-enough-but-not-png"), width: 10, height: 10 }; } });
  await assert.rejects(b2.screen.capture(await b2.screen.prepare({ target: "layar" }, sig()), sig()), /PNG/);
  assert.equal((await fs.readdir(b2.dir)).length, 0);
  const c = await setup({ async capture() { return { png: PNG, width: 0, height: 99999 }; } });
  await assert.rejects(c.screen.capture(await c.screen.prepare({ target: "layar" }, sig()), sig()), /dimension/i);
});

test("artifact count per session is capped", async () => {
  const { screen } = await setup({}, { limits: { maxArtifacts: 2 } });
  const obs = await screen.prepare({ target: "layar" }, sig());
  await screen.capture(obs, sig());
  await screen.capture(obs, sig());
  await assert.rejects(screen.capture(obs, sig()), /limit/i);
});

test("ocr output is labelled untrusted and bounded", async () => {
  const long = "x".repeat(SCREEN_LIMITS.maxText + 500);
  const { screen } = await setup({ async ocr() { return { text: long, lines: Array.from({ length: 500 }, () => ({ text: "a", box: { x: 0, y: 0, w: 1, h: 1 } })) }; } });
  const shot = await screen.capture(await screen.prepare({ target: "layar" }, sig()), sig());
  const r = await screen.ocr({ artifact: shot.artifact, language: "id" }, sig());
  assert.equal(r.trust, "untrusted");
  assert.match(r.notice, /not instructions/i);
  assert.equal(r.text.length, SCREEN_LIMITS.maxText);
  assert.equal(r.truncated, true);
  assert.ok(r.lines.length <= SCREEN_LIMITS.maxLines);
  assert.equal(r.engine, "Windows.Media.Ocr");
});

test("ocr only reads artifacts of this session and refuses tampered files", async () => {
  const { screen, layer, dir } = await setup();
  await assert.rejects(screen.ocr({ artifact: "00000000-0000-4000-8000-000000000000" }, sig()), /unknown/i);
  await assert.rejects(screen.ocr({ artifact: "../../etc/passwd" }, sig()), /unknown|invalid/i);
  const other = await setup();
  const foreign = await other.screen.capture(await other.screen.prepare({ target: "layar" }, sig()), sig());
  await assert.rejects(screen.ocr({ artifact: foreign.artifact }, sig()), /unknown/i);
  const shot = await screen.capture(await screen.prepare({ target: "layar" }, sig()), sig());
  const [file] = await fs.readdir(dir);
  await fs.writeFile(path.join(dir, file), Buffer.concat([PNG, Buffer.from("x")]));
  await assert.rejects(screen.ocr({ artifact: shot.artifact }, sig()), /changed|hash/i);
  assert.ok(!layer.log.some((l) => l.startsWith("ocr")));
});

test("ocr language is restricted to id or en", async () => {
  const { screen, layer } = await setup();
  const shot = await screen.capture(await screen.prepare({ target: "layar" }, sig()), sig());
  await assert.rejects(screen.ocr({ artifact: shot.artifact, language: "fr; Remove-Item" }, sig()), /language/i);
  await screen.ocr({ artifact: shot.artifact }, sig());
  assert.ok(layer.log.some((l) => l.startsWith("ocr:id:")));
});

test("registry: screen_capture requires approval, ocr_read does not, both in desktop group", async () => {
  assert.ok(definitions.some((d) => d.name === "screen_capture"));
  assert.ok(definitions.some((d) => d.name === "ocr_read"));
  assert.ok(TOOL_GROUPS.desktop.includes("screen_capture"));
  assert.ok(TOOL_GROUPS.desktop.includes("ocr_read"));
  const { screen, layer } = await setup();
  const asked = [];
  let answer = false;
  const tools = new Tools({
    workspace: { root: "/fixture" },
    approvals: { async request(name, args) { asked.push({ name, args }); return answer; } },
    screen,
  });
  await assert.rejects(tools.execute({ name: "screen_capture", args: { target: "layar" } }, sig()), /rejected/);
  assert.equal(asked[0].name, "screen_capture");
  assert.equal(asked[0].args.observation.target, "layar");
  assert.ok(!layer.log.some((l) => l.startsWith("capture")));
  answer = true;
  const shot = await tools.execute({ name: "screen_capture", args: { target: "layar" } }, sig());
  assert.equal(shot.sentToModel, false);
  const n = asked.length;
  const r = await tools.execute({ name: "ocr_read", args: { artifact: shot.artifact } }, sig());
  assert.equal(asked.length, n);
  assert.equal(r.trust, "untrusted");
});

test("registry: window capture passes handle/pid to approval and rejects bad args", async () => {
  const { screen } = await setup();
  const asked = [];
  const tools = new Tools({
    workspace: { root: "/fixture" },
    approvals: { async request(name, args) { asked.push(args); return true; } },
    screen,
  });
  await tools.execute({ name: "screen_capture", args: { target: "jendela", handle: "101", pid: 500 } }, sig());
  assert.equal(asked[0].observation.title, "Notepad - catatan.txt");
  await assert.rejects(tools.execute({ name: "screen_capture", args: { target: "jendela" } }, sig()), /handle|pid/i);
  await assert.rejects(tools.execute({ name: "screen_capture", args: { target: "semua" } }, sig()), /Invalid/);
  const bare = new Tools({ workspace: { root: "/fixture" }, approvals: { async request() { return true; } } });
  await assert.rejects(bare.execute({ name: "screen_capture", args: { target: "layar" } }, sig()), /not configured/i);
});
