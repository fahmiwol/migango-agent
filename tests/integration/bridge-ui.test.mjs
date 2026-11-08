// Bridge-started runs in the trusted window: real workbench-event IPC and real loadRun over run fixtures.
// No engine, provider or bridge call is made. Needs the Electron binary (`npm run test:desktop`).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "../..");

test(
  "real Electron: bridge runs show only their own thread and model; late events from another run are ignored",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-bridge-ui-"));
    assert.equal(path.dirname(data), os.tmpdir());
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    // First launch has no stored key, so startup opens Settings modally; close it through the real UI.
    await page.waitForFunction(() => document.getElementById("settingsDialog")?.open);
    await page.locator("#closeSettings").click();
    await page.waitForFunction(() => !document.getElementById("settingsDialog").open);

    const settings = await page.evaluate(() => window.workbench.settings());
    const workspace = settings.workspace;
    assert.notEqual(settings.active, "kimi", "fixture needs a different active connection");
    const activeModel = settings.profiles[settings.active]?.model;

    const send = (event) =>
      desktop.evaluate(({ BrowserWindow }, e) => {
        const trusted = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith("file:"),
        );
        trusted.webContents.send("workbench-event", e);
      }, event);
    const saveRun = (run) =>
      fs.writeFile(path.join(data, "runs", run.id + ".json"), JSON.stringify(run, null, 2));
    const thread = () =>
      page.evaluate(() =>
        [...document.querySelectorAll("#messages .message")].map((m) => ({
          role: ["user", "assistant", "error"].find((r) => m.classList.contains(r)),
          text: m.querySelector(".message-text").textContent.trim(),
        })),
      );
    const shown = (text) =>
      page.waitForFunction(
        (t) => document.getElementById("messages").textContent.includes(t),
        text,
        { timeout: 5000 },
      );
    const idle = () =>
      page.waitForFunction(() => document.getElementById("stop").hidden, {}, { timeout: 5000 });
    const busyState = () =>
      page.evaluate(() => ({
        stop: !document.getElementById("stop").hidden,
        send: document.getElementById("send").disabled,
        body: document.body.dataset.busy,
      }));
    const text = (id) => page.locator("#" + id).textContent();
    const at = () => new Date().toISOString();

    // Run files exactly as the runtime writes them: saved as "running" before start, rewritten at finish.
    const validation = {
      status: "not-run",
      accepted: false,
      reason: "No host acceptance validator has evaluated this candidate",
    };
    const fixture = ({ title, prompt, created, profile, level }) => ({
      id: randomUUID(),
      title,
      prompt,
      mode: "work",
      workspace,
      agent: { id: "migan", nama: "Migan", role: "utama" },
      routingPlan: {
        route: "coding",
        level,
        critical: false,
        source: "auto",
        effort: level === "high" ? "high" : "low",
        selectionReason: "fixture",
        costEstimate: null,
      },
      profile: {
        reason: "fixture",
        selectionReason: "fixture",
        verification: { status: "not-tested" },
        route: "coding",
        ...profile,
      },
      created,
      status: "running",
      events: [],
      usage: { input: 0, output: 0, cached: 0 },
      artifacts: [],
      artifactReceipts: [],
      validation,
    });
    const startEvent = (run) => ({
      type: "start",
      id: run.id,
      runId: run.id,
      profile: run.profile,
      routingPlan: run.routingPlan,
      agent: run.agent,
      workspace: run.workspace,
      at: at(),
    });
    const usage = { input: 120, output: 40, cached: 0, cacheCreated: 0, available: true };
    const finishEvent = (run) => ({
      type: "finish",
      runId: run.id,
      status: "responded",
      usage,
      artifacts: [],
      validation,
    });
    const finished = (run, answer) => {
      const start = startEvent(run);
      delete start.runId;
      return {
        ...run,
        status: "responded",
        events: [start, { type: "assistant", text: answer, at: at() }],
        usage: { input: usage.input, output: usage.output, cached: usage.cached },
        final: answer,
      };
    };

    const A = fixture({
      title: "Laporan jembatan A",
      prompt: "Prompt A dari jembatan: ringkas laporan proyek",
      created: "2026-10-25T08:00:00.000Z",
      profile: { id: "kimi-coder", provider: "kimi", model: "kimi-k2.6", credentialId: "kimi" },
      level: "low",
    });
    const B = fixture({
      title: "Tinjauan jembatan B",
      prompt: "Prompt B dari jembatan: tinjau rencana rilis",
      created: "2026-10-25T08:05:00.000Z",
      profile: {
        id: "opus-55",
        provider: "anthropic",
        model: "claude-opus-5-5",
        credentialId: "anthropic",
      },
      level: "high",
    });
    const answerA = "Jawaban A dari Kimi selesai";
    const answerB = "Jawaban B dari Opus selesai";
    const lateA = "Jawaban A terlambat tidak boleh tampil";
    const draft = "Draf pemilik yang belum dikirim";

    // (A) Bridge start: busy, only A's prompt (from the run file via loadRun), A's actual Kimi profile.
    await saveRun(A);
    await send(startEvent(A));
    await shown(A.prompt);
    assert.deepEqual(await busyState(), { stop: true, send: true, body: "true" });
    assert.deepEqual(await thread(), [{ role: "user", text: A.prompt }]);
    const modelA = await text("modelSummary");
    assert.match(modelA, /kimi-k2\.6/, "model panel must show the run's profile: " + modelA);
    if (activeModel)
      assert.ok(!modelA.includes(activeModel), "model panel still shows the active connection: " + modelA);
    await send({
      type: "tool-start",
      id: "a-tool",
      name: "read_file",
      args: { path: "A-activity-marker.md" },
      runId: A.id,
      at: at(),
    });
    await send({ type: "assistant", text: answerA, runId: A.id, at: at() });
    await shown(answerA);
    assert.match(await text("activity"), /A-activity-marker/);
    await saveRun(finished(A, answerA));
    await send(finishEvent(A));
    await idle();
    assert.deepEqual(await thread(), [
      { role: "user", text: A.prompt },
      { role: "assistant", text: answerA },
    ]);

    // (B) A second bridge run replaces A's thread and activity but keeps the owner's unsent draft.
    await page.locator("#prompt").fill(draft);
    await saveRun(B);
    await send(startEvent(B));
    await shown(B.prompt);
    assert.deepEqual(await busyState(), { stop: true, send: true, body: "true" });
    assert.deepEqual(await thread(), [{ role: "user", text: B.prompt }]);
    assert.doesNotMatch(await text("activity"), /A-activity-marker/);
    assert.equal(await page.locator("#prompt").inputValue(), draft);
    const modelB = await text("modelSummary");
    assert.match(modelB, /^(Model tugas ini|This task.s model): .*claude-opus-5-5/, modelB);
    assert.doesNotMatch(modelB, /kimi/i, modelB);
    // IPC is ordered: once B's answer is shown, the earlier late A event has been handled.
    await send({ type: "assistant", text: lateA, runId: A.id, at: at() });
    await send({ type: "assistant", text: answerB, runId: B.id, at: at() });
    await shown(answerB);
    assert.deepEqual(await thread(), [
      { role: "user", text: B.prompt },
      { role: "assistant", text: answerB },
    ]);
    await saveRun(finished(B, answerB));
    await send(finishEvent(B));
    await idle();
    const afterB = await text("messages");
    for (const leaked of [A.prompt, answerA, lateA]) assert.ok(!afterB.includes(leaked), leaked);
    const modelDone = await text("modelSummary");
    // UX spec 29 Oct 2026 (U1): once the run ends the control shows the NEXT model again.
    assert.match(modelDone, /^(Model berikutnya|Next model): /, modelDone);
    assert.equal(await page.locator("#prompt").inputValue(), draft);

    // (C) Selecting A from history while idle shows A only, with A's actual Kimi profile.
    await page.locator("#history button").filter({ hasText: A.title }).click({ timeout: 5000 });
    await shown(A.prompt);
    assert.deepEqual(await thread(), [
      { role: "user", text: A.prompt },
      { role: "assistant", text: answerA },
    ]);
    assert.match(await text("runStatus"), /kimi \/ kimi-k2\.6/);
    const modelHistory = await text("modelSummary");
    // The history view names the run in #runStatus (above); the control stays on the next model.
    assert.match(modelHistory, /^(Model berikutnya|Next model): /, modelHistory);
    assert.deepEqual(errors, []);

    await desktop.close();
    desktop = undefined;
  },
);
