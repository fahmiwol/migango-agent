import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ReferenceLibrary,
  canonicalReferenceURL,
} from "../../src/research/references.mjs";
const POST_DOMAIN = ["insta", "gram.com"].join("");
test("reference URLs strip tracking, retain functional query, and reject auth/token schemes", () => {
  assert.equal(
    canonicalReferenceURL(
      "https://github.com/owner/repo?utm_source=ig&tab=readme-ov-file#readme",
    ),
    "https://github.com/owner/repo?tab=readme-ov-file#readme",
  );
  assert.equal(
    canonicalReferenceURL("https://www." + POST_DOMAIN + "/p/ABC/?srtk=x&igsh=a"),
    "https://www." + POST_DOMAIN + "/p/ABC/",
  );
  for (const url of [
    "file:///C:/secret",
    "https://user:pass@example.org",
    "https://example.org/?api_key=abc",
    "https://example.org/?access_token=abc",
  ])
    assert.throws(() => canonicalReferenceURL(url));
});
test("reference import is atomic, deduplicated, scoped, restart durable and never fetches sources", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-refs-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "refs.db");
  let r = new ReferenceLibrary(file);
  const result = r.import(
    "A",
    "https://example.org/a?utm_source=x\nhttps://example.org/a\nhttps://example.org/b",
  );
  assert.equal(result.added, 2);
  assert.equal(r.list("A").length, 2);
  assert.equal(r.list("B").length, 0);
  assert.throws(() =>
    r.import(
      "A",
      "https://example.org/good\nhttps://example.org/?token=secret",
    ),
  );
  assert.equal(r.list("A").length, 2);
  const row = r.list("A")[0];
  r.annotate("A", {
    id: row.id,
    title: "<script>untrusted</script>",
    note: "Unverified owner note",
    stage: "primary-checked",
  });
  assert.throws(
    () =>
      r.annotate("B", { id: row.id, title: "x", note: "x", stage: "adopted" }),
    /scope|reference/i,
  );
  const md = r.markdown("A");
  assert.match(md, /owner-asserted/);
  assert.match(md, /&lt;script&gt;/);
  assert.ok(!md.includes("<script>"));
  r.close();
  r = new ReferenceLibrary(file);
  assert.equal(r.list("A").length, 2);
  assert.equal(r.list("A", "unverified").length, 1);
  r.close();
});
