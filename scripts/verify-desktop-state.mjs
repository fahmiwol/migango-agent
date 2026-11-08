import fs from "node:fs/promises";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await _electron.launch({
  executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
  args: [root, "--open-last-run"],
  env,
  timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => document.querySelector('#workspacePath')?.textContent.length>0);
  const metadata = await page.evaluate(async () => {
    const settings = await window.workbench.settings();
    const catalog = await window.workbench.researchCatalog();
    const imported = await window.workbench.researchImport(catalog.join("\n"));
    const history = await window.workbench.history();
    const latest = await window.workbench.loadRun(history[0].id);
    return {
      configured: settings.configured.anthropic,
      encrypted: settings.encrypted,
      active: settings.profiles.anthropic.model,
      workspace: settings.workspace,
      latestModel: latest.profile.model,
      latestStatus: latest.status,
      acceptance: latest.validation,
      imported,
      referenceCount: (await window.workbench.researchList("")).length,
    };
  });
  if (
    !metadata.configured ||
    !metadata.encrypted ||
    metadata.latestModel !== "claude-opus-5-5"
  )
    throw Error("Expected encrypted credential and latest actual Opus run");
  await page.locator('[data-tab="research"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".reference-card").length > 0,
  );
  await page.screenshot({
    path: path.join(root, "evidence/miganGO-current.png"),
  });
  await fs.writeFile(
    path.join(root, "evidence/desktop-state.json"),
    JSON.stringify(
      {
        kind: "actual-userdata-no-model-call",
        at: new Date().toISOString(),
        ...metadata,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(metadata));
} finally {
  await desktop.close();
}
