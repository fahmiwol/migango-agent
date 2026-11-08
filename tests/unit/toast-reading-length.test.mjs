import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const appURL = new URL("../../ui/app.js", import.meta.url);

function element() {
  return {
    children: [],
    textContent: "",
    replaceChildren() {
      this.children = [];
    },
    append(...children) {
      this.children.push(...children);
    },
  };
}

async function loadRefreshFiles(payload) {
  const app = await fs.readFile(appURL, "utf8");
  const start = app.indexOf("async function refreshFiles() {");
  const end = app.indexOf("async function refreshSkills() {", start);
  assert.ok(start >= 0 && end > start, "the real file-list renderer is tested");
  const fileList = element();
  const toasts = [];
  const render = new Function(
    "$",
    "api",
    "document",
    "language",
    "toast",
    "safe",
    `${app.slice(start, end)}; return refreshFiles;`,
  )(
    (id) => (id === "fileList" ? fileList : element()),
    { files: async () => payload },
    { createElement: () => element() },
    "id",
    (message) => toasts.push(message),
    (fn) => fn,
  );
  return { fileList, render, toasts };
}

test("daftar array kosong tidak memunculkan galat reading length", async () => {
  const { fileList, render, toasts } = await loadRefreshFiles([]);
  await assert.doesNotReject(render);
  assert.equal(fileList.children.length, 1);
  assert.match(fileList.children[0].textContent, /Folder masih kosong/);
  assert.deepEqual(toasts, []);
});

test("bentuk IPC objek kosong tetap didukung", async () => {
  const { fileList, render } = await loadRefreshFiles({ files: [], truncated: false });
  await render();
  assert.equal(fileList.children.length, 1);
  assert.match(fileList.children[0].textContent, /Folder masih kosong/);
});

test("payload rusak ditolak eksplisit, bukan dianggap kosong", async () => {
  const { render } = await loadRefreshFiles({});
  await assert.rejects(render, /Daftar berkas tidak valid/);
});
