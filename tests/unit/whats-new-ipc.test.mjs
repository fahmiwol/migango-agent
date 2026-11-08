// 06xg part 2: read-only "Apa yang baru" IPC. The renderer can never choose which file is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWhatsNewIpc, muatApaYangBaru, BATAS_BYTE } from "../../src/desktop/whats-new-ipc.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const APP = path.resolve(repo, "tmp-fake-app-root");
const FIXED = path.join(APP, "docs", "RIWAYAT-VERSI.md");
const TEXT = [
  "# Riwayat versi",
  "",
  "## 0.2.0-alpha.21 — 29 Oktober 2026",
  "",
  "### Yang baru",
  "- Halaman Apa yang baru.",
  "",
  "## 0.2.0-alpha.20 — 27 Oktober 2026",
  "",
  "### Yang baru",
  "- Meteran biaya.",
  "",
].join("\n");

function fixture({ version = "0.2.0-alpha.20", text = TEXT, trusted = true } = {}) {
  const reads = [];
  const ipc = createWhatsNewIpc({
    appRoot: APP,
    version,
    isTrusted: (e) => trusted && e === "main",
    readFile: async (p, ...rest) => {
      reads.push([p, ...rest]);
      return Buffer.from(text, "utf8");
    },
  });
  return { ipc, reads };
}

test("whatsNew reads only the fixed in-app file and highlights the running version", async () => {
  const { ipc, reads } = fixture();
  assert.deepEqual(ipc.methods, ["whatsNew"]);
  const data = await ipc.handle("main", "whatsNew");
  assert.deepEqual(reads, [[FIXED]]);
  assert.equal(data.versiApp, "0.2.0-alpha.20");
  assert.equal(data.berkas, "docs/RIWAYAT-VERSI.md");
  assert.equal(data.saatIniDitemukan, true);
  assert.deepEqual(data.bagian.map((b) => [b.versi, b.saatIni]), [
    ["0.2.0-alpha.21", false],
    ["0.2.0-alpha.20", true],
  ]);
  assert.equal(data.bagian[1].tanggal, "27 Oktober 2026");
  assert.match(data.bagian[1].isi, /Meteran biaya/);
  assert.doesNotMatch(data.bagian[1].isi, /Halaman Apa yang baru/);
  assert.equal(JSON.stringify(data).includes(APP), false, "absolute app path must not reach the renderer");
});

test("whatsNew rejects any payload from the renderer, before reading", async () => {
  for (const payload of ["C:/Windows/win.ini", "../../package.json", { path: "x" }, ["docs/x.md"], 0, false, ""]) {
    const { ipc, reads } = fixture();
    await assert.rejects(ipc.handle("main", "whatsNew", payload), /no payload|read-only/i, JSON.stringify(payload));
    assert.equal(reads.length, 0);
  }
});

test("untrusted sender and unknown methods are refused before reading", async () => {
  const a = fixture({ trusted: false });
  await assert.rejects(a.ipc.handle("main", "whatsNew"), /Untrusted IPC sender/);
  assert.equal(a.reads.length, 0);
  const b = fixture();
  await assert.rejects(b.ipc.handle("main", "readFile"), /unknown|read-only/i);
  await assert.rejects(b.ipc.handle("main", "whatsNewWrite"), /unknown|read-only/i);
  assert.equal(b.reads.length, 0);
});

test("version missing from the history is reported, never faked", async () => {
  const { ipc } = fixture({ version: "0.2.0-alpha.99" });
  const data = await ipc.handle("main", "whatsNew");
  assert.equal(data.saatIniDitemukan, false);
  assert.equal(data.bagian.some((b) => b.saatIni), false);
});

test("oversized or missing file fails loudly with a code and without the absolute path", async () => {
  const big = createWhatsNewIpc({
    appRoot: APP,
    version: "0.2.0-alpha.20",
    isTrusted: () => true,
    readFile: async () => Buffer.alloc(BATAS_BYTE + 1, 0x61),
  });
  await assert.rejects(big.handle("main", "whatsNew"), (e) => e.code === "RIWAYAT_TERLALU_BESAR" && !e.message.includes(APP));
  const missing = createWhatsNewIpc({
    appRoot: APP,
    version: "0.2.0-alpha.20",
    isTrusted: () => true,
    readFile: async (p) => {
      throw Object.assign(new Error("ENOENT: no such file, open '" + p + "'"), { code: "ENOENT" });
    },
  });
  await assert.rejects(missing.handle("main", "whatsNew"), (e) => e.code === "ENOENT" && /RIWAYAT-VERSI\.md/.test(e.message) && !e.message.includes(APP));
});

test("appRoot must be absolute; relative roots would follow the process cwd (workspace)", () => {
  assert.throws(() => createWhatsNewIpc({ appRoot: "docs", version: "x", isTrusted: () => true }), /absolute/);
  assert.throws(() => createWhatsNewIpc({ appRoot: undefined, version: "x", isTrusted: () => true }), /absolute/);
});

test("the real shipped history contains the current package.json version", async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  const data = await muatApaYangBaru({ appRoot: repo, version: pkg.version });
  assert.equal(data.saatIniDitemukan, true, "docs/RIWAYAT-VERSI.md lacks " + pkg.version);
});

test("preload exposes whatsNew() that never forwards renderer arguments", async () => {
  const require = createRequire(import.meta.url);
  const preloadPath = require.resolve("../../src/desktop/preload.cjs");
  const invoked = [];
  let exposed;
  const fake = {
    contextBridge: { exposeInMainWorld: (name, api) => (exposed = api) },
    ipcRenderer: { invoke: async (...a) => (invoked.push(a), { ok: true, data: {} }), on() {}, removeListener() {} },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    return request === "electron" ? fake : original.call(this, request, ...rest);
  };
  try {
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = original;
  }
  assert.equal(typeof exposed.whatsNew, "function");
  await exposed.whatsNew("C:/Windows/win.ini");
  assert.deepEqual(invoked.at(-1), ["workbench", "whatsNew", undefined]);
});

test("static wiring guard: main.mjs serves whatsNew from the app path, not the workspace", async () => {
  // Static only: main.mjs needs Electron to import. Behaviour is covered by the handler tests above.
  const source = await fs.readFile(path.join(repo, "src/desktop/main.mjs"), "utf8");
  assert.match(source, /createWhatsNewIpc\(\{\s*appRoot: app\.getAppPath\(\),/);
  assert.match(source, /case "whatsNew":\s*data = await whatsNewIpc\.handle\(event, method, payload\);/);
});
