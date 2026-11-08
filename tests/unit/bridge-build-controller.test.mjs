import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// Markas, 27 Oct 2026 ("ya build bridge"), conditions 1, 3, 4, 5 at the bridge boundary. The path
// guard itself (condition 2) is tests/unit/bridge-build-guard.test.mjs; loopback-only and the token
// stay covered by tests/unit/bridge-route-guards.test.mjs and tests/unit/local-bridge.test.mjs.
const root = process.platform === "win32" ? "C:\\qa\\build-haiku" : "/qa/build-haiku";
function ctl(over = {}) {
  const starts = [];
  const c = createBridgeController({ workspace: () => root, status: () => ({}), start: (payload, meta) => { starts.push({ payload, meta }); }, stop: () => {}, loadRun: async () => null, resolveApproval: () => true, ...over });
  return { c, starts };
}
const start = (c, p) => c.execute("start", { requestId: randomUUID(), expectedWorkspace: root, prompt: "bangun halaman", ...p });

test("build without an absolute buildTarget is refused before anything starts", async () => {
  const { c, starts } = ctl();
  for (const buildTarget of [undefined, "", "relatif\\folder", 42, root + "\u0000x"])
    await assert.rejects(start(c, { mode: "build", buildTarget }), /buildTarget/);
  assert.equal(starts.length, 0);
});

test("build passes the target as its own field to the host, never inside the prompt", async () => {
  const { c, starts } = ctl();
  await start(c, { mode: "build", buildTarget: root });
  assert.equal(starts.length, 1);
  assert.equal(starts[0].payload.mode, "build");
  assert.equal(starts[0].payload.bridgeBuildTarget.toLowerCase(), root.toLowerCase());
  assert.doesNotMatch(starts[0].payload.prompt, /qa/);
});

test("a buildTarget is only accepted on the app workspace, never on a second workspace", async () => {
  const other = process.platform === "win32" ? "C:\\qa\\lain" : "/qa/lain";
  const { c, starts } = ctl({ maxActive: () => 2, canGrantWrites: () => ({ ok: true }) });
  await assert.rejects(c.execute("start", { requestId: randomUUID(), expectedWorkspace: other, prompt: "bangun", mode: "build", buildTarget: other }), /build/);
  assert.equal(starts.length, 0);
});

test("the same requestId with a different buildTarget is a different request", async () => {
  const { c } = ctl();
  const requestId = randomUUID();
  await c.execute("start", { requestId, expectedWorkspace: root, prompt: "bangun halaman", mode: "build", buildTarget: root });
  await assert.rejects(c.execute("start", { requestId, expectedWorkspace: root, prompt: "bangun halaman", mode: "build", buildTarget: root + "-lain" }), /requestId/);
});

test("ask and work refuse a buildTarget instead of ignoring it", async () => {
  const { c } = ctl();
  for (const mode of ["ask", "work"]) await assert.rejects(start(c, { mode, buildTarget: root }), /buildTarget/);
});

test("the bridge has no path to settings, devRoots or the workspace switcher for builds", async () => {
  const files = ["src/desktop/bridge-controller.mjs", "src/desktop/local-bridge.mjs", "src/bridge/mcp.mjs", "src/desktop/bridge-build.mjs"];
  for (const f of files) {
    const src = await readFile(new URL("../../" + f, import.meta.url), "utf8");
    assert.doesNotMatch(src, /saveSettings|settings\.devRoots\s*=|devRoots\s*:\s*\[[^\]]/, f);
  }
  const ctlSrc = await readFile(new URL("../../src/desktop/bridge-controller.mjs", import.meta.url), "utf8");
  const methods = [...ctlSrc.matchAll(/case '([a-zA-Z]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(methods, ["approvals", "decide", "operation", "result", "start", "status", "stop", "switchWorkspace"].sort());
});

test("main runs the guard before the run, requires target = workspace, and never confirms for the owner", async () => {
  const main = await readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  const at = main.indexOf("const startBridgeBuild");
  assert.ok(at >= 0, "startBridgeBuild exists");
  const f = main.slice(at, main.indexOf("\n      };\n", at));
  assert.match(f, /await checkBridgeBuildTarget\(payload\.bridgeBuildTarget, \{[\s\S]*devRoots: store\.settings\.devRoots \|\| \[\]/);
  assert.match(f, /forbidden: \[app\.getAppPath\(\), store\.root\]/);
  assert.match(f, /repoCommonDir: appRepoCommonDir\(\)/);
  assert.match(f, /buildTarget harus sama dengan workspace aktif/);
  assert.match(f, /kind: "new"/);
  assert.match(f, /confirmedByOwner: false/);
  assert.doesNotMatch(f, /confirmedByOwner: true/);
  assert.match(f, /activeTask = task/);
});
