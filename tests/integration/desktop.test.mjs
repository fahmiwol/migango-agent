import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "real Electron: encrypted settings, bounded agent write/deny/Stop, isolated browser and recovery",
  { timeout: 90000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-desktop-"));
    let desktop;
    let turn = 0;
    let scenario = "write";
    let trackingRequests = 0;
    const server = http.createServer(async (req, res) => {
      if (req.url === "/tracking.png") trackingRequests++;
      if (req.url !== "/api/chat") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          '<!doctype html><title>Browser fixture</title><h1>Browser test</h1><form><input name="amount" value="1" aria-label="Name"><button type="button" id="go" onclick="document.querySelector(\'h1\').textContent=\'Clicked\'">Go</button></form>',
        );
        return;
      }
      let body = "";
      for await (const chunk of req) body += chunk;
      const parsed = JSON.parse(body);
      turn++;
      const allToolMessages = parsed.messages.filter((m) => m.role === "tool");
      const toolMessages = allToolMessages.filter(
        (m) => m.tool_name !== "discover_tools",
      );
      const toolDone = toolMessages.length > 0;
      let output = toolDone
        ? {
            role: "assistant",
            content:
              "## Fixture complete\n\n**artifact written**\n\n<script>window.__markdownXSS=true</script>\n\n[unsafe](javascript:alert(1))\n\n![tracking](http://127.0.0.1:" +
              port +
              "/tracking.png)\n\n```js\nconst n = 1;\n```",
          }
        : {
            role: "assistant",
            content: "I will create a reviewable Markdown artifact.",
            tool_calls: [
              {
                function: {
                  name: "write_file",
                  arguments: {
                    path: scenario === "write" ? "hello.md" : "denied.md",
                    content: "# Hello\nDesktop proof.",
                    expectedHash: null,
                  },
                },
              },
            ],
          };
      if (scenario === "browser") {
        if (!allToolMessages.length) {
          assert.ok(
            !parsed.tools.some((t) => t.function.name === "browser_click"),
          );
          output = {
            role: "assistant",
            content: "Load browser tools.",
            tool_calls: [
              {
                function: {
                  name: "discover_tools",
                  arguments: { group: "browser" },
                },
              },
            ],
          };
        } else if (!toolMessages.length)
          output = {
            role: "assistant",
            content: "Observe the page.",
            tool_calls: [
              { function: { name: "browser_snapshot", arguments: {} } },
            ],
          };
        else if (toolMessages.length === 1) {
          const snap = JSON.parse(toolMessages[0].content);
          output = {
            role: "assistant",
            content: "Click the observed Go button.",
            tool_calls: [
              {
                function: {
                  name: "browser_click",
                  arguments: { snapshotId: snap.snapshotId, target: 1 },
                },
              },
            ],
          };
        } else
          output = { role: "assistant", content: "Browser action complete." };
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fixture-local",
          message: output,
          prompt_eval_count: 25,
          eval_count: 8,
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(async () => {
      await desktop?.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(data, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const port = server.address().port;
    const env = { ...process.env, WORKBENCH_TEST_DATA: data };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({
      executablePath: path.join(
        root,
        "node_modules/electron/dist/electron.exe",
      ),
      args: [root],
      env,
      timeout: 30000,
    });
    const page = await desktop.firstWindow();
    const beforeBrowser = await desktop.evaluate(({ app }) =>
      app
        .getAppMetrics()
        .map((p) => ({ type: p.type, workingSetKiB: p.memory.workingSetSize })),
    );
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => {
      if (m.type() === "error") console.error(m.text());
    });
    await page.waitForLoadState("domcontentloaded");
    try {
      await page.waitForFunction(
        () => document.getElementById("workspacePath")?.textContent.length > 0,
        {},
        { timeout: 5000 },
      );
    } catch (e) {
      console.error(
        "UI diagnosis",
        await page.evaluate(() => ({
          bridge: typeof window.workbench,
          toast: document.getElementById("toast")?.textContent,
          body: document.body.innerText.slice(0, 300),
        })),
        errors,
      );
      throw e;
    }
    if (!(await page.locator("#settingsDialog").evaluate((e) => e.open)))
      await page.getByRole("button", { name: "Koneksi & pengaturan" }).click();
    await page.locator("#activeProvider").selectOption("ollama");
    await page.locator("#ollamaModel").fill("fixture-local");
    await page.locator("#ollamaURL").fill("http://127.0.0.1:" + port);
    await page.locator("#openaiKey").fill("fixture-key-NEVER-IN-SETTINGS");
    await page
      .locator("#settingsForm")
      .getByRole("button", { name: "Simpan koneksi" })
      .click();
    await page.waitForFunction(
      () => !document.getElementById("settingsDialog").open,
    );
    const stored = await fs.readFile(path.join(data, "settings.json"), "utf8");
    const vault = await fs.readFile(path.join(data, "vault.json"), "utf8");
    assert.ok(!stored.includes("fixture-key"));
    assert.ok(!vault.includes("fixture-key"));
    await page.locator('[data-mode="work"]').click();
    await page.locator("#prompt").fill("Create the artifact for this test.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("approvalDialog").open ||
        document.querySelector(".message.error"),
    );
    assert.equal(
      await page.locator("#approvalDialog").evaluate((e) => e.open),
      true,
      await page.locator("#messages").textContent(),
    );
    assert.match(await page.locator("#approvalArgs").textContent(), /hello.md/);
    assert.match(
      await page.locator("#taskState").textContent(),
      /Menunggu izin/,
    );
    assert.equal(
      await page.locator('[data-stage="work"]').getAttribute("data-state"),
      "waiting",
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() => document.getElementById("stop").hidden);
    assert.match(
      await fs.readFile(path.join(data, "workspace/hello.md"), "utf8"),
      /Desktop proof/,
    );
    assert.equal(turn, 2);
    assert.match(
      await page.locator("#taskState").textContent(),
      /Perlu ditinjau/,
    );
    assert.equal(
      await page.locator('[data-stage="test"]').getAttribute("data-state"),
      "pending",
      "A model response must never become a passed test",
    );
    await page.screenshot({
      path: path.join(root, "evidence/galaxy-concept/galaxy-ui-task.png"),
    });
    assert.equal(
      await page.locator(".message.assistant .markdown strong").count(),
      1,
    );
    assert.equal(
      await page.locator(".message.assistant .markdown strong").textContent(),
      "artifact written",
    );
    assert.equal(
      await page
        .locator(
          '.message.assistant .markdown script,.message.assistant .markdown img,.message.assistant .markdown a[href^="javascript:"]',
        )
        .count(),
      0,
    );
    assert.equal(await page.evaluate(() => window.__markdownXSS), undefined);
    assert.match(
      await page.locator(".message.assistant .markdown pre code").textContent(),
      /const n = 1/,
    );
    assert.equal(trackingRequests, 0);
    const composerVisible = await page.evaluate(() => {
      const message = document.querySelector(
        ".message.assistant .message-text",
      );
      for (let i = 0; i < 50; i++) {
        const p = document.createElement("p");
        p.textContent = "Long response layout fixture " + i;
        message.append(p);
      }
      const r = document.getElementById("send").getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight;
    });
    assert.equal(
      composerVisible,
      true,
      "Composer/Stop area must remain visible during long responses",
    );
    scenario = "deny";
    const secondWorkspace = path.join(data, "second-workspace");
    await fs.mkdir(secondWorkspace);
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, secondWorkspace);
    await page.locator("#pickFolder").click();
    await page.waitForFunction(
      (folder) =>
        document.getElementById("workspacePath").textContent === folder,
      secondWorkspace,
    );
    assert.equal(
      await page.locator("#messages").textContent(),
      "",
      "A new workspace must clear the previous task context",
    );
    await page.locator("#prompt").fill("Test a denied file action.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    await page.locator("#deny").click();
    await page.waitForFunction(() => document.getElementById("stop").hidden);
    await assert.rejects(() =>
      fs.access(path.join(data, "workspace/denied.md")),
    );
    await assert.rejects(() =>
      fs.access(path.join(secondWorkspace, "denied.md")),
    );
    assert.match(await page.locator("#messages").textContent(), /rejected/i);
    await page.locator("#newTask").click();
    await page.locator("#prompt").fill("Test Stop while waiting for approval.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    await page.locator("#approvalStop").click();
    await page.waitForFunction(
      () =>
        !document.getElementById("approvalDialog").open &&
        document.getElementById("stop").hidden,
    );
    assert.match(await page.locator("#runStatus").textContent(), /cancelled/);
    await page.locator('[data-nav="browser"]').click();
    await page.locator("#address").fill("http://127.0.0.1:" + port);
    await page.locator("#addressForm button").click();
    await page.waitForFunction(() =>
      document.getElementById("address").value.endsWith("/"),
    );
    const snapshot = await page.evaluate(() =>
      window.workbench.browserSnapshot(),
    );
    assert.equal(snapshot.title, "Browser fixture");
    assert.equal(snapshot.targets.length, 2);
    const remote = desktop
      .windows()
      .find((w) => w.url().startsWith("http://127.0.0.1"));
    assert.ok(remote);
    assert.equal(
      await remote.evaluate(() => typeof window.workbench),
      "undefined",
    );
    assert.equal(await remote.evaluate(() => typeof require), "undefined");
    const rejection = await page.evaluate(async () => {
      try {
        await window.workbench.browserNavigate("file:///C:/Windows/win.ini");
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(rejection, true);
    scenario = "browser";
    await page.locator("#newTask").click();
    await page.locator("#prompt").fill("Click the Go button.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("approvalDialog").open ||
        document.querySelector(".message.error"),
    );
    assert.equal(
      await page.locator("#approvalDialog").evaluate((e) => e.open),
      true,
      await page.locator("#messages").textContent(),
    );
    const approval = await page.locator("#approvalArgs").textContent();
    assert.match(approval, /Go/);
    assert.match(approval, /formValues/);
    assert.match(approval, /amount/);
    await remote.evaluate(
      () => (document.querySelector("input").value = "100"),
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() => document.getElementById("stop").hidden);
    assert.match(
      await page.locator("#messages").textContent(),
      /target changed/,
    );
    assert.equal(await remote.locator("h1").textContent(), "Browser test");
    const held = await page.evaluate(() => window.workbench.recoveryList());
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, "browser_click");
    await page.locator('[data-nav="recovery"]').click();
    await page.locator("#recoveryList summary").click();
    await page
      .locator("#recoveryList textarea")
      .fill("Fixture form drift inspected: h1 unchanged, click did not occur.");
    await page
      .getByRole("button", {
        name: "Konfirmasi efek sudah diperiksa",
        exact: true,
      })
      .click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.equal(
      await page.locator("#approvalTool").textContent(),
      "recoveryResolve",
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() =>
      document
        .getElementById("recoveryList")
        .textContent.includes("Tidak ada efek"),
    );
    assert.equal(
      (await page.evaluate(() => window.workbench.recoveryList())).length,
      0,
    );
    await page.locator('[data-nav="browser"]').click();
    await page.locator("#newTask").click();
    await page.locator("#prompt").fill("Click the fresh Go button.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() => document.getElementById("stop").hidden);
    assert.equal(await remote.locator("h1").textContent(), "Clicked");
    await page.locator('[data-nav="computer"]').click();
    await page
      .locator("#terminalCommand")
      .fill("Write-Output 'POWERSHELL_OK'; Get-Location");
    await page.locator("#terminalRun").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.match(
      await page.locator("#approvalArgs").textContent(),
      /POWERSHELL_OK/,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(() =>
      document.getElementById("terminalOutput").textContent.includes("Exit 0"),
    );
    assert.match(
      await page.locator("#terminalOutput").textContent(),
      /POWERSHELL_OK/,
    );
    await page.locator("#refreshWindows").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.equal(
      await page.locator("#approvalTool").textContent(),
      "desktop_windows",
    );
    await page.locator("#allow").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#windowList button").length > 0,
    );
    assert.match(await page.locator("#windowList").textContent(), /miganGO/);
    await page.locator('[data-nav="research"]').click();
    await page
      .locator("#researchURLs")
      .fill(
        "https://github.com/example/fixture?utm_source=test\nhttps://github.com/example/fixture",
      );
    await page.locator("#researchImportForm button").click();
    await page.waitForFunction(
      () => document.querySelectorAll(".reference-card").length === 1,
    );
    await page.locator(".reference-card summary").click();
    await page.locator(".reference-card input").fill("Fixture reference");
    await page
      .locator(".reference-card textarea")
      .fill("Source not yet read; metadata fixture only.");
    await page
      .locator(".reference-card button")
      .filter({ hasText: "Simpan catatan" })
      .click();
    await page.waitForFunction(() =>
      document
        .querySelector(".reference-card summary")
        .textContent.includes("Fixture reference"),
    );
    await page.locator("#researchExport").click();
    await page.waitForFunction(() =>
      document
        .getElementById("researchStatus")
        .textContent.startsWith("Artifact:"),
    );
    const exported = (await fs.readdir(path.join(data, "artifacts"))).find(
      (f) => f.startsWith("research-") && f.endsWith(".md"),
    );
    assert.ok(exported);
    assert.match(
      await fs.readFile(path.join(data, "artifacts", exported), "utf8"),
      /owner-asserted/,
    );
    const metrics = await desktop.evaluate(({ app }) => ({
      versions: process.versions,
      processes: app
        .getAppMetrics()
        .map((p) => ({ type: p.type, workingSetKiB: p.memory.workingSetSize })),
    }));
    await page.locator('[data-nav="files"]').click();
    await fs.mkdir(path.join(root, "evidence"), { recursive: true });
    await page.screenshot({ path: path.join(root, "evidence/desktop.png") });
    await fs.writeFile(
      path.join(root, "evidence/desktop-metrics.json"),
      JSON.stringify(
        {
          kind: "local-electron-fixture",
          date: new Date().toISOString(),
          turns: turn,
          nativePowerShell: true,
          nativeWindowsInventory: true,
          referenceInbox: true,
          beforeBrowser,
          errors,
          metrics,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(errors, []);
    const history = await page.evaluate(() => window.workbench.history());
    assert.equal(history.length, 5);
    const finished = await page.evaluate(
      (id) => window.workbench.loadRun(id),
      history.find((r) => r.title === "Create the artifact for this test.").id,
    );
    assert.deepEqual(finished.artifacts, ["hello.md"]);
    assert.equal(finished.status, "needs-validation");
    assert.equal(finished.validation.accepted, false);
    assert.match(finished.artifactReceipts[0].sha256, /^[a-f0-9]{64}$/);
    // Closing tests a pending write, independently from the prior browser scenario.
    scenario = "close";
    await page.locator("#newTask").click();
    await page.locator("#prompt").fill("Close while approval is pending.");
    await page.locator("#send").click();
    await page.waitForFunction(
      () =>
        document.getElementById("approvalDialog").open ||
        document.querySelector(".message.error"),
    );
    assert.equal(
      await page.locator("#approvalDialog").evaluate((e) => e.open),
      true,
      await page.locator("#messages").textContent(),
    );
    const appClosed = desktop.waitForEvent("close");
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await appClosed;
    desktop = undefined;
    const runFiles = await fs.readdir(path.join(data, "runs"));
    const closedRuns = await Promise.all(
      runFiles
        .filter((f) => f.endsWith(".json"))
        .map(async (f) =>
          JSON.parse(await fs.readFile(path.join(data, "runs", f), "utf8")),
        ),
    );
    assert.equal(
      closedRuns.find((r) => r.title === "Close while approval is pending.")
        .status,
      "cancelled",
    );
  },
);
