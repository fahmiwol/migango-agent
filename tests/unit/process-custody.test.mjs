import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess } from "../../src/tools/process.mjs";
import {
  inspectProcess,
  RecoveryJournal,
} from "../../src/recovery/journal.mjs";
test(
  "Windows custody without a journal closes descendants when fast parent exits during output overflow",
  { timeout: 20000 },
  async (t) => {
    const root = await fs.mkdtemp(
        path.join(os.tmpdir(), "migango-unlogged-custody-"),
      ),
      marker = path.join(root, "child.json");
    t.after(async () => {
      try {
        const { pid } = JSON.parse(await fs.readFile(marker, "utf8"));
        const identity = await inspectProcess(pid);
        if (identity.state === "present") {
          const j = new RecoveryJournal(path.join(root, "cleanup.db"));
          const intent = j.recordIntent({
            workspace: root,
            kind: "fixture",
            argsHash: "a".repeat(64),
          });
          j.bindProcess(intent.id, { ...identity, custody: "unmanaged" });
          await j.terminateOwned(intent.id);
          j.close();
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));process.stdout.write('x'.repeat(40000));process.exit(0);`;
    const error = await runProcess(process.execPath, ["-e", script], {
      cwd: root,
      journal: false,
      timeout: 5000,
    }).then(
      () => null,
      (e) => e,
    );
    const { pid } = JSON.parse(await fs.readFile(marker, "utf8")),
      state = (await inspectProcess(pid)).state;
    console.log(
      JSON.stringify({
        primaryError: error?.message,
        terminationUnconfirmed: error?.terminationUnconfirmed,
        grandchild: state,
      }),
    );
    assert.ok(error);
    assert.match(error.message, /output limit/);
    assert.notEqual(
      error.terminationUnconfirmed,
      true,
      "Job teardown must be confirmed without taskkill PID race",
    );
    assert.equal(
      state,
      "absent",
      "Grandchild may not survive a fast-exiting target",
    );
  },
);
