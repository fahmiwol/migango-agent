import fs from "node:fs/promises";
export async function readKimiCredential(file) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096) throw Error("Kimi source must be a small local token file");
    const source = (await handle.readFile("utf8")).trim();
    if (!/^sk-[A-Za-z0-9_-]{20,200}$/.test(source) || source.startsWith("sk-ant-"))
      throw Error("Kimi source must contain exactly one complete token and no other text");
    return source;
  } finally { await handle.close(); }
}
export async function readAnthropicCredential(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 128 * 1024)
    throw new Error("Credential source must be a small local text file");
  const source = await fs.readFile(file, "utf8");
  const keys = [
    ...new Set(source.match(/sk-ant-[A-Za-z0-9_-]{20,1000}/g) || []),
  ];
  if (keys.length !== 1)
    throw new Error(
      "Credential source must contain exactly one distinct Anthropic API key",
    );
  return keys[0];
}
