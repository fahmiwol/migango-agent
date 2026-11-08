import fs from "node:fs/promises";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "..");
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const model = arg("--model") || "claude-sonnet-5-5";
if (!["claude-sonnet-5-5", "claude-opus-5-5"].includes(model))
  throw Error("Allowed Claude model required");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const args = [root, "--self-workspace"];
if (arg("--credential-file"))
  args.push("--import-anthropic-key-file", arg("--credential-file"));
const desktop = await _electron.launch({
  executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
  args,
  env,
  timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.waitForFunction(
    () => document.getElementById("workspacePath")?.textContent.length > 0,
  );
  const configuration = await page.evaluate(async (model) => {
    const s = await window.workbench.settings();
    const next = await window.workbench.saveSettings({
      ...s,
      active: "anthropic",
      autoRouting: false,
      memoryEnabled: false,
      profiles: { ...s.profiles, anthropic: { model } },
    });
    return { configured: next.configured.anthropic, encrypted: next.encrypted };
  }, model);
  if (!configuration.configured)
    throw Error("Encrypted Anthropic credential is not configured");
  await page.reload();
  await page.waitForFunction(
    () => document.getElementById("workspacePath")?.textContent.length > 0,
  );
  const named = await page.evaluate(
    (model) =>
      [...document.querySelectorAll("#taskModel option")].find((o) =>
        o.textContent.includes(model === "claude-opus-5-5" ? "Opus" : "Sonnet"),
      )?.value,
    model,
  );
  if (named) await page.locator("#taskModel").selectOption(named);
  const prompt = arg("--prompt-file")
    ? await fs.readFile(arg("--prompt-file"), "utf8")
    : "Balas tepat KONEKSI_OK. Ini uji koneksi; jangan menggunakan alat.";
  if (await page.locator("#settingsDialog").evaluate((e) => e.open))
    await page.locator("#closeSettings").click();
  const decisions = [];
  if (process.argv.includes("--approve-owned-edits"))
    await page.evaluate(() =>
      window.workbench.onEvent(async (e) => {
        if (e.type === "approval") {
          const p = e.args?.path;
          const owned =
            typeof p === "string" &&
            /^(src|ui|tests)\/[a-zA-Z0-9_./-]+$/.test(p) &&
            !p.includes("..");
          await window.workbench.approve(e.id, e.tool === "edit_file" && owned);
        }
      }),
    );
  await page.locator('[data-mode="' + (arg("--mode") || "ask") + '"]').click();
  await page.locator("#prompt").fill(prompt);
  await page.locator("#send").click();
  await page.waitForFunction(
    () =>
      document.getElementById("stop").hidden &&
      document.querySelector(
        "#messages .message.error, #messages .message.assistant",
      ),
    {},
    { timeout: 120000 },
  );
  const history = await page.evaluate(() => window.workbench.history());
  const run = await page.evaluate(
    (id) => window.workbench.loadRun(id),
    history[0].id,
  );
  const output =
    arg("--output") ||
    path.join(root, "evidence/live-desktop-" + model + ".json");
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(
    output,
    JSON.stringify(
      {
        kind: "real-desktop-real-anthropic",
        model,
        credentialConfigured: configuration.configured,
        encrypted: configuration.encrypted,
        status: run.status,
        validation: run.validation,
        artifactReceipts: run.artifactReceipts,
        final: run.final,
        error: run.error,
        usage: run.usage,
        events: run.events,
        runId: run.id,
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: output.replace(/\.json$/, ".png") });
  console.log(
    JSON.stringify({
      status: run.status,
      validation: run.validation,
      model,
      text: run.final,
      error: run.error,
      usage: run.usage,
      output,
    }),
  );
  if (!["responded", "needs-validation", "done"].includes(run.status))
    process.exitCode = 1;
} finally {
  await desktop.close();
}
