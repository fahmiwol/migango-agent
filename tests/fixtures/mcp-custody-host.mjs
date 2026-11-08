import { writeFileSync } from "node:fs";
import path from "node:path";
import { MCP } from "../../src/tools/mcp.mjs";
import { RecoveryJournal } from "../../src/recovery/journal.mjs";
const [root, workspace] = process.argv.slice(2);
const recovery = new RecoveryJournal(path.join(root, "recovery.db"));
const settings = {
  workspace,
  mcp: [
    {
      id: "fixture",
      command: process.execPath,
      args: [
        path.resolve(import.meta.dirname, "mcp-custody-server.mjs"),
        path.join(root, "identities.json"),
        path.join(root, "effect.txt"),
      ],
      allowTools: ["echo"],
    },
  ],
};
const mcp = new MCP({ settings }, { recovery });
await Promise.all([
  mcp.list("fixture", new AbortController().signal),
  mcp.list("fixture", new AbortController().signal),
]);
writeFileSync(
  path.join(root, "idle.json"),
  JSON.stringify({ clients: mcp.clients.size }),
);
setInterval(() => {}, 1000);
