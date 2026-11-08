import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const [identityFile, effectFile] = process.argv.slice(2);
const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
  stdio: "ignore",
  windowsHide: true,
});
writeFileSync(
  identityFile,
  JSON.stringify({ server: process.pid, grandchild: grandchild.pid }),
);
appendFileSync(effectFile, "started\n");
setInterval(() => {}, 1000);
const server = new Server(
  { name: "custody-fixture", version: "1" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: "echo", inputSchema: { type: "object" } }],
}));
await server.connect(new StdioServerTransport());
