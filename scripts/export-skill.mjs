import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const name = "digital-god-power-inteligence";
const generated=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Jakarta'});
const source = path.join(root, ".agents/skills", name, "SKILL.md");
const text = await fs.readFile(source, "utf8");
const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
if (!front) throw Error("Missing frontmatter");
const description = front[1].match(/^description:\s*(.+)$/m)[1];
const output = path.join(root, "exports/skills", name);
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  path.join(output, "SKILL.md"),
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  source: miganGO SKILL-digital-god-power-inteligence\n  generated: '${generated}'\n---\n` +
    text.slice(front[0].length),
);
console.log(output);
