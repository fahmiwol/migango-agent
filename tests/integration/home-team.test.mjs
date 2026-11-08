import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "existing MiganGO shell has purpose tabs, source-backed employee roster and preserved work draft",
  { timeout: 60000 },
  async (t) => {
    let providerCalls = 0;
    const server = http.createServer((_req, res) => {
      providerCalls++;
      res.writeHead(500).end();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const baseURL = "http://127.0.0.1:" + server.address().port;
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-home-team-")),
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
      await fs.rm(data, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const page = await app.firstWindow(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.getElementById("settingsDialog").open,
    );
    await page.locator("#closeSettings").click();
    assert.equal(
      await page.getByRole("tab", { name: "Tim AI", exact: true }).count(),
      1,
      "a real purpose tab belongs in the existing desktop",
    );
    assert.equal(await page.locator(".sidebar .brand-logo").count(), 1);
    assert.ok(await page.locator('.galaxy-nav [data-nav="files"]').count());
    assert.equal(
      await page.locator(".composer #taskTeam").count(),
      0,
      "team settings no longer crowd the writing area",
    );
    assert.equal(
      await page.locator("#taskTeamSettings").evaluate((e) => e.open),
      false,
    );
    assert.match(
      (await page.locator("#teamTemporaryHint").textContent()).replace(
        /\s+/g,
        " ",
      ),
      /Profil.*tetap tersimpan/,
    );
    assert.match(
      (await page.locator("#teamLearnHint").textContent()).replace(/\s+/g, " "),
      /tidak otomatis melatih model/,
    );
    await page.evaluate(async (baseURL) => {
      const s = await window.workbench.settings();
      await window.workbench.saveSettings({
        ...s,
        active: "ollama",
        internalMemory: false,
        profiles: {
          ...s.profiles,
          ollama: { model: "fixture-parent", baseURL },
        },
        modelRegistry: [
          {id:"another-fixture",provider:"ollama",model:"another-model",baseURL,capabilities:["text","code","tools"],enabled:true},
          {
            id: "employee-fixture",
            provider: "ollama",
            model: "fixture-model",
            baseURL,
            capabilities: ["text", "code", "tools"],
            enabled: true,
          },
        ],
      });
    }, baseURL);
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#taskModel option[value="employee-fixture"]'),
    );
    const denied = await app.evaluate(
      async ({ BrowserWindow }, { preload }) => {
        const foreign = new BrowserWindow({
          show: false,
          webPreferences: {
            preload,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        try {
          await foreign.loadURL("about:blank");
          return await foreign.webContents.executeJavaScript(
            'if(!window.workbench?.employeeProfiles)throw Error("Missing test preload");window.workbench.employeeProfiles().then(()=>false,()=>true)',
          );
        } finally {
          foreign.destroy();
        }
      },
      { preload: path.join(root, "src/desktop/preload.cjs") },
    );
    assert.equal(
      denied,
      true,
      "metadata IPC rejects a foreign renderer before dispatch",
    );
    const draft = "Bantu saya menyiapkan pekerjaan yang bisa diperiksa.";
    await page.locator("#prompt").fill(draft);
    await page.getByRole("tab", { name: "Tim AI", exact: true }).click();
    await page.locator("#openRecruit").click();
    await page.locator("#employeeTemplate").selectOption("designer");
    assert.equal(
      await page.locator("#teamMemberName").inputValue(),
      "Dina Mahesa",
    );
    await page.locator("#teamMemberModel").selectOption("employee-fixture");
    await page.locator("#teamMemberAccess").selectOption("edit");
    await page.locator("#saveTeamMember").click();
    await page.waitForFunction(() =>
      document.getElementById("agentsList").textContent.includes("Dina Mahesa"),
    );
    assert.equal(
      await page.locator("#employeeTemplate").inputValue(),
      "",
      "the next member starts with a blank template",
    );
    assert.equal(await page.locator("#teamMemberAccess").inputValue(), "none");
    assert.match(
      await page.locator("#agentsList").innerText(),
      /Desain|visual/,
    );
    assert.match(await page.locator("#agentsList").innerText(), /Migan/);
    assert.equal(
      (await page.evaluate(() => window.workbench.history())).length,
      0,
      "viewing/importing metadata starts no runtime",
    );
    await page
      .locator("#agentsList .agent-card")
      .filter({ hasText: "Dina Mahesa" })
      .getByRole("button", { name: "Gunakan untuk tugas ini", exact: true })
      .click();
    assert.equal(
      await page.locator("#taskTeamSettings").evaluate((e) => e.open),
      true,
    );
    assert.match(
      await page.locator("#taskTeamSummary").textContent(),
      /Dina Mahesa/,
    );
    await page.locator("#inspectorToggle").click();
    assert.equal(await page.locator("#inspector").isVisible(), false);
    assert.match(
      await page.locator("#taskTeamQuick").innerText(),
      /Dina Mahesa/,
    );
    await page.locator("#taskTeamQuick").click();
    assert.equal(
      await page.locator("#taskTeamSettings").evaluate((e) => e.open),
      true,
    );
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    assert.equal(
      (await page.evaluate(() => window.workbench.history())).length,
      0,
      "Use for this task selects without executing",
    );
    await page.getByRole("tab", { name: "Percakapan", exact: true }).click();
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    await page.getByRole("tab", { name: "Hasil", exact: true }).click();
    assert.match(
      await page.locator("#resultsWorkspace").innerText(),
      /Belum|hasil|Hasil/,
    );
    await page.getByRole("tab", { name: "Percakapan", exact: true }).click();
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    await page.getByRole("tab", { name: "Tim AI", exact: true }).click();
    assert.equal(
      await page.locator("#teamMemberModel").inputValue(),
      "employee-fixture",
      "reopening retains the chosen recruitment model",
    );
    const shot = process.env.MIGANGO_TEAM_SCREENSHOT;
    if (shot)
      await page.screenshot({ path: shot.replace(/\.png$/, "-employees.png") });
    await page.getByRole("tab", { name: "Percakapan", exact: true }).click();
    if (shot)
      await page.screenshot({ path: shot.replace(/\.png$/, "-home.png") });
    await page.getByRole("tab", { name: "Percakapan", exact: true }).focus();
    await page.keyboard.press("End");
    await page.waitForFunction(
      () => document.activeElement?.dataset.workspaceTab === "results",
    );
    await page.keyboard.press("Home");
    await page.waitForFunction(
      () => document.activeElement?.dataset.workspaceTab === "chat",
    );
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () => document.activeElement?.dataset.workspaceTab === "team",
    );
    await page.setViewportSize({ width: 800, height: 800 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "compact team does not overflow horizontally",
    );
    if (shot)
      await page.screenshot({ path: shot.replace(/\.png$/, "-compact.png") });
    await page.reload();
    await page.getByRole("tab", { name: "Tim AI", exact: true }).click();
    await page.waitForFunction(() =>
      document.getElementById("agentsList").textContent.includes("Dina Mahesa"),
    );
    assert.equal(
      providerCalls,
      0,
      "boot, listing, importing and selecting never call a provider",
    );
    assert.deepEqual(errors, []);
  },
);

async function liveFixture(t, handle) {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-tabs-live-")),
    seen = [],
    errors = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET") {
        seen.push({ kind: "page" });
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<!doctype html><title>Browser state</title><p>Browser remains on this page.</p>",
        );
        return;
      }
      let raw = "";
      for await (const b of req) raw += b;
      const body = JSON.parse(raw);
      seen.push({ kind: "model", body });
      await handle(body, res);
    } catch (e) {
      errors.push(e.message);
      if (!res.destroyed) res.end();
    }
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
  await page.evaluate(async (base) => {
    const s = await window.workbench.settings();
    await window.workbench.saveSettings({
      ...s,
      active: "ollama",
      internalMemory: false,
      profiles: {
        ...s.profiles,
        ollama: { model: "fixture-parent", baseURL: base },
      },
      modelRegistry: [],
    });
  }, base);
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("activeProvider").value === "ollama",
  );
  return { data, page, app, base, seen, errors };
}
function sendFixture(res, message) {
  if (res.destroyed) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      model: "fixture-parent",
      message,
      done: true,
      done_reason: "stop",
      prompt_eval_count: 20,
      eval_count: 5,
    }),
  );
}
test(
  "tab switching keeps the live Stop control and browser session while cancelling the real pending request",
  { timeout: 60000 },
  async (t) => {
    let ready,
      closed = false;
    const started = new Promise((r) => (ready = r));
    const f = await liveFixture(t, async (body, res) => {
      ready();
      await new Promise((r) =>
        res.once("close", () => {
          closed = true;
          r();
        }),
      );
    });
    await f.page.locator('[data-nav="browser"]').click();
    await f.page.evaluate(
      (base) => window.workbench.browserNavigate(base + "/page"),
      f.base,
    );
    await f.page.locator("#prompt").fill("Tunggu sebelum menjawab.");
    await f.page.locator("#send").click();
    await started;
    await f.page.getByRole("tab", { name: "Tim AI", exact: true }).click();
    assert.equal(await f.page.locator("#stop").isVisible(), true);
    await f.page.getByRole("tab", { name: "Hasil", exact: true }).click();
    assert.equal(await f.page.locator("#stop").isVisible(), true);
    await f.page.locator("#stop").click();
    await f.page.waitForFunction(() => document.getElementById("stop").hidden);
    const ids = (await fs.readdir(path.join(f.data, "runs"))).filter((n) =>
      n.endsWith(".json"),
    );
    const run = JSON.parse(
      await fs.readFile(path.join(f.data, "runs", ids[0]), "utf8"),
    );
    assert.equal(run.status, "cancelled");
    await new Promise((r) => setImmediate(r));
    assert.equal(
      closed,
      true,
      "Stop closes the pending provider response socket",
    );
    assert.equal(f.seen.filter((r) => r.kind === "model").length, 1);
    assert.equal(
      f.seen.filter((r) => r.kind === "page").length,
      1,
      "tabs never re-navigate the controlled browser",
    );
    assert.deepEqual(f.errors, []);
  },
);
test(
  "file approval works from the Results tab and completed output appears there with its real hash",
  { timeout: 60000 },
  async (t) => {
    let ready, release;
    const started = new Promise((r) => (ready = r)),
      gate = new Promise((r) => (release = r));
    let turn = 0;
    const content = "Actual tab approval fixture\n";
    const f = await liveFixture(t, async (body, res) => {
      if (turn++ === 0) {
        ready();
        await gate;
        sendFixture(res, {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              function: {
                name: "write_file",
                arguments: {
                  path: "tab-result.txt",
                  content,
                  expectedHash: null,
                },
              },
            },
          ],
        });
      } else
        sendFixture(res, { role: "assistant", content: "TAB_RESULT_READY" });
    });
    await f.page.locator('[data-mode="work"]').click();
    await f.page
      .locator("#prompt")
      .fill("Tulis tab-result.txt setelah izin saya.");
    await f.page.locator("#send").click();
    await started;
    await f.page.getByRole("tab", { name: "Hasil", exact: true }).click();
    release();
    await f.page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.match(
      await f.page.locator("#approvalTool").innerText(),
      /write_file/,
    );
    const workspace = (await f.page.evaluate(() => window.workbench.settings()))
      .workspace;
    await assert.rejects(fs.access(path.join(workspace, "tab-result.txt")));
    await f.page.locator("#allow").click();
    await f.page.waitForFunction(
      () =>
        document.getElementById("stop").hidden &&
        document
          .getElementById("resultsList")
          .textContent.includes("tab-result.txt"),
    );
    assert.equal(
      await fs.readFile(path.join(workspace, "tab-result.txt"), "utf8"),
      content,
    );
    const { createHash } = await import("node:crypto");
    assert.ok(
      (await f.page.locator("#resultsList").textContent()).includes(
        createHash("sha256").update(content).digest("hex"),
      ),
    );
    assert.equal(f.seen.filter((r) => r.kind === "model").length, 2);
    await f.page.evaluate(() =>
      Promise.all([renderResults(), renderResults()]),
    );
    assert.equal(
      await f.page.locator("#resultsList .result-card").count(),
      1,
      "overlapping refreshes render one copy of each output",
    );
    await f.page
      .getByRole("button", { name: "Periksa berkas", exact: true })
      .click();
    await f.page.waitForFunction(() =>
      document
        .getElementById("fileText")
        .textContent.includes("Actual tab approval fixture"),
    );
    assert.deepEqual(f.errors, []);
  },
);
