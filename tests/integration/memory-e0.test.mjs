import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "real desktop keeps local memory with Brain ON and explains actual sources without starting MCP",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-memory-e0-")),
      seen = [],
      errors = [];
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const b of req) raw += b;
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "memory-fixture",
          message: { role: "assistant", content: "MEMORY_E0_RESPONSE" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 20,
          eval_count: 5,
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + server.address().port,
      env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 30000,
    });
    t.after(async () => {
      await app.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(data, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.getElementById("settingsDialog").open,
    );
    await page.locator("#closeSettings").click();
    assert.equal(
      await page.locator("#memorySourceSummary").count(),
      1,
      "current-task memory status is visible in the existing inspector",
    );
    await page.evaluate(async (base) => {
      const s = await window.workbench.settings();
      await window.workbench.saveSettings({
        ...s,
        active: "ollama",
        autoRouting: false,
        internalMemory: true,
        memoryEnabled: true,
        mcp: [],
        modelRegistry: [],
        profiles: {
          ...s.profiles,
          ollama: { model: "memory-fixture", baseURL: base },
        },
      });
    }, base);
    await page.reload();
    await page.waitForFunction(
      () => document.getElementById("activeProvider").value === "ollama",
    );
    const marker = "PROJECT_MEMORY_E0_VISIBLE";
    await page.evaluate(
      (marker) => window.workbench.memoryNote("Owner fixture note " + marker),
      marker,
    );
    await page.locator("#prompt").fill("Recall PROJECT_MEMORY_E0_VISIBLE.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("stop").hidden &&
        document.getElementById("runStatus").textContent.includes("responded"),
    );
    assert.equal(seen.length, 1);
    assert.ok(
      seen[0].messages
        .find((m) => m.role === "user")
        .content.includes("Owner fixture note " + marker),
    );
    assert.match(
      await page.locator("#memoryLocalStatus").innerText(),
      /Lokal: [1-9]/,
    );
    assert.match(
      await page.locator("#memoryExternalStatus").innerText(),
      /Tanya/,
    );
    await page.locator("#langBtn").click();
    assert.match(
      await page.locator("#memoryLocalStatus").innerText(),
      /Local: [1-9]/,
    );
    assert.match(
      await page.locator("#memoryExternalStatus").innerText(),
      /Ask/,
    );
    await page.locator("#langBtn").click();
    const shot = process.env.MIGANGO_MEMORY_SCREENSHOT;
    if (shot) await page.screenshot({ path: shot });
    await page.locator('[data-mode="work"]').click();
    await page
      .locator("#prompt")
      .fill("Recall PROJECT_MEMORY_E0_VISIBLE again.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("stop").hidden &&
        document
          .getElementById("runStatus")
          .textContent.includes("needs-validation"),
    );
    assert.equal(seen.length, 2);
    assert.ok(
      seen[1].messages
        .find((m) => m.role === "user")
        .content.includes("Owner fixture note " + marker),
    );
    assert.match(
      await page.locator("#memoryExternalStatus").innerText(),
      /penilai|dikonfigurasi/,
    );
    await page.locator("#newTask").click();
    assert.match(
      await page.locator("#memoryLocalStatus").innerText(),
      /belum digunakan/i,
    );
    const reset = await page.locator("#memorySourceSummary").innerText();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("workbench-event", {
        type: "memory",
        runId: "different-old-run",
        source: "internal",
        records: [{ id: "foreign", source: "not-this-project" }],
      }),
    );
    assert.equal(
      await page.locator("#memorySourceSummary").innerText(),
      reset,
      "late memory events cannot contaminate a new task",
    );
    await page.locator("#history button").first().click();
    await page.waitForFunction(
      () =>
        document
          .getElementById("memoryExternalStatus")
          .textContent.includes("penilai") ||
        document
          .getElementById("memoryExternalStatus")
          .textContent.includes("dikonfigurasi"),
    );
    assert.deepEqual(errors, []);
  },
);
