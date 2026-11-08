import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readAnthropicCredential, readKimiCredential } from "../../src/core/credential-import.mjs";

test("Kimi import accepts one complete token, refuses ambiguity, Anthropic keys and oversized files", async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'kimi-key-fixture-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const file=path.join(root,'fixture.md'),fake='sk-'+'fixture'.repeat(5);
 await fs.writeFile(file,fake+'\n');assert.equal(await readKimiCredential(file),fake);
 for(const invalid of [fake+'\n'+fake,'text '+fake,'sk-ant-'+'a'.repeat(30),'no key']) {
   await fs.writeFile(file,invalid);await assert.rejects(readKimiCredential(file),/exactly one/);
 }
 await fs.writeFile(file,'x'.repeat(4097));await assert.rejects(readKimiCredential(file),/small/);
});
test("private import accepts exactly one distinct bounded key without returning document contents", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-key-fixture-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "fixture.md"),
    fake = "sk-ant-" + "fake".repeat(8);
  await fs.writeFile(file, "unrelated private text\n" + fake + "\n" + fake);
  assert.equal(await readAnthropicCredential(file), fake);
  await fs.writeFile(file, fake + "\nsk-ant-" + "other".repeat(8));
  await assert.rejects(() => readAnthropicCredential(file), /exactly one/);
  await fs.writeFile(file, "x".repeat(128 * 1024 + 1));
  await assert.rejects(() => readAnthropicCredential(file), /small/);
  await fs.writeFile(file, "no key");
  await assert.rejects(() => readAnthropicCredential(file), /exactly one/);
});
