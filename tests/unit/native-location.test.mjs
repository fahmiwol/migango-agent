import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import {
  nativeDirectory,
  projectRoot,
} from "../../src/recovery/native-layout.mjs";

test("native artifacts belong to per-checkout local application data; package setup builds them", async () => {
  const dir = nativeDirectory();
  assert.ok(path.isAbsolute(dir));
  const rel = path.relative(projectRoot, dir);
  assert.ok(
    rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel),
    "Generated artifacts must be outside repository",
  );
  assert.notEqual(
    dir,
    nativeDirectory(path.join(projectRoot, "different-checkout")),
  );
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  assert.match(pkg.scripts.postinstall, /setup\.mjs/);
  const setup = await fs.readFile("scripts/setup.mjs", "utf8");
  assert.match(setup, /scripts\/build-native\.mjs/);
  assert.match(setup, /node_modules\/electron\/install\.js/);
  assert.match(setup, /electron\.version !== pkg\.devDependencies\.electron/);
  assert.match(pkg.scripts["build-native"], /build-native\.mjs/);
});
