import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../../ui/galaxy.css", import.meta.url), "utf8");
const html = await readFile(new URL("../../ui/index.html", import.meta.url), "utf8");

// Ambil isi blok @media dengan menghitung kurung kurawal.
function mediaBlock(query) {
  const start = css.indexOf("@media (" + query + ")");
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  return "";
}
function rule(block, selector) {
  const at = block.indexOf(selector + " {");
  if (at < 0) return "";
  return block.slice(at, block.indexOf("}", at));
}
const px = (text, prop) => {
  const m = new RegExp(prop + ":\\s*(\\d+)px").exec(text);
  return m ? Number(m[1]) : NaN;
};

test("sidebar memuat sembilan menu utama, Pemulihan termasuk", () => {
  const from = html.indexOf('class="galaxy-nav"');
  const nav = html.slice(from, html.indexOf("</nav>", from));
  assert.equal((nav.match(/data-nav="/g) || []).length, 9);
  assert.match(nav, /data-nav="recovery"/);
});

test("layar pendek (816 px): menu dirapatkan agar tanpa gulir", () => {
  const block = mediaBlock("max-height: 860px");
  assert.ok(block, "harus ada @media (max-height: 860px)");
  const button = rule(block, ".galaxy-nav button");
  const nav = rule(block, ".galaxy-nav");
  const minH = px(button, "min-height");
  const gap = px(nav, "gap");
  assert.ok(minH <= 32, "tinggi tombol menu maksimal 32 px, dapat " + minH);
  assert.ok(gap <= 2, "jarak antar menu maksimal 2 px, dapat " + gap);
  const navHeight = 9 * minH + 8 * gap;
  assert.ok(navHeight <= 300, "tinggi menu " + navHeight);
});

test("layar pendek: kartu memori sidebar disembunyikan, bukan menu", () => {
  const block = mediaBlock("max-height: 860px");
  assert.match(block, /\.sidebar \.memory[^{]*\{[^}]*display:\s*none/);
  assert.doesNotMatch(block, /\.galaxy-nav[^{]*\{[^}]*display:\s*none/);
});
