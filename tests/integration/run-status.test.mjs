// K01 (ARS-005): the UI shows Migan's human status during a run (including "terpotong, melanjutkan 1/3"
// when a reply is cut at the output limit) and a visible usage line from agen.pemakaian. Uses a local
// Ollama-shaped fixture server; no paid API, no network. Needs the Electron binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

test(
  "real Electron: run status shows the continuation label and the usage line",
  { timeout: 90000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-runstatus-"));
    let calls = 0;
    const labels = [];
    const server = http.createServer(async (req, res) => {
      if (req.url !== "/api/chat") {
        res.writeHead(404).end();
        return;
      }
      for await (const _ of req);
      calls++;
      // First reply is cut at the output limit (Ollama done_reason "length"), the second completes.
      const cut = calls === 1;
      if (!cut) await new Promise((r) => setTimeout(r, 400));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "fixture-local",
          message: { role: "assistant", content: cut ? "Bagian pertama" : "Selesai." },
          done: true,
          done_reason: cut ? "length" : "stop",
          prompt_eval_count: 25,
          eval_count: 8,
        }),
      );
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
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
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await fs.rm(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });
    const page = await desktop.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    if (!(await page.locator("#settingsDialog").evaluate((e) => e.open)))
      await page.getByRole("button", { name: "Koneksi & pengaturan" }).click();
    await page.locator("#activeProvider").selectOption("ollama");
    await page.locator("#ollamaModel").fill("fixture-local");
    await page.locator("#ollamaURL").fill("http://127.0.0.1:" + port);
    await page.locator("#settingsForm").getByRole("button", { name: "Simpan koneksi" }).click();
    await page.waitForFunction(() => !document.getElementById("settingsDialog").open);

    await page.exposeFunction("recordStatus", (text) => labels.push(text));
    await page.evaluate(() => {
      new MutationObserver(() => window.recordStatus(document.getElementById("runStatus").textContent)).observe(
        document.getElementById("runStatus"),
        { childList: true, characterData: true, subtree: true },
      );
    });
    await page.locator('[data-mode="ask"]').click();
    await page.locator("#prompt").fill("Halo Migan, jelaskan singkat.");
    await page.locator("#send").click();
    await page.waitForFunction(() => document.getElementById("usageLine").hidden === false);
    await page.waitForFunction(
      () => !document.getElementById("send").disabled,
      {},
      { timeout: 30000 },
    );
    assert.equal(calls, 2, "one continuation after the cut reply");
    assert.ok(
      labels.some((l) => /terpotong, melanjutkan 1\/3/.test(l)),
      "continuation label shown: " + labels.join(" | "),
    );
    const usage = await page.locator("#usageLine").textContent();
    assert.match(usage, /Token: 50 masuk · 16 keluar/);
    assert.match(usage, /batas per permintaan/);
    // The fixture is a local model: no dollar cost (PRD-019 receipt).
    assert.match(usage, /Model lokal; tidak ada biaya dolar/);

    await desktop.close();
    desktop = undefined;
  },
);
