// Adapters reuse existing host storage/MCP. No new memory database or hidden credential path.
import { createHash, randomUUID } from "node:crypto";
const textOf = (result) =>
  (result?.content || result?.result?.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n") || JSON.stringify(result);
export function contextBrain(context, workspace) {
  const seen = new Map();
  return {
    async cari(query) {
      const rows = context.search(workspace, query);
      return rows.map((r) => {
        const v = {
          id: r.id,
          isi: String(r.content).slice(0, 6000),
          sumber: r.source || "internal:" + r.id,
        };
        seen.set(r.id, v);
        return v;
      });
    },
    async ambil(id) {
      return seen.get(id);
    },
    async pelajari(record) {
      return context.add({
        workspace,
        kind: "session-summary",
        content:
          record.isi + "\nEvidence refs: " + JSON.stringify(record.refs || {}),
        source: record.sumber,
        trust: "derived",
      }).id;
    },
  };
}
export function externalBrain({
  tools,
  signal,
  authority,
  actor,
  event,
  workspace,
}) {
  const seen = new Map();
  async function call(tool, args, requestSignal = signal) {
    if (!authority.allows("mcp_call"))
      throw Error("Memory tool unavailable in this mode");
    const c = {
      id: randomUUID(),
      name: "mcp_call",
      args: { server: "brain", tool, arguments: args },
    };
    await event({ type: "tool-start", id: c.id, name: c.name, args: c.args });
    requestSignal.throwIfAborted();
    const result = await tools.execute(c, requestSignal, { authority, actor });
    requestSignal.throwIfAborted();
    await event({
      type: "tool-result",
      id: c.id,
      name: c.name,
      adapterTool: tool,
      result: JSON.stringify(result).slice(0, 7000),
    });
    return result;
  }
  return {
    async cari(query, { signal: requestSignal } = {}) {
      const result = await call(
        "brain_context",
        {
          task: query,
          project: workspace.split(/[\\/]/).at(-1),
          budget_tokens: 1200,
        },
        requestSignal || signal,
      );
      const text = textOf(result),
        id =
          "brain-" +
          createHash("sha256").update(text).digest("hex").slice(0, 24);
      const r = { id, isi: text.slice(0, 6000), sumber: "brain:brain_context" };
      seen.clear();
      seen.set(id, r);
      return [r];
    },
    async ambil(id) {
      return seen.get(id);
    },
    async pelajari(record, { signal: requestSignal } = {}) {
      const result = await call(
        "brain_learn",
        {
          kind: "lesson",
          project: workspace.split(/[\\/]/).at(-1),
          title: "Pelajaran agen: " + record.sumber.slice(0, 90),
          body: record.isi,
          source: record.sumber,
        },
        requestSignal || signal,
      );
      const id = result?.id || textOf(result).match(/\bL[a-f0-9]{10}\b/)?.[0];
      if (!id)
        throw Error("Memory write not acknowledged; inspect before any retry");
      return id;
    },
  };
}
