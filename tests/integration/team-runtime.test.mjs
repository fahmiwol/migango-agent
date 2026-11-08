// End-to-end app/HTTP protocol/host file effect. Local deterministic provider, no paid model or credentials.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { _electron } from "playwright-core";
import { createHash } from "node:crypto";
const root = path.resolve(import.meta.dirname, "../..");
test(
  "real Electron team: council approval, actor-bound file change, reviewer read and parent synthesis",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migan-team-e2e-")),
      seen = [],
      errors = [];
    const calls = new Map();
    const content = "MiganGO team fixture\n";
    const server = http.createServer(async (req, res) => {
      try {
        let raw = "";
        for await (const b of req) raw += b;
        const body = JSON.parse(raw);
        seen.push(body);
        const n = (calls.get(body.model) || 0) + 1;
        calls.set(body.model, n);
        let message = { role: "assistant", content: "" };
        if (body.model === "fixture-koda" && n === 1)
          message.tool_calls = [
            {
              function: {
                name: "write_file",
                arguments: {
                  path: "team-proof.txt",
                  content,
                  expectedHash: null,
                },
              },
            },
          ];
        else if (body.model === "fixture-review" && n === 1)
          message.tool_calls = [
            {
              function: {
                name: "read_file",
                arguments: { path: "team-proof.txt" },
              },
            },
          ];
        else if (body.model === "fixture-review") {
          const actual = body.messages.findLast((m) => m.role === "tool");
          assert.ok(actual?.content.includes("MiganGO team fixture"));
          message.content =
            "Reviewer confirmed the file content from read_file.";
        } else if (body.model === "fixture-koda")
          message.content = "Koda wrote team-proof.txt with host approval.";
        else {
          assert.equal(body.model, "fixture-parent");
          assert.ok(
            body.messages.some((m) =>
              m.content?.includes("Reviewer confirmed"),
            ),
          );
          message.content =
            "E2E_TEAM_VERIFIED: file created and reviewed; acceptance still needs owner review.";
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: body.model,
            message,
            done: true,
            done_reason: "stop",
            prompt_eval_count: 20,
            eval_count: 5,
          }),
        );
      } catch (e) {
        errors.push(e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Fixture assertion failed" }));
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    t.after(
      () =>
        new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
    );
    const baseURL = "http://127.0.0.1:" + server.address().port,
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
    const page = await desktop.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => document.getElementById("settingsDialog").open,
    );
    await page.locator("#closeSettings").click();
    const registry = ["koda", "review"].map((id) => ({
      id: "profile-" + id,
      provider: "ollama",
      model: "fixture-" + id,
      baseURL,
      capabilities: ["text", "code", "tools"],
      enabled: true,
    }));
    await page.evaluate(
      async ({ baseURL, registry }) => {
        const s = await window.workbench.settings();
        await window.workbench.saveSettings({
          ...s,
          active: "ollama",
          internalMemory: false,
          profiles: {
            ...s.profiles,
            ollama: { model: "fixture-parent", baseURL },
          },
          modelRegistry: registry,
        });
      },
      { baseURL, registry },
    );
    await page.reload();
    await page.waitForFunction(() =>
      document.querySelector('#taskModel option[value="profile-koda"]'),
    );
    await page.locator("#agentsBtn").click();
    for (const [id, name, access] of [
      ["koda", "Koda", "edit"],
      ["review", "Reviewer", "read"],
    ]) {
      await page.locator("#teamMemberName").fill(name);
      await page.locator("#teamMemberModel").selectOption("profile-" + id);
      await page.locator("#teamMemberAccess").selectOption(access);
      await page.locator("#saveTeamMember").click();
      await page.waitForFunction(
        (n) =>
          Array.from(document.querySelectorAll("#agentsList strong")).some(
            (e) => e.textContent === n,
          ),
        name,
      );
    }
    const members = await page.evaluate(() => window.workbench.agentCatalog());
    const ids = ["Koda", "Reviewer"].map(
      (name) => members.cards.find((c) => c.nama === name).id,
    );
    await page.locator("#closeAgents").click();
    await page.locator("#taskTeamSettings > summary").click();
    await page.locator("#taskTeam").selectOption("council:" + ids.join(","));
    await page.locator("#teamTemporary").check();
    await page.locator('[data-mode="work"]').click();
    await page
      .locator("#prompt")
      .fill(
        "Create team-proof.txt, then independently read and review its content.",
      );
    await page.locator("#send").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
    );
    assert.match(
      await page.locator("#approvalTool").textContent(),
      /majelis_agen/,
    );
    assert.equal(seen.length, 0, "approval precedes every provider");
    assert.equal(await page.locator("#taskTeam").isDisabled(), true);
    assert.equal(
      await page.evaluate(async () => {
        try {
          await window.workbench.teamMemberAdd({
            name: "Too late",
            profileId: "profile-koda",
            access: "read",
          });
          return false;
        } catch {
          return true;
        }
      }),
      true,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(
      () =>
        document.getElementById("approvalDialog").open &&
        document
          .getElementById("approvalTool")
          .textContent.includes("write_file"),
    );
    assert.equal(seen.length, 1);
    assert.match(
      await page.locator("#approvalTool").textContent(),
      /bayangan-/,
    );
    const workspace = (await page.evaluate(() => window.workbench.settings()))
      .workspace;
    assert.ok(
      path.resolve(workspace).startsWith(path.resolve(data) + path.sep),
    );
    await assert.rejects(fs.access(path.join(workspace, "team-proof.txt")));
    const board = await page.evaluate(() => window.workbench.agentStatus());
    assert.ok(
      board.some(
        (s) => s.agentId.startsWith("bayangan-") && s.state === "menunggu-izin",
      ),
      "child approval status is attributed to child",
    );
    await page.locator("#allow").click();
    await page.waitForFunction(
      () =>
        document.getElementById("stop").hidden &&
        document
          .getElementById("messages")
          .textContent.includes("E2E_TEAM_VERIFIED"),
    );
    assert.equal(
      await fs.readFile(path.join(workspace, "team-proof.txt"), "utf8"),
      content,
    );
    assert.deepEqual(
      seen.map((r) => r.model),
      [
        "fixture-koda",
        "fixture-koda",
        "fixture-review",
        "fixture-review",
        "fixture-parent",
      ],
    );
    const records = await Promise.all(
        (await fs.readdir(path.join(data, "runs")))
          .filter((n) => n.endsWith(".json"))
          .map((n) =>
            fs.readFile(path.join(data, "runs", n), "utf8").then(JSON.parse),
          ),
      ),
      parent = records.find((r) => !r.parentRunId);
    assert.equal(parent.status, "needs-validation");
    assert.equal(parent.validation.accepted, false);
    assert.equal(parent.delegations.length, 2);
    assert.ok(parent.delegations.every((r) => r.status === "succeeded"));
    assert.equal(parent.artifactReceipts.length, 1);
    assert.equal(parent.artifactReceipts[0].path, "team-proof.txt");
    assert.equal(
      (await page.evaluate(() => window.workbench.agentStatus())).some((s) =>
        s.agentId.startsWith("bayangan-"),
      ),
      false,
    );
    assert.equal(
      (await page.evaluate(() => window.workbench.agentCatalog())).cards.length,
      3,
    );
    assert.equal(
      parent.artifactReceipts[0].sha256,
      createHash("sha256").update(content).digest("hex"),
    );
    await page.waitForFunction(
      () => document.querySelectorAll("#history button").length === 1,
    );
    const shot = process.env.MIGANGO_TEAM_SCREENSHOT;
    if (shot)
      await page.screenshot({
        path: shot.replace(/\.png$/, "-runtime.png"),
        fullPage: false,
      });
    assert.deepEqual(errors, []);
  },
);
