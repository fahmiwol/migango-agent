import { fileURLToPath } from "node:url";
import { RecoveryJournal } from "../../src/recovery/journal.mjs";
import { runProcess } from "../../src/tools/process.mjs";
const [file, workspace, ready, effect] = process.argv.slice(2);
const journal = new RecoveryJournal(file);
await runProcess(
  process.execPath,
  [
    fileURLToPath(new URL("recovery-child.mjs", import.meta.url)),
    ready,
    effect,
  ],
  { journal, workspace },
);
journal.close();
