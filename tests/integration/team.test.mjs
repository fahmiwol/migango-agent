// Real trusted IPC + real owner forms; fixture profiles, no external API or credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "real Electron: owner configures team, chooses delegation, and cannot remove Migan",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-team-ui-")),
      env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 30000,
    });
    t.after(async () => {
      await desktop.close();
      await fs.rm(data, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const page = await desktop.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.getElementById("settingsDialog").open,
    );
    await page.locator("#closeSettings").click();
    assert.equal(
      await page.locator("#taskTeam").count(),
      1,
      "one visible team selector",
    );
    const settings = await page.evaluate(() => window.workbench.settings());
    const registry = ["a", "b", "c"].map((id) => ({
      id: "fixture-team-" + id,
      provider: "ollama",
      model: "fixture-only-" + id,
      baseURL: "http://127.0.0.1:1",
      capabilities: ["text", "code", "tools"],
      enabled: true,
    }));
    await page.evaluate(
      async ({ s, registry }) =>
        window.workbench.saveSettings({
          ...s,
          active: "ollama",
          profiles: {
            ...s.profiles,
            ollama: { model: "fixture-only", baseURL: "http://127.0.0.1:1" },
          },
          modelRegistry: registry,
        }),
      { s: settings, registry },
    );
    // Reload through normal startup to read persisted owner settings into the UI.
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#taskModel option[value="fixture-team-a"]'),
    );
    await page.locator("#agentsBtn").click();
    await page.waitForFunction(
      () => document.getElementById("agentsDialog").open,
    );
    for (const [i, name] of ["Koda", "Reviewer", "Rupa"].entries()) {
      await page.locator("#teamMemberName").fill(name);
      await page.locator("#teamMemberModel").selectOption(registry[i].id);
      await page.locator("#teamMemberAccess").selectOption("read");
      await page.locator("#saveTeamMember").click();
      await page.waitForFunction(
        (n) =>
          Array.from(
            document.querySelectorAll("#agentsList .agent-card strong"),
          ).some((e) => e.textContent === n),
        name,
      );
    }
    const cards = await page.evaluate(() => window.workbench.agentCatalog());
    assert.equal(cards.cards.length, 4);
    assert.equal(
      await page
        .locator("#agentsList .agent-card")
        .first()
        .locator("button")
        .count(),
      0,
    );
    assert.equal(
      (await fs.readFile(path.join(data, "agents.json"), "utf8")).includes(
        "fixture-team",
      ),
      true,
    );
    const id = cards.cards.find((c) => c.nama === "Koda").id;
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.workbench.teamMemberRemove("migan");
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    await page.locator("#closeAgents").click();
    await page.locator("#taskTeamSettings > summary").click();
    await page.locator("#taskTeam").selectOption("agent:" + id);
    assert.equal(await page.locator("#taskTeam").inputValue(), "agent:" + id);
    const council =
      "council:" +
      ["Koda", "Reviewer"]
        .map((name) => cards.cards.find((c) => c.nama === name).id)
        .join(",");
    await page.locator("#taskTeam").selectOption(council);
    await page.locator("#prompt").fill("Draft remains during navigation");
    await page.locator('[data-nav="files"]').click();
    assert.equal(
      await page.locator("#prompt").inputValue(),
      "Draft remains during navigation",
    );
    assert.equal(await page.locator("#taskTeam").inputValue(), council);
    // Owner disables the second model through the real settings form. A council must not silently substitute Rupa.
    await page.locator("#settingsBtn").click();
    await page.locator("#advancedSettings > summary").click();
    await page
      .locator("#modelRegistry")
      .fill(
        JSON.stringify(registry.map((p, i) => ({ ...p, enabled: i !== 1 }))),
      );
    await page.locator('#settingsForm button[data-i18n="save"]').click();
    await page.waitForFunction(
      () => !document.getElementById("settingsDialog").open,
    );
    assert.equal(await page.locator("#taskTeam").inputValue(), "");
    assert.equal(
      await page.locator("#prompt").inputValue(),
      "Draft remains during navigation",
    );
    assert.ok(
      !(await page.locator("#taskTeam").textContent()).includes("Reviewer"),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForFunction(() => innerWidth === 1280);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const shot = process.env.MIGANGO_TEAM_SCREENSHOT;
    if (shot) await page.screenshot({ path: shot, fullPage: false });
    await page.locator("#agentsBtn").click();
    assert.equal(
      await page
        .locator("#agentsDialog")
        .evaluate((e) => e.scrollWidth <= e.clientWidth),
      true,
    );
    assert.equal(await page.locator("#saveTeamMember").isVisible(), true);
    await page
      .locator("#agentsList .agent-card")
      .filter({ hasText: "Koda" })
      .locator(".agent-remove")
      .click();
    await page.waitForFunction(
      () => document.querySelectorAll("#agentsList .agent-card").length === 3,
    );
    await page.locator("#closeAgents").click();
    assert.equal(await page.locator("#taskTeam").inputValue(), "");
    assert.deepEqual(errors, []);
  },
);
