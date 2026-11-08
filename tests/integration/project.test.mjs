// K06 (ARS-005, ARS-004 §12): "Bangun aplikasi" never writes into the active folder by default. Sending in
// build mode from a normal folder opens the project dialog and starts no run; creating a project switches
// the workspace to the new folder under the owner-chosen root. Needs the Electron binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

test(
  "real Electron: build mode asks for a project folder and creates one under the chosen root",
  { timeout: 90000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-project-data-"));
    const work = await fs.mkdtemp(path.join(os.tmpdir(), "migan-project-work-"));
    const projects = await fs.mkdtemp(path.join(os.tmpdir(), "migan-project-root-"));
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
    if (await page.locator("#settingsDialog").evaluate((e) => e.open))
      await page.locator("#closeSettings").click();

    // Build mode from a normal folder: the project dialog opens and no run starts.
    await page.locator('[data-mode="build"]').click();
    await page.locator("#prompt").fill("buatin aplikasi calculator");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.getElementById("projectDialog").open);
    assert.equal((await page.evaluate(() => window.workbench.history())).length, 0, "no run before a folder is chosen");

    // Invalid name is refused in place.
    await page.locator("#projectName").fill("../luar");
    await pick(projects);
    await page.locator("#createProjectBtn").click();
    await page.waitForFunction(() => document.getElementById("projectError").textContent.length > 0);
    assert.equal((await fs.readdir(projects)).length, 0);

    // A valid name creates the folder under the chosen root and switches the workspace to it.
    await page.locator("#projectName").fill("Kalkulator");
    await page.locator("#createProjectBtn").click();
    await page.waitForFunction(() => !document.getElementById("projectDialog").open);
    assert.deepEqual(await fs.readdir(projects), ["Kalkulator"]);
    const shown = await page.locator("#workspacePath").textContent();
    assert.match(shown, /Kalkulator/);
    assert.deepEqual(await fs.readdir(work), [], "nothing was written into the previous folder");

    // The sidebar button creates a project without going through build mode.
    assert.equal(await page.locator("#newProject").isVisible(), true);

    await desktop.close();
    desktop = undefined;
  },
);
