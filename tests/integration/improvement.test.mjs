import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { _electron } from "playwright-core";
import { ImprovementEngine } from "../../src/improvement/engine.mjs";
import { Store } from "../../src/core/storage.mjs";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "Electron candidate UI denies/approves exact activation, runs repaired isolated module and persists pointer after restart",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(
      path.join(os.tmpdir(), "migango-candidate-ui-"),
    );
    const workspace = path.join(data, "workspace");
    const store = new Store(data, { isEncryptionAvailable: () => false });
    await store.init();
    await store.setWorkspace(workspace);
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "tests"));
    await fs.writeFile(
      path.join(workspace, "src/add.mjs"),
      "export const add=(a,b)=>a-b;",
    );
    await fs.writeFile(
      path.join(workspace, "tests/oracle.mjs"),
      "import {test} from 'node:test';import assert from 'node:assert/strict';import {add} from '../src/add.mjs';test('addition',()=>assert.equal(add(2,3),5));",
    );
    const engine = new ImprovementEngine({
      root: path.join(data, "improvement"),
      maker: async () => ({
        patches: [{ path: "src/add.mjs", before: "a-b", after: "a+b" }],
      }),
    });
    await engine.init();
    const candidate = await engine.create({
      workspace,
      goal: "Fix isolated addition fixture",
      files: ["src/add.mjs", "tests/oracle.mjs"],
      editable: ["src/add.mjs"],
      tests: ["tests/oracle.mjs"],
    });
    assert.equal((await engine.repair(candidate.id)).status, "validated");
    engine.close();
    const env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    let desktop;
    t.after(async () => {
      await desktop?.close();
      await fs.rm(data, { recursive: true, force: true });
    });
    const launch = async () => {
      desktop = await _electron.launch({
        executablePath: path.join(
          root,
          "node_modules/electron/dist/electron.exe",
        ),
        args: [root],
        env,
        timeout: 20000,
      });
      const page = await desktop.firstWindow();
      await page.waitForFunction(
        () => document.getElementById("workspacePath")?.textContent.length > 0,
      );
      if (await page.locator("#settingsDialog").evaluate((e) => e.open))
        await page.locator("#closeSettings").click();
      await page.locator('[data-nav="recovery"]').click();
      return page;
    };
    let page = await launch();
    await page.locator("#improvementList summary").click();
    await page
      .getByRole("button", { name: "Aktifkan versi teruji", exact: true })
      .click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.match(
      await page.locator("#approvalArgs").textContent(),
      new RegExp(candidate.id),
    );
    await page.locator("#deny").click();
    await page.waitForFunction(() =>
      document.getElementById("toast").textContent.includes("rejected"),
    );
    assert.equal(
      (await page.evaluate(() => window.workbench.improvementList()))[0].status,
      "validated",
    );
    await page.locator("#improvementList summary").click();
    await page
      .getByRole("button", { name: "Aktifkan versi teruji", exact: true })
      .click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#improvementList summary")
        .textContent.startsWith("active"),
    );
    await page.locator("#improvementList summary").click();
    await page
      .locator("#improvementList textarea")
      .fill(
        JSON.stringify({
          module: "src/add.mjs",
          exportName: "add",
          args: [2, 3],
        }),
      );
    await page
      .getByRole("button", { name: "Jalankan versi aktif", exact: true })
      .click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.match(
      await page.locator("#approvalArgs").textContent(),
      /"exportName": "add"/,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() =>
      document
        .getElementById("improvementStatus")
        .textContent.includes('"result":5'),
    );
    assert.equal(
      await fs.readFile(path.join(workspace, "src/add.mjs"), "utf8"),
      "export const add=(a,b)=>a-b;",
    );
    await desktop.close();
    desktop = undefined;
    page = await launch();
    assert.equal(
      (await page.evaluate(() => window.workbench.improvementList()))[0].status,
      "active",
    );
    await page.screenshot({
      path: path.join(root, "evidence/candidate-ui.png"),
    });
  },
);
