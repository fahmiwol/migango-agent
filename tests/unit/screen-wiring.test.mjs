// Wiring screen_capture + ocr_read into the desktop app (ARS-014 §4).
// The factory is tested with a fake BrowserWindow; main.mjs is checked by source because it
// needs Electron to run. No real screen is touched.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAppScreen } from "../../src/desktop/screen-wiring.mjs";
import { ScreenOcr, WindowsScreenOs } from "../../src/tools/screen-ocr.mjs";
import { Tools } from "../../src/tools/registry.mjs";

const mainSrc = await fs.readFile(
  path.resolve(import.meta.dirname, "../../src/desktop/main.mjs"),
  "utf8",
);
const root = path.join(os.tmpdir(), "migan-screen-wiring-data");
const noWait = async () => {};

function fakeWindow({ visible = true, hideWorks = true } = {}) {
  const w = {
    visible,
    destroyed: false,
    calls: [],
    isDestroyed: () => w.destroyed,
    isVisible: () => w.visible,
    hide() {
      w.calls.push("hide");
      if (hideWorks) w.visible = false;
    },
    show() {
      w.calls.push("show");
      w.visible = true;
    },
    showInactive() {
      w.calls.push("showInactive");
      w.visible = true;
    },
  };
  return w;
}

test("factory builds ScreenOcr on the Windows OS layer with app-data folders", () => {
  const desktop = { list: async () => ({ windows: [] }) };
  const screen = createAppScreen({ getWindow: () => null, dataRoot: root, desktop, wait: noWait });
  assert.ok(screen instanceof ScreenOcr);
  assert.ok(screen.os instanceof WindowsScreenOs);
  assert.equal(screen.os.desktop, desktop, "same desktop connector as desktop tools");
  assert.equal(screen.artifactDir, path.join(root, "artifacts", "screen"));
  assert.equal(screen.os.stagingDir, path.join(root, "artifacts", "screen-staging"));
  assert.equal(screen.selfPid, process.pid);
});

test("factory refuses a relative or missing data folder", () => {
  assert.throws(() => createAppScreen({ getWindow: () => null, dataRoot: "rel/data", desktop: {} }), /absolute app data folder/);
  assert.throws(() => createAppScreen({ getWindow: () => null, desktop: {} }), /absolute app data folder/);
});

test("hideSelf hides the main window and showSelf restores it", async () => {
  const w = fakeWindow();
  const screen = createAppScreen({ getWindow: () => w, dataRoot: root, desktop: {}, wait: noWait });
  assert.equal(await screen.os.hideSelf(), true);
  assert.equal(w.visible, false);
  await screen.os.showSelf();
  assert.equal(w.visible, true);
  assert.deepEqual(w.calls.slice(0, 1), ["hide"]);
});

test("hideSelf reports false when the window cannot be hidden", async () => {
  const stuck = fakeWindow({ hideWorks: false });
  const s1 = createAppScreen({ getWindow: () => stuck, dataRoot: root, desktop: {}, wait: noWait });
  assert.equal(await s1.os.hideSelf(), false);
  const s2 = createAppScreen({ getWindow: () => null, dataRoot: root, desktop: {}, wait: noWait });
  assert.equal(await s2.os.hideSelf(), false);
  const gone = fakeWindow();
  gone.destroyed = true;
  const s3 = createAppScreen({ getWindow: () => gone, dataRoot: root, desktop: {}, wait: noWait });
  assert.equal(await s3.os.hideSelf(), false);
});

test("showSelf does not pop up a window that was already hidden", async () => {
  const w = fakeWindow({ visible: false });
  const screen = createAppScreen({ getWindow: () => w, dataRoot: root, desktop: {}, wait: noWait });
  assert.equal(await screen.os.hideSelf(), true);
  await screen.os.showSelf();
  assert.equal(w.visible, false);
  assert.ok(!w.calls.includes("show") && !w.calls.includes("showInactive"));
});

test("full-screen capture through the wired screen waits for the window to hide", async () => {
  const w = fakeWindow();
  const order = [];
  const screen = createAppScreen({
    getWindow: () => w,
    dataRoot: root,
    desktop: {},
    wait: async () => order.push("wait:" + w.visible),
  });
  await screen.os.hideSelf();
  assert.deepEqual(order, ["wait:false"], "settle delay runs after hide");
});

test("wired Tools: screen_capture still asks the owner; ocr_read stays untrusted", async () => {
  const asked = [];
  const screen = {
    prepare: async () => ({ target: "layar" }),
    capture: async () => ({ artifact: "a" }),
    ocr: async () => ({ trust: "untrusted", text: "x" }),
  };
  const tools = new Tools({
    workspace: { root: "/fixture" },
    approvals: { request: async (name) => (asked.push(name), false) },
    screen,
  });
  const sig = new AbortController().signal;
  await assert.rejects(
    tools.execute({ name: "screen_capture", args: { target: "layar" } }, sig),
    /rejected/i,
  );
  assert.deepEqual(asked, ["screen_capture"]);
});

test("main.mjs builds the screen and passes it to Tools", () => {
  assert.match(mainSrc, /import \{ createAppScreen \} from "\.\/screen-wiring\.mjs";/);
  assert.match(mainSrc, /import \{ WindowsDesktop \} from "\.\.\/tools\/windows\.mjs";/);
  const create = mainSrc.match(/const screen = createAppScreen\(\{([\s\S]*?)\}\);/);
  assert.ok(create, "createAppScreen call present");
  assert.match(create[1], /getWindow: \(\) => window/);
  assert.match(create[1], /dataRoot: store\.root/);
  assert.match(create[1], /desktop,/);
  const block = mainSrc.match(/tools = new Tools\(\{([\s\S]*?)\n {6}\}\);/);
  assert.ok(block, "Tools construction present");
  assert.match(block[1], /\n {8}screen,(\n|$)/);
  assert.match(block[1], /\n {8}desktop,(\n|$)/);
  // Index order: screen is created before Tools.
  assert.ok(mainSrc.indexOf("const screen = createAppScreen(") < mainSrc.indexOf("tools = new Tools("));
});

test("main.mjs does not wire input control mode in this step", () => {
  assert.doesNotMatch(mainSrc, /mode-kendali/);
  assert.doesNotMatch(mainSrc, /ModeKendali/);
  const block = mainSrc.match(/tools = new Tools\(\{([\s\S]*?)\n {6}\}\);/);
  assert.doesNotMatch(block[1], /control/);
  assert.doesNotMatch(mainSrc, /artifactDir: .*workspace/i);
});
