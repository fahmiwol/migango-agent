import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

// Markas P2 (25 Oct 2026): miganGO replaces Claude Desktop for daily work, so a corrupt local
// database must never stop the app from starting. Local memory then reports "unavailable".
test(
  "real desktop starts with corrupt local databases, finishes a task and reports local memory unavailable",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-memory-startup-")),
      seen = [],
      errors = [];
    const corrupt = Buffer.alloc(4096, "x");
    await fs.writeFile(path.join(data, "context.db"), corrupt);
    await fs.writeFile(path.join(data, "references.db"), corrupt);
    const server = http.createServer(async (req, res) => {
      let raw = "";
      for await (const b of req) raw += b;
      seen.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "startup-fixture",
          message: { role: "assistant", content: "STARTUP_FALLBACK_RESPONSE" },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 12,
          eval_count: 4,
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const base = "http://127.0.0.1:" + server.address().port,
      env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({
      executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
      args: [root],
      env,
      timeout: 30000,
    });
    t.after(async () => {
      // An app that failed to start must fail this test, not hang the suite (HOMESRV red run lesson).
      await Promise.race([
        app.close().catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      try {
        app.process().kill();
      } catch {}
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const page = await app.firstWindow({ timeout: 20000 });
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => document.getElementById("settingsDialog").open);
    await page.locator("#closeSettings").click();
    await page.evaluate(async (base) => {
      const s = await window.workbench.settings();
      await window.workbench.saveSettings({
        ...s,
        active: "ollama",
        autoRouting: false,
        internalMemory: true,
        memoryEnabled: false,
        mcp: [],
        modelRegistry: [],
        profiles: { ...s.profiles, ollama: { model: "startup-fixture", baseURL: base } },
      });
    }, base);
    await page.reload();
    await page.waitForFunction(
      () => document.getElementById("activeProvider").value === "ollama",
    );
    const note = await page.evaluate(() =>
      window.workbench.memoryNote("Owner note while the store is broken").then(
        () => "accepted",
        (e) => String(e && e.message),
      ),
    );
    assert.match(note, /Memori lokal tidak tersedia/, "a readable refusal, not a crash");
    await page.locator("#prompt").fill("Kerjakan tanpa memori lokal.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("stop").hidden &&
        document.getElementById("runStatus").textContent.includes("responded"),
    );
    assert.equal(seen.length, 1, "the task reached the model exactly once");
    assert.ok(
      !seen[0].messages.find((m) => m.role === "user").content.includes(
        "Internal workspace memory",
      ),
    );
    assert.match(await page.locator("#memoryLocalStatus").innerText(), /Lokal: tidak tersedia/);
    // Reads used by every workspace refresh resolve empty instead of rejecting.
    const reads = await page.evaluate(async () => ({
      memory: await window.workbench.memory(""),
      research: await window.workbench.researchList(""),
    }));
    assert.equal(reads.memory.mode, "unavailable");
    assert.deepEqual(reads.memory.records, []);
    assert.equal(reads.memory.status.reason, "local store unavailable at startup");
    assert.deepEqual(reads.research, []);
    // Switching folders refreshes memory and research; no error may surface.
    const pick = (folder) =>
      app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      }, folder);
    const second = path.join(data, "second-workspace"),
      projects = path.join(data, "projects");
    await fs.mkdir(second);
    await fs.mkdir(projects);
    await pick(second);
    await page.locator("#pickFolder").click();
    await page.waitForFunction(
      (f) => document.getElementById("workspacePath").textContent === f,
      second,
    );
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    assert.doesNotMatch(
      (await page.locator("#toast").textContent()) || "",
      /tidak tersedia|unavailable/i,
    );
    // Build mode: the new-project dialog must close and the task must start.
    await page.locator('[data-mode="build"]').click();
    await page.locator("#prompt").fill("buatin aplikasi calculator");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.getElementById("projectDialog").open);
    await pick(projects);
    await page.locator("#projectName").fill("Kalkulator");
    await page.locator("#createProjectBtn").click();
    await page.waitForFunction(
      () => !document.getElementById("projectDialog").open,
      null,
      { timeout: 10000 },
    );
    assert.deepEqual(await fs.readdir(projects), ["Kalkulator"]);
    await page.waitForFunction(() => document.getElementById("stop").hidden);
    assert.equal(seen.length, 2, "the build task reached the model after the project dialog");
    for (const name of ["context.db", "references.db"])
      assert.deepEqual(
        await fs.readFile(path.join(data, name)),
        corrupt,
        `${name} is kept untouched for recovery`,
      );
    assert.deepEqual(errors, []);
  },
);
