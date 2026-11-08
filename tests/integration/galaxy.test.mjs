import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _electron } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
test(
  "Galaxy shell keeps real tools reachable, keyboard access and small-window layout",
  { timeout: 60000 },
  async (t) => {
    const data = await fs.mkdtemp(path.join(os.tmpdir(), "migango-galaxy-ui-"));
    assert.equal(path.dirname(data), os.tmpdir());
    const workspace = path.join(data, "workspace");
    await fs.mkdir(path.join(workspace, ".agents/skills/galaxy-fixture"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspace, "README.md"),
      "# Galaxy fixture\nRead-only UI proof.\n",
    );
    await fs.writeFile(
      path.join(workspace, ".agents/skills/galaxy-fixture/SKILL.md"),
      "---\nname: galaxy-fixture\ndescription: Read the fixture without writing.\n---\nUse only this fixture.\n",
    );
    let desktop;
    t.after(async () => {
      if (desktop) {
        try {
          const page = await desktop.firstWindow();
          await fs.writeFile(
            path.join(
              root,
              "evidence/galaxy-concept/ui-last-run-diagnostic.json",
            ),
            JSON.stringify(
              await page.evaluate(() => ({
                terminal:
                  document.getElementById("terminalOutput")?.textContent,
                state: document.getElementById("taskState")?.textContent,
                toast: document.getElementById("toast")?.textContent,
              })),
              null,
              2,
            ),
          );
        } catch {}
      }
      await desktop?.close();
      await fs.rm(data, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
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
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForFunction(
      () => document.getElementById("workspacePath")?.textContent.length > 0,
      {},
      { timeout: 5000 },
    );
    if (await page.locator("#settingsDialog").evaluate((e) => e.open))
      await page.locator("#closeSettings").click();
    assert.equal(
      await page.locator('[data-nav="home"]').count(),
      1,
      "Approved Galaxy navigation must exist",
    );
    assert.equal(
      await page.locator(".brand-logo").getAttribute("alt"),
      "miganGO",
    );
    await page.locator('[data-nav="files"]').click();
    await page
      .locator("#fileList button")
      .filter({ hasText: "README.md" })
      .click();
    await page
      .locator("#filePreview")
      .waitFor({ state: "visible", timeout: 5000 });
    // K05: Markdown opens in the isolated mgpreview guest view, not in the trusted window.
    let guest;
    for (let i = 0; i < 50 && !guest; i++) {
      guest = desktop
        .windows()
        .find((w) => w.url().startsWith("mgpreview://"));
      if (!guest) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(guest, "preview guest not found");
    assert.match(guest.url(), /^mgpreview:\/\/[a-f0-9]{32}\/README\.md$/);
    await guest.waitForFunction(
      () => /Read-only UI proof/.test(document.body?.innerText || ""),
      {},
      { timeout: 5000 },
    );
    assert.equal(
      await desktop.evaluate(({ BrowserWindow }) => {
        const view = BrowserWindow.getAllWindows()[0]
          .contentView.children.find((v) =>
            v.webContents?.getURL().startsWith("mgpreview://"),
          );
        const bounds = view?.getBounds();
        return !!view && view.getVisible() && bounds.width > 0 && bounds.height > 0;
      }),
      true,
      "Preview guest must be shown over the file panel",
    );
    await page.locator("#closePreview").click();
    await page.locator('[data-nav="skills"]').click();
    assert.equal(await page.locator("#skillsPane").isVisible(), true);
    await page
      .locator("#skillList button")
      .filter({ hasText: "galaxy-fixture" })
      .click();
    assert.match(
      await page.locator("#skill option:checked").textContent(),
      /galaxy-fixture/,
    );
    const skillId = await page.evaluate(
      async () =>
        (await window.workbench.skills()).find(
          (s) => s.name === "galaxy-fixture",
        ).path,
    );
    assert.equal(await page.locator("#skill").inputValue(), skillId);
    await page.locator('[data-nav="browser"]').click();
    assert.equal(await page.locator("#browserPane").isVisible(), true);
    await page.locator('[data-nav="computer"]').click();
    assert.equal(await page.locator("#terminalCommand").isVisible(), true);
    const command = "Get-Location | Select-Object -ExpandProperty Path";
    await page.locator("#terminalCommand").fill(command);
    await page.locator("#terminalRun").click();
    await page.waitForFunction(
      () => document.getElementById("approvalDialog").open,
      {},
      { timeout: 5000 },
    );
    assert.ok(
      (await page.locator("#approvalArgs").textContent()).includes(command),
    );
    assert.match(
      await page.locator("#taskState").textContent(),
      /Menunggu izin/,
    );
    await page.locator("#allow").click();
    await page.waitForFunction(
      () =>
        document
          .getElementById("terminalOutput")
          .textContent.startsWith("Exit 0"),
      {},
      { timeout: 8000 },
    );
    assert.ok(
      (await page.locator("#terminalOutput").textContent()).includes(workspace),
    );
    assert.notEqual(await page.locator("#taskState").textContent(), "Berjalan");
    await page.locator('[data-nav="memory"]').click();
    assert.equal(await page.locator("#memoryPane").isVisible(), true);
    const note =
      'Keep the orange Galaxy identity. <svg onload="window.__memoryXSS=true"></svg>';
    await page.locator("#memoryNote").fill(note);
    await page.locator("#memorySave").click();
    await page.waitForFunction(
      () =>
        document
          .getElementById("notesStatus")
          .textContent.includes("Catatan tersimpan"),
      {},
      { timeout: 5000 },
    );
    assert.equal(await page.locator(".memory-note p").textContent(), note);
    assert.equal(await page.evaluate(() => window.__memoryXSS), undefined);
    assert.equal(await page.locator(".memory-note svg").count(), 0);
    await page.locator("#memoryQuery").fill("orange");
    await page.locator("#memorySearchForm button").click();
    await page.locator("#memoryConnection").click();
    assert.equal(
      await page.locator("#settingsDialog").evaluate((e) => e.open),
      true,
    );
    await page.locator("#closeSettings").click();
    await page.locator('[data-nav="home"]').click();
    await page.keyboard.press("Control+n");
    assert.equal(
      await page
        .locator("#prompt")
        .evaluate((e) => e === document.activeElement),
      true,
    );
    await page.locator("#langBtn").click();
    assert.equal(
      await page.locator('[data-nav="files"]').getAttribute("aria-label"),
      "Files",
    );
    await page.locator('[data-nav="memory"]').click();
    await page.locator("#memoryConnection").click();
    assert.equal(
      await page.locator("#settingsDialog").evaluate((e) => e.open),
      true,
      "English settings remain functional",
    );
    assert.equal(
      await page.locator("#lightRoute").count(),
      1,
      "Translation must retain form controls",
    );
    assert.equal(await page.locator("#codingRoute").count(), 1);
    await page.locator("#closeSettings").click();
    await page.locator("#langBtn").click();
    await page.locator('[data-nav="files"]').focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector('[data-nav="browser"]').getAttribute("aria-current") === "page");
    assert.equal(
      await page.locator('[data-nav="browser"]').getAttribute("aria-current"),
      "page",
    );
    await page.locator('[data-nav="home"]').click();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.waitForFunction(
      () => document.getElementById("toast").hidden,
      {},
      { timeout: 6500 },
    );
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [800, 600],
    ]) {
      // Exercise CSS below the production minimum without changing production settings.
      await desktop.evaluate(
        ({ BrowserWindow }, size) => {
          const w = BrowserWindow.getAllWindows()[0];
          w.setMinimumSize(0, 0);
          w.setContentSize(...size);
        },
        [width, height],
      );
      await page.waitForFunction(
        (size) => innerWidth === size[0] && innerHeight === size[1],
        [width, height],
      );
      const layout = await page.evaluate(() => {
        const send = document.getElementById("send").getBoundingClientRect();
        return {
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          sendVisible:
            send.top >= 0 &&
            send.bottom <= innerHeight &&
            send.right <= innerWidth,
          canvas: document.querySelectorAll("canvas").length,
          logoVisible:
            document.querySelector(".brand-logo").getBoundingClientRect().top >=
            0,
          runningAnimations: document
            .getAnimations()
            .filter((a) => a.playState === "running").length,
        };
      });
      assert.ok(
        layout.scrollWidth <= layout.width,
        "No page-wide horizontal overflow",
      );
      assert.equal(
        layout.sendVisible,
        true,
        "Primary action stays visible at " + width,
      );
      assert.equal(
        layout.canvas,
        0,
        "Navigation must not require a GPU canvas",
      );
      assert.equal(
        layout.logoVisible,
        true,
        "Brand stays visible without scrolling the whole sidebar",
      );
      assert.equal(
        layout.runningAnimations,
        0,
        "Reduced motion must stop decorative animation",
      );
      if (width === 1440)
        await page.screenshot({
          path: path.join(
            root,
            "evidence/galaxy-concept/galaxy-ui-desktop.png",
          ),
        });
      if (width === 800)
        await page.screenshot({
          path: path.join(
            root,
            "evidence/galaxy-concept/galaxy-ui-compact.png",
          ),
        });
    }
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 900),
    );
    const second = path.join(data, "second-workspace");
    await fs.mkdir(second);
    await desktop.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, second);
    await page.locator("#pickFolder").click();
    await page.waitForFunction(
      (folder) =>
        document.getElementById("workspacePath").textContent === folder,
      second,
      { timeout: 5000 },
    );
    await page.locator('[data-nav="memory"]').click();
    await page.waitForFunction(
      () => document.querySelector("#memoryList .empty"),
      {},
      { timeout: 5000 },
    );
    assert.ok(
      !(await page.locator("#memoryList").textContent()).includes(
        "orange Galaxy",
      ),
      "Memory must not cross workspaces",
    );
    assert.deepEqual(errors, []);
  },
);
