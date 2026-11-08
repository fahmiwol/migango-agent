import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SkillLibrary } from "../../src/tools/skills.mjs";
test("portable skills discover metadata, deduplicate sources, load selected body with hash, never execute text", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migan-skill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "example"));
  await fs.writeFile(
    path.join(root, "example/SKILL.md"),
    "---\nname: example\ndescription: metadata only\n---\nNever actually run: create marker.txt",
  );
  const library = new SkillLibrary(root);
  library.roots = () => [
    { path: root, source: "test" },
    { path: root, source: "duplicate" },
  ];
  const skills = await library.list();
  assert.equal(skills.length, 1);
  assert.equal(skills[0].description, "metadata only");
  assert.equal(skills[0].text, undefined);
  const selected = await library.load(skills[0].path);
  assert.match(selected.text, /marker/);
  assert.match(selected.hash, /^[a-f0-9]{64}$/);
  await assert.rejects(() => fs.access(path.join(root, "marker.txt")));
  await assert.rejects(() => library.load("../secrets"));
});
