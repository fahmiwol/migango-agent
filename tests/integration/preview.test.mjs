// ARS-004 §13: real Electron proof for the Canvas-like preview, lazy file listing and new projects.
// Negative checks run INSIDE the guest page. Needs the Electron binary (`npm run test:desktop`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

test(
  "real Electron: isolated preview guest, 'ada N lagi' listing and createProject under the chosen root",
  { timeout: 90000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-preview-data-"));
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "migan-preview-work-"));
    const projects = await fs.mkdtemp(path.join(os.tmpdir(), "migan-preview-projects-"));
    await fs.mkdir(path.join(work, "app"));
    await fs.mkdir(path.join(work, "other"));
    await fs.mkdir(path.join(work, "many"));
    await fs.writeFile(path.join(work, ".env"), "KEY=fixture-only");
    await fs.writeFile(path.join(work, "other", "private.txt"), "not in scope");
    for (let i = 0; i < 650; i++) await fs.writeFile(path.join(work, "many", `f${i}.txt`), "x");
    await fs.writeFile(
      path.join(work, "app", "index.html"),
      `<!doctype html><title>preview</title><h1>Kalkulator</h1><script>
      const status = (u) => fetch(u).then((r) => r.status, () => "blocked");
      window.__probe = (async () => ({
        require: typeof window.require,
        process: typeof process,
        external: await status("https://example.com/"),
        localhost: await status("http://127.0.0.1:11434/api/tags"),
        file: await status("file:///C:/Windows/win.ini"),
        traversal: await status(location.origin + "/%2e%2e/other/private.txt"),
        secret: await status(location.origin + "/../.env"),
        popup: window.open("https://example.com/") === null ? "denied" : "opened",
      }))();
      </script>`,
    );
    const env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    let desktop = await _electron.launch({
      executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
      args: [root],
      env,
      timeout: 30000,
    });
    t.after(async () => {
      await desktop?.close();
      for (const d of [data, work, projects])
        await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const pick = (folder) =>
      desktop.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      }, folder);
    await pick(work);
    await page.evaluate(() => window.workbench.pickWorkspace());

    // Lazy listing never truncates silently.
    const listing = await page.evaluate(() => window.workbench.listDirectory({ dir: "many" }));
    assert.equal(listing.total, 650);
    assert.equal(listing.shown, 200);
    assert.equal(listing.moreLabel, "ada 450 lagi");
    const top = await page.evaluate(() => window.workbench.listDirectory({ dir: "" }));
    assert.equal(top.entries.some((e) => e.name === ".env"), false);

    // Preview guest: isolated, read-only, no network, no popups, no navigation away.
    const { token, url } = await page.evaluate(() => window.workbench.previewArtifact("app/index.html"));
    await page.evaluate(
      (tk) => window.workbench.openPreview({ token: tk, rect: { x: 0, y: 0, width: 400, height: 300 }, visible: true }),
      token,
    );
    let guest;
    for (let i = 0; i < 50 && !guest; i++) {
      guest = desktop.windows().find((w) => w.url().startsWith("mgpreview://"));
      if (!guest) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(guest, "preview guest not found");
    assert.equal(guest.url(), url);
    const probe = await guest.evaluate(() => window.__probe);
    assert.deepEqual(probe, {
      require: "undefined",
      process: "undefined",
      external: "blocked",
      localhost: "blocked",
      file: "blocked",
      traversal: probe.traversal === 404 ? 404 : 403,
      secret: probe.secret === 404 ? 404 : 403,
      popup: "denied",
    });
    assert.ok([403, 404].includes(probe.traversal) && [403, 404].includes(probe.secret));
    await guest.evaluate(() => (location.href = "https://example.com/")).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(guest.url().startsWith("mgpreview://" + token), guest.url());
    assert.equal(await page.evaluate(() => typeof window.workbench), "object");

    // New project: only under the owner-chosen root; becomes the workspace.
    await pick(projects);
    const created = await page.evaluate(() => window.workbench.createProject({ name: "Kalkulator" }));
    assert.equal(path.basename(created.root), "Kalkulator");
    assert.equal(path.dirname(created.root).toLowerCase(), (await fs.realpath(projects)).toLowerCase());
    assert.equal(created.activeRoot.toLowerCase(), (await fs.realpath(work)).toLowerCase());
    const refused = await page.evaluate(() =>
      window.workbench.createProject({ name: "../luar" }).then(() => false, () => true),
    );
    assert.equal(refused, true);

    await desktop.close();
    desktop = undefined;
  },
);
