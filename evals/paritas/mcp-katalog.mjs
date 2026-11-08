// Fixture MCP server for the parity set's MCP tasks (ARS-011): one tool, cari_produk, over stdio
// with newline-delimited JSON-RPC 2.0. No dependencies, fixed fictitious data, read-only.
//   node evals/paritas/mcp-katalog.mjs
import readline from "node:readline";

const KATALOG = {
  "KX-77": { kode: "KX-77", nama: "Kopi Gayo 250 g", harga: 48500, stok: 12 },
  "LT-09": { kode: "LT-09", nama: "Teh Melati 25 kantong", harga: 23000, stok: 0 },
  "BR-31": { kode: "BR-31", nama: "Beras Pandan 5 kg", harga: 78000, stok: 40 },
};
const TOOL = {
  name: "cari_produk",
  description: "Cari produk di katalog toko menurut kode. Mengembalikan nama, harga (rupiah) dan stok.",
  inputSchema: { type: "object", properties: { kode: { type: "string", description: "Kode produk, misalnya KX-77" } }, required: ["kode"], additionalProperties: false },
};

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");

function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled) need no reply
  if (method === "initialize")
    return send({ id, result: { protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "katalog", version: "1.0.0" } } });
  if (method === "ping") return send({ id, result: {} });
  if (method === "tools/list") return send({ id, result: { tools: [TOOL] } });
  if (method === "tools/call") {
    if (params?.name !== "cari_produk") return send({ id, error: { code: -32602, message: "Alat tidak dikenal" } });
    const item = KATALOG[String(params?.arguments?.kode || "").toUpperCase()];
    return send({ id, result: { content: [{ type: "text", text: item ? JSON.stringify(item) : "Produk tidak ditemukan" }], isError: !item } });
  }
  send({ id, error: { code: -32601, message: "Metode tidak dikenal" } });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  try {
    handle(JSON.parse(line));
  } catch {
    send({ id: null, error: { code: -32700, message: "JSON tidak sah" } });
  }
});
