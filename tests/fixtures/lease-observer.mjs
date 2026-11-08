import fs from "node:fs/promises";
import path from "node:path";
// Observe committed records only. A peer may finish cleanup between enumeration and open.
export async function committedLeases(root) {
  const rows = [];
  for (const f of await fs.readdir(root).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    if (!/^miganGO-sandbox-[a-f0-9]{32}\.json$/.test(f)) continue;
    const filename = path.join(root, f);
    let text;
    try {
      text = await fs.readFile(filename, "utf8");
    } catch (e) {
      if (e.code === "ENOENT") continue;
      throw e;
    }
    rows.push({ filename, record: JSON.parse(text) });
  }
  return rows;
}
