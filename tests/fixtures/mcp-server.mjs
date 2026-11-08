import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
const server = new Server(
  { name: "workbench-test-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Fixture echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
    },
    { name: "forbidden", inputSchema: { type: "object" } },
  ],
}));
server.setRequestHandler(CallToolRequestSchema, async (r) => ({
  content: [
    {
      type: "text",
      text: JSON.stringify({
        received: r.params.arguments,
        privateVariable: process.env.WORKBENCH_SECRET_FIXTURE ?? null,
      }),
    },
  ],
}));
await server.connect(new StdioServerTransport());
