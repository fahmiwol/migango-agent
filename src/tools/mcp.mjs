import { CustodyStdioTransport } from "../recovery/mcp-transport.mjs";
export class MCP {
  constructor(store, { recovery } = {}) {
    this.store = store;
    this.recovery = recovery;
    this.clients = new Map();
    this.connecting = new Map();
    this.stopping = new Set();
    this.shutdownErrors = [];
    this.closed = false;
  }
  config(id) {
    const config = this.store.settings.mcp.find((s) => s.id === id);
    if (!config) throw new Error("MCP server is not registered");
    return config;
  }
  describe(id) {
    const c = this.config(id);
    return structuredClone({
      command: c.command,
      args: c.args,
      cwd: this.store.settings.workspace,
      allowTools: c.allowTools,
      startsProcess: !this.clients.has(id) && !this.connecting.has(id),
    });
  }
  connect(id, signal) {
    signal?.throwIfAborted();
    if (this.closed) throw Error("MCP connector is closed");
    if (this.unsafe)
      throw Error("MCP termination unconfirmed; recovery inspection required");
    if (this.clients.has(id)) {
      const entry = this.clients.get(id);
      entry.attach(signal);
      return Promise.resolve(entry);
    }
    if (this.connecting.has(id)) {
      const pending = this.connecting.get(id);
      pending.attach(signal);
      return pending.promise;
    }
    const config = structuredClone(this.config(id));
    const transport = new CustodyStdioTransport({
      command: config.command,
      args: config.args,
      cwd: this.store.settings.workspace,
      recovery: this.recovery,
    });
    const signals = new Set();
    let closing;
    const entry = {
      transport,
      signal,
      attach: (current) => {
        if (current && !signals.has(current)) {
          signals.add(current);
          current.addEventListener("abort", close, { once: true });
          if (current.aborted) void close();
        }
      },
      close: () => close(),
    };
    const close = () => {
      if (closing) return closing;
      for (const current of signals)
        current.removeEventListener("abort", close);
      closing = transport
        .close()
        .catch((error) => {
          this.unsafe = true;
          this.shutdownErrors.push(error);
        })
        .finally(() => {
          if (this.clients.get(id) === entry) this.clients.delete(id);
          if (this.connecting.get(id) === entry) this.connecting.delete(id);
          this.stopping.delete(closing);
        });
      this.stopping.add(closing);
      return closing;
    };
    entry.attach(signal);
    this.connecting.set(id, entry);
    entry.promise = (async () => {
      const { Client } =
        await import("@modelcontextprotocol/sdk/client/index.js");
      const client = new Client({ name: "migan-workbench", version: "0.1.0" });
      entry.client = client;
      try {
        await client.connect(transport, { signal, timeout: 15000 });
        signal?.throwIfAborted();
        if (this.closed || closing || transport.closed)
          throw Error("MCP session stopped");
        // The SDK installs its own onclose; chain after connection for generation-bound cache eviction.
        const prior = transport.onclose;
        transport.onclose = () => {
          prior?.();
          if (this.clients.get(id) === entry) this.clients.delete(id);
          for (const current of signals)
            current.removeEventListener("abort", close);
        };
        this.clients.set(id, entry);
        return entry;
      } catch {
        await close();
        throw Error("MCP connection failed or timed out; no automatic retry");
      } finally {
        if (this.connecting.get(id) === entry) this.connecting.delete(id);
      }
    })();
    return entry.promise;
  }
  async list(id, signal) {
    const { client } = await this.connect(id, signal);
    const data = await client.listTools(undefined, { signal, timeout: 15000 });
    const allow = this.config(id).allowTools;
    return data.tools
      .filter((t) => allow.includes(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description?.slice(0, 1000),
        inputSchema: t.inputSchema,
      }));
  }
  async call(id, name, args, signal) {
    if (!this.config(id).allowTools.includes(name))
      throw Error("MCP tool is not allowlisted");
    const { client } = await this.connect(id, signal);
    try {
      return await client.callTool({ name, arguments: args }, undefined, {
        signal,
        timeout: 60000,
      });
    } catch {
      throw Error(
        "MCP call failed/interrupted. Inspect external state before retrying.",
      );
    }
  }
  async close() {
    if (this.closingAll) return this.closingAll;
    this.closed = true;
    this.closingAll = this.drain();
    try {
      await this.closingAll;
      if (!this.unsafe) this.closed = false;
    } finally {
      this.closingAll = undefined;
    }
  }
  async drain() {
    const entries = new Set([
      ...this.clients.values(),
      ...this.connecting.values(),
    ]);
    await Promise.all([...entries].map((entry) => entry.close()));
    await Promise.all([...this.stopping]);
    await Promise.allSettled(
      [...entries].map((entry) => entry.promise).filter(Boolean),
    );
    if (this.shutdownErrors.length) {
      this.shutdownErrors = [];
      const error = Error(
        "MCP process teardown was not confirmed; inspect registered server processes before restarting.",
      );
      error.terminationUnconfirmed = true;
      throw error;
    }
  }
}
