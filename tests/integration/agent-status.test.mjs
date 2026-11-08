// F1 PRD-003 / ARS-004 §2, D-005: real Electron proof that the read-only agen.status channel is wired.
// Needs the Electron binary (`npm run test:desktop`); not run in phase 1.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

test(
  "real Electron: agentStatus handler is installed, read-only, and the JSONL channel shows Migan",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-status-"));
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
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Handler installed: a renderer request reaches main and returns Migan idle.
    const status = await page.evaluate(() => window.workbench.agentStatus());
    const migan = status.find((s) => s.agentId === "migan");
    assert.ok(migan, JSON.stringify(status));
    assert.equal(migan.state, "siaga");

    // Agen panel data: Migan first and never removable, served read-only.
    const view = await page.evaluate(() => window.workbench.agentCatalog());
    assert.equal(view.cards[0].id, "migan");
    assert.equal(view.cards[0].dapatDihapus, false);
    assert.equal(view.warning, null);

    // First launch has no stored key, so startup opens Settings modally; close it through the real UI.
    await page.waitForFunction(() => document.getElementById("settingsDialog")?.open);
    await page.locator("#closeSettings").click();
    await page.waitForFunction(() => !document.getElementById("settingsDialog").open);
    assert.equal(await page.locator("#settingsDialog").evaluate((e) => e.open), false);

    // C1 Agen panel (D-006): read-only cards, Migan first with its live status, no delete for Migan.
    await page.locator("#agentsBtn").click();
    await page.waitForFunction(() => document.getElementById("agentsDialog").open);
    const firstCard = page.locator("#agentsList .agent-card").first();
    assert.match(await firstCard.textContent(), /Migan/);
    assert.match(await firstCard.locator(".agent-status").textContent(), /Siap membantu|Ready to help/);
    assert.equal(await firstCard.locator("button").count(), 0, "Migan card offers no delete");
    assert.equal(await page.locator("#agentsWarning").isHidden(), true);
    await page.locator("#closeAgents").click();
    await page.waitForFunction(() => !document.getElementById("agentsDialog").open);

    // Bridge surface: read and subscribe only, no write method for status.
    const keys = await page.evaluate(() => Object.keys(window.workbench));
    assert.ok(keys.includes("agentStatus") && keys.includes("onAgentStatus"));
    assert.deepEqual(
      keys.filter((k) => /status/i.test(k) && !["agentStatus", "onAgentStatus"].includes(k)),
      [],
    );
    assert.equal(
      await page.evaluate(() => typeof window.workbench.onAgentStatus(() => {})),
      "function",
    );

    // External reader path: JSONL in userData carries the announced Migan line.
    const file = path.join(data, "agen-status", "agen-status.jsonl");
    let lines = [];
    for (let i = 0; i < 50 && !lines.length; i++) {
      try {
        lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
      } catch {}
      if (!lines.length) await new Promise((r) => setTimeout(r, 100));
    }
    const first = JSON.parse(lines[0]);
    assert.equal(first.type, "agen.status");
    assert.equal(first.agentId, "migan");
    assert.equal(first.state, "siaga");

    await desktop.close();
    desktop = undefined;
  },
);
