import fs from "node:fs/promises";
import path from "node:path";
import { _electron } from "playwright-core";
const root = path.resolve(import.meta.dirname, "..");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const desktop = await _electron.launch({
  executablePath: path.join(root, "node_modules/electron/dist/electron.exe"),
  args: [root],
  env,
  timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.waitForFunction(
    () => document.getElementById("workspacePath")?.textContent.length > 0,
  );
  const settings = await page.evaluate(() => window.workbench.settings());
  if (path.resolve(settings.workspace) !== root)
    throw Error("Owner workspace changed; do not override silently");
  const events = [];
  page.on("console", () => {});
  await page.evaluate(() => {
    window.__improvementEvents = [];
    window.workbench.onEvent(async (e) => {
      if (e.type === "improvement-model") window.__improvementEvents.push(e);
      if (
        e.type === "approval" &&
        [
          "improvementRepair",
          "improvementActivate",
          "improvementTest",
          "improvementExecute",
        ].includes(e.tool)
      )
        await window.workbench.approve(e.id, true);
    });
  });
  const resume = process.argv.includes("--resume");
  const candidate = resume
    ? (await page.evaluate(() => window.workbench.improvementList())).find(
        (c) => c.goal.startsWith("Fix real miganGO context budget"),
      )
    : await page.evaluate(() =>
        window.workbench.improvementCreate({
          goal: "Fix real miganGO context budget: UTF-8 bytes, not UTF-16 JS characters. Preserve function identity and rejection semantics. All three oracle tests must pass; no test changes.",
          files: ["src/core/router.mjs", "tests/unit/context-bytes.test.mjs"],
          editable: ["src/core/router.mjs"],
          tests: ["tests/unit/context-bytes.test.mjs"],
        }),
      );
  if (!candidate) throw Error("No prior candidate to inspect");
  let result = resume
    ? candidate
    : await page.evaluate(
        (id) => window.workbench.improvementRepair(id),
        candidate.id,
      );
  let active, retest;
  if (result.status === "validated") {
    active = await page.evaluate(
      (c) =>
        window.workbench.improvementActivate(
          c.id,
          c.candidateHash,
          c.verdict.id,
        ),
      result,
    );
    retest = await page.evaluate(
      (id) => window.workbench.improvementTest(id),
      result.id,
    );
  } else if (result.status === "active") {
    active = result;
    retest = await page.evaluate(
      (id) => window.workbench.improvementTest(id),
      result.id,
    );
  }
  let invocation;
  if(retest?.status==='PASS'){
    invocation=await page.evaluate(async c=>{
      const ascii=await window.workbench.improvementExecute(c.id,c.candidateHash,{module:'src/core/router.mjs',exportName:'fitContext',args:[[{role:'user',content:'hello'}],100]});
      let unicodeBlocked=false;try{await window.workbench.improvementExecute(c.id,c.candidateHash,{module:'src/core/router.mjs',exportName:'fitContext',args:[[{role:'user',content:'界'.repeat(40)}],100]});}catch(error){unicodeBlocked=/budget/.test(error.message);}
      return {asciiResult:ascii.result,unicodeBlocked};
    },result);
    result=(await page.evaluate(()=>window.workbench.improvementList())).find(c=>c.id===result.id);
  }
  const output = {
    kind: "real-desktop-real-opus-isolated-repair",
    at: new Date().toISOString(),
    result,
    active,
    retest,
    invocation,
    sourceAppliedByHostReview:true,
    makerUsageNote:'Initial real Opus maker completed once; first screenshot step failed before usage evidence write. Resume makes no inference call. Initial maker usage is unknown.',
    events: await page.evaluate(() => window.__improvementEvents),
  };
  await fs.writeFile(
    path.join(root, "evidence/opus-isolated-repair.json"),
    JSON.stringify(output, null, 2),
  );
  await page.locator('[data-tab="recovery"]').click();
  await page.screenshot({
    path: path.join(root, "evidence/opus-isolated-repair.png"),
  });
  console.log(
    JSON.stringify({
      status: result.status,
      base: result.baseVerdict?.status,
      verdict: result.verdict?.status,
      error: result.error,
      attempts: result.attempts,
      active: active?.status,
      retest: retest?.status,
      candidateId: result.id,
      directory: result.directory,
      usage: output.events,
    }),
  );
  if (
    !["validated", "active"].includes(result.status) ||
    retest?.status !== "PASS"
  )
    process.exitCode = 1;
} finally {
  await desktop.close();
}
