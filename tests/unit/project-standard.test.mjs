import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Markas (25 Oct 2026): "Proyek baru" in miganGO lays out the Tiranyx Project Standard (SPT v1)
// from templates kept in this repository (no reference to the owner's machine), per profile
// dasar|web|ai, plus PRD/ARD/ERD/owner log/living log; existing files are never overwritten.
const standard = await import("../../src/core/project-standard.mjs").catch(() => ({}));
const { scaffoldProjectStandard, PROFILES } = standard;
const { createProject } = await import("../../src/desktop/project-files.mjs");

const TYPED = ["docs/01-riset", "docs/02-arsitektur", "docs/03-cluster", "docs/04-prd", "docs/05-epic", "docs/06-fungsi", "docs/07-keputusan", ".agents/skills"];
const JENIS = ["north-star", "riset", "arsitektur", "cluster", "prd", "epic", "story", "fungsi", "skill", "keputusan"];
const STATUS = ["draft", "aktif", "selesai", "ditunda", "batal"];

async function tmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), "migango-spt-"));
}
async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}
async function walk(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  return Object.fromEntries(
    m[1].split("\n").map((l) => {
      const at = l.indexOf(":");
      const v = l.slice(at + 1).trim();
      return [l.slice(0, at).trim(), v.startsWith("[") ? v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : v];
    }),
  );
}

test("a dasar project gets the full SPT layout from repository templates", async () => {
  const root = await tmp();
  try {
    const log = await scaffoldProjectStandard({ root, name: "Kasir UMKM", profile: "dasar", today: "2026-10-25" });
    for (const f of [
      "AGENTS.md", "CLAUDE.md", "README.md", "CHANGELOG.md", ".gitignore",
      "docs/00-NORTH-STAR.md", "docs/02-arsitektur/ARSITEKTUR.md", "docs/02-arsitektur/ERD.md",
      "docs/03-cluster/CLUSTER-inti.md", "docs/04-prd/PRD-001-kebutuhan-awal.md",
      "docs/08-ops/RUNBOOK.md", "docs/08-ops/ERRORS.md",
      "docs/09-log/HANDOFF.md", "docs/09-log/LIVING_LOG.md", "docs/09-log/OWNER-LOG.md",
      ".githooks/pre-commit", ".githooks/cek-rahasia.mjs", "docs/INDEX.md", "docs/registri.json",
    ])
      assert.ok(await exists(path.join(root, f)), `${f} created`);
    for (const d of [...TYPED, "src", "tests/unit", "tests/integration", "scripts", "config"])
      assert.ok(await exists(path.join(root, d)), `${d}/ created`);
    const agents = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.ok(agents.split("\n").length < 150, "AGENTS.md stays under 150 lines");
    assert.match(agents, /Kasir UMKM/);
    assert.ok((await fs.readFile(path.join(root, "CLAUDE.md"), "utf8")).startsWith("@AGENTS.md"));
    assert.ok(log.some((l) => l.startsWith("buat AGENTS.md")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("every typed document passes the SPT checks (frontmatter, jenis, status, ids, links)", async () => {
  const root = await tmp();
  try {
    await scaffoldProjectStandard({ root, name: "Kasir", profile: "ai" });
    const files = [path.join(root, "docs/00-NORTH-STAR.md")];
    for (const d of TYPED) files.push(...(await walk(path.join(root, d))).filter((f) => f.endsWith(".md")));
    const ids = new Set();
    const docs = [];
    for (const f of files) {
      const meta = frontmatter((await fs.readFile(f, "utf8")).replace(/\r\n/g, "\n"));
      assert.ok(meta?.id, `${path.relative(root, f)} has frontmatter id`);
      for (const k of ["id", "jenis", "judul", "status", "cluster", "terkait", "dibuat", "diubah"])
        assert.ok(k in meta, `${path.relative(root, f)} has ${k}`);
      assert.ok(JENIS.includes(meta.jenis), `jenis ${meta.jenis}`);
      assert.ok(STATUS.includes(meta.status), `status ${meta.status}`);
      assert.ok(!ids.has(meta.id), `unique id ${meta.id}`);
      ids.add(meta.id);
      docs.push(meta);
    }
    for (const d of docs) for (const t of d.terkait) assert.ok(ids.has(t), `${d.id} links to existing ${t}`);
    const registri = JSON.parse(await fs.readFile(path.join(root, "docs/registri.json"), "utf8"));
    assert.equal(registri.dokumen.length, docs.length, "registry lists every typed document");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("existing files are never overwritten and the log says what was kept", async () => {
  const root = await tmp();
  try {
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Aturan lama saya\n");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs/00-NORTH-STAR.md"), "milik pemilik\n");
    const log = await scaffoldProjectStandard({ root, name: "Lama", profile: "dasar" });
    assert.equal(await fs.readFile(path.join(root, "AGENTS.md"), "utf8"), "# Aturan lama saya\n");
    assert.equal(await fs.readFile(path.join(root, "docs/00-NORTH-STAR.md"), "utf8"), "milik pemilik\n");
    assert.ok(log.includes("lewati (sudah ada) AGENTS.md"));
    assert.ok(await exists(path.join(root, "docs/09-log/HANDOFF.md")), "missing pieces are still added");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("profiles add their own folders and files", async () => {
  assert.deepEqual(PROFILES, ["dasar", "web", "ai"]);
  const web = await tmp(),
    ai = await tmp();
  try {
    await scaffoldProjectStandard({ root: web, name: "Toko", profile: "web" });
    assert.ok(await exists(path.join(web, "docs/08-ops/DEPLOY.md")));
    assert.ok(await exists(path.join(web, "src/app")));
    await scaffoldProjectStandard({ root: ai, name: "Asisten", profile: "ai" });
    assert.ok(await exists(path.join(ai, "config/models.example.json")));
    assert.ok(await exists(path.join(ai, "evals/README.md")));
    await assert.rejects(scaffoldProjectStandard({ root: ai, name: "X", profile: "lain" }), /profil/);
  } finally {
    await fs.rm(web, { recursive: true, force: true });
    await fs.rm(ai, { recursive: true, force: true });
  }
});

test("generated files carry no personal path, owner or company name, or private service", async () => {
  const banned = [
    // A drive letter not preceded by a letter, so "http://" is not mistaken for "p:/".
    /(?<![A-Za-z])[A-Z]:[\\/]/i, /\\\\[A-Za-z]/, /\/Users\//, /\/home\//, /acme-corp/i, /Jane Doe/i, /PrivateBrain/i, /work-live/i,
    /MiganExp/i, /mighan/i, /markas/i, /[\w.-]+@[\w-]+\.[a-z]{2,}/i,
  ];
  for (const profile of PROFILES) {
    const root = await tmp();
    try {
      await scaffoldProjectStandard({ root, name: "Netral", profile });
      for (const f of await walk(root)) {
        const text = await fs.readFile(f, "utf8");
        for (const b of banned) assert.doesNotMatch(text, b, `${profile}: ${path.relative(root, f)} contains ${b}`);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

async function snapshot(root) {
  const out = {};
  for (const f of await walk(root)) out[path.relative(root, f)] = await fs.readFile(f, "utf8");
  return out;
}

test("a second run keeps every file byte-for-byte, including the derived index", async () => {
  const root = await tmp();
  try {
    const first = await scaffoldProjectStandard({ root, name: "Dua Kali", profile: "web", today: "2026-10-25" });
    await fs.writeFile(path.join(root, "docs/INDEX.md"), "indeks milik pemilik\n");
    const before = await snapshot(root);
    const log = await scaffoldProjectStandard({ root, name: "Dua Kali", profile: "web", today: "2026-11-01" });
    // Directories that got a .gitkeep are no longer empty, so the second run has no entry for them.
    const expected = first
      .filter((l) => !l.endsWith("/.gitkeep") && !l.startsWith("peringatan "))
      .map((l) => l.replace(/^buat /, "lewati (sudah ada) "));
    assert.deepEqual(log, expected, "every entry kept");
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the owner log, living log and handoff are dated and name the profile", async () => {
  const root = await tmp();
  try {
    await scaffoldProjectStandard({ root, name: "Bertanggal", profile: "ai", today: "2026-10-25" });
    for (const f of ["docs/09-log/OWNER-LOG.md", "docs/09-log/LIVING_LOG.md"]) {
      const text = await fs.readFile(path.join(root, f), "utf8");
      assert.match(text, /2026-10-25/, f);
      assert.match(text, /profil ai/, f);
    }
    assert.match(await fs.readFile(path.join(root, "docs/09-log/OWNER-LOG.md"), "utf8"), /\| Tanggal \| Topik \|/);
    assert.match(await fs.readFile(path.join(root, "docs/09-log/HANDOFF.md"), "utf8"), /Diperbarui: 2026-10-25/);
    await assert.rejects(scaffoldProjectStandard({ root, name: "x", today: "2026-99-99" }), /tanggal/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a junction inside the project stops the scaffold before anything is written", async () => {
  const root = await tmp(),
    outside = await tmp();
  try {
    await fs.symlink(outside, path.join(root, "tests"), "junction");
    await assert.rejects(scaffoldProjectStandard({ root, name: "Tautan", profile: "dasar" }), /tautan/i);
    assert.deepEqual(await fs.readdir(outside), [], "nothing created outside the project");
    assert.deepEqual(await fs.readdir(root), ["tests"], "nothing created inside either");
  } finally {
    await fs.rm(path.join(root, "tests"), { force: true }).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("a dangling file symlink at a template path is refused, not followed", async (t) => {
  const root = await tmp(),
    outside = await tmp();
  try {
    try {
      await fs.symlink(path.join(outside, "pwned.txt"), path.join(root, "README.md"), "file");
    } catch (error) {
      if (error.code === "EPERM") return t.skip("file symlinks need Developer Mode on Windows");
      throw error;
    }
    await assert.rejects(scaffoldProjectStandard({ root, name: "Tautan", profile: "dasar" }), /tautan/i);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("folder names with YAML and table characters keep frontmatter and the index valid", async () => {
  const root = await tmp();
  try {
    await scaffoldProjectStandard({ root, name: "#Kasir 2 [Beta]: {x} | 'y'", profile: "dasar" });
    const meta = frontmatter((await fs.readFile(path.join(root, "docs/00-NORTH-STAR.md"), "utf8")).replace(/\r\n/g, "\n"));
    assert.match(meta.judul, /Kasir 2/);
    assert.doesNotMatch(meta.judul, /[#[\]{}|'`]/);
    const rows = (await fs.readFile(path.join(root, "docs/INDEX.md"), "utf8")).split("\n").filter((l) => l.startsWith("| "));
    for (const row of rows) assert.equal(row.replace(/\\\|/g, "").split("|").length, 8, row);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the secret hook is executable where file modes exist", { skip: process.platform === "win32" }, async () => {
  const root = await tmp();
  try {
    await scaffoldProjectStandard({ root, name: "Hook", profile: "dasar" });
    assert.ok((await fs.stat(path.join(root, ".githooks/pre-commit"))).mode & 0o111);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Markas, 25 Oct 2026 (P3 from PRD-016): Windows has no executable bit, so a hook committed from
// Windows is skipped on POSIX clones. The scaffold warns instead of staging into the owner's index.
test("on Windows the scaffold warns how to keep the hook executable, without touching git", async () => {
  const root = await tmp();
  try {
    const log = await scaffoldProjectStandard({ root, name: "Hook", profile: "dasar", platform: "win32" });
    const warning = log.find((l) => l.startsWith("peringatan "));
    assert.match(warning || "", /git update-index --add --chmod=\+x \.githooks\/pre-commit/);
    assert.equal(await exists(path.join(root, ".git")), false, "no git command was run");
    const posix = await tmp();
    try {
      const quiet = await scaffoldProjectStandard({ root: posix, name: "Hook", profile: "dasar", platform: "linux" });
      assert.equal(quiet.some((l) => l.startsWith("peringatan ")), false);
    } finally {
      await fs.rm(posix, { recursive: true, force: true });
    }
    const again = await scaffoldProjectStandard({ root, name: "Hook", profile: "dasar", platform: "win32" });
    assert.equal(again.some((l) => l.startsWith("peringatan ")), false, "kept hook, no repeat warning");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the plan lists exactly what a run creates", async () => {
  const root = await tmp();
  try {
    await fs.writeFile(path.join(root, "README.md"), "punya saya\n");
    const plan = await standard.planProjectStandard({ root, profile: "web" });
    assert.ok(plan.keep.includes("README.md"));
    const log = await scaffoldProjectStandard({ root, name: "Rencana", profile: "web" });
    assert.deepEqual(plan.create, log.filter((l) => l.startsWith("buat ")).map((l) => l.slice(5)));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a fresh scaffold still counts as a new build target; foreign files do not", async () => {
  const { checkBuildTarget } = await import("../../src/agents/build-target.mjs");
  const projects = await tmp(),
    active = await tmp();
  try {
    const { root } = await createProject({ projectsRoot: projects, name: "Bangun", profile: "ai" });
    const target = { root, kind: "new", activeRoot: active };
    assert.equal((await checkBuildTarget({ target, workspaceRoot: root })).kind, "new");
    await fs.writeFile(path.join(root, "src", "kode-lama.js"), "x");
    await assert.rejects(checkBuildTarget({ target, workspaceRoot: root }), /kosong|empty/);
  } finally {
    await fs.rm(projects, { recursive: true, force: true });
    await fs.rm(active, { recursive: true, force: true });
  }
});

test("a scaffold failure removes the half-made project folder", async () => {
  const projects = await tmp();
  try {
    const scaffold = async () => {
      throw Object.assign(new Error("disk penuh"), { code: "ENOSPC" });
    };
    await assert.rejects(createProject({ projectsRoot: projects, name: "Gagal", scaffold }), /disk penuh/);
    assert.deepEqual(await fs.readdir(projects), []);
  } finally {
    await fs.rm(projects, { recursive: true, force: true });
  }
});

// The generated secret hook runs inside the new project's own git repository.
test("the generated secret hook blocks staged secrets, renames and non-ASCII names", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const root = await tmp();
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=uji", "-c", "user.email=uji@contoh.test", "-c", "core.autocrlf=false", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  let stderr = "";
  const hook = () => {
    const r = spawnSync(process.execPath, [".githooks/cek-rahasia.mjs"], { cwd: root, encoding: "utf8" });
    stderr = r.stderr;
    return r.status;
  };
  // Built at runtime so this test file never holds a key-shaped literal.
  const fakeKey = ["sk", "x".repeat(24)].join("-");
  try {
    await scaffoldProjectStandard({ root, name: "Hook", profile: "dasar" });
    git("init", "-q");
    git("add", "-A");
    assert.equal(hook(), 0, "clean scaffold passes");
    git("commit", "-q", "-m", "awal");

    await fs.writeFile(path.join(root, "biasa.txt"), `kunci ${fakeKey}\n`);
    git("add", "biasa.txt");
    assert.equal(hook(), 1, "plain staged secret is blocked");
    git("reset", "-q");
    await fs.rm(path.join(root, "biasa.txt"));

    await fs.writeFile(path.join(root, "lama.txt"), "baris satu\nbaris dua\nbaris tiga\nbaris empat\n");
    git("add", "lama.txt");
    git("commit", "-q", "-m", "lama");
    git("mv", "lama.txt", "baru.txt");
    await fs.appendFile(path.join(root, "baru.txt"), `${fakeKey}\n`);
    git("add", "baru.txt");
    assert.equal(hook(), 1, "secret in a renamed file is blocked");
    git("reset", "-q", "--hard");

    await fs.writeFile(path.join(root, "rahasia-é.txt"), `${fakeKey}\n`);
    git("add", "rahasia-é.txt");
    assert.equal(hook(), 1, "secret in a non-ASCII file name is blocked");
    assert.match(stderr, /RAHASIA\? rahasia-é\.txt:1/, "blocked for the secret, not for an unreadable name");
    git("reset", "-q");
    await fs.rm(path.join(root, "rahasia-é.txt"));
    await fs.writeFile(path.join(root, "catatan-é.txt"), "bersih\n");
    git("add", "catatan-é.txt");
    assert.equal(hook(), 0, "a clean non-ASCII file name passes");
    git("reset", "-q");
    await fs.rm(path.join(root, "catatan-é.txt"));

    await fs.writeFile(path.join(root, "stage.txt"), `${fakeKey}\n`);
    git("add", "stage.txt");
    await fs.writeFile(path.join(root, "stage.txt"), "sudah bersih di working tree\n");
    assert.equal(hook(), 1, "staged content is scanned, not the working tree");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("frontmatter titles are always quoted strings", async () => {
  const root = await tmp();
  try {
    await scaffoldProjectStandard({ root, name: "2026\u0085null", profile: "dasar" });
    const text = (await fs.readFile(path.join(root, "docs/00-NORTH-STAR.md"), "utf8")).replace(/\r\n/g, "\n");
    const line = text.split("\n").find((l) => l.startsWith("judul: "));
    assert.match(line, /^judul: "[^"\n\u0085]*"$/);
    assert.doesNotMatch(text.split("---")[1], /\u0085/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the opening context no longer points users to a tool on the owner's machine", async () => {
  const prelude = await fs.readFile(new URL("../../src/agents/prelude.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(prelude, /buat\.mjs/);
});

test("Proyek baru creates the folder with the chosen profile; a bad profile writes nothing", async () => {
  const projects = await tmp();
  try {
    const { root } = await createProject({ projectsRoot: projects, name: "Kalkulator", profile: "web" });
    assert.ok(await exists(path.join(root, "AGENTS.md")));
    assert.ok(await exists(path.join(root, "docs/08-ops/DEPLOY.md")));
    await assert.rejects(createProject({ projectsRoot: projects, name: "Salah", profile: "lain" }), /profil/);
    assert.deepEqual(await fs.readdir(projects), ["Kalkulator"], "nothing created for the bad profile");
    const plain = await createProject({ projectsRoot: projects, name: "Biasa" });
    assert.ok(await exists(path.join(plain.root, "src")), "default profile is dasar");
  } finally {
    await fs.rm(projects, { recursive: true, force: true });
  }
});

test("the owner can apply the standard to the current project through the main-window IPC", async () => {
  const main = await fs.readFile(new URL("../../src/desktop/main.mjs", import.meta.url), "utf8");
  const block = main.match(/case "projectStandardInit": \{[\s\S]*?\n {12}\}\n/)?.[0] || "";
  for (const guard of [
    /runtime\.active \|\| activeTask \|\| manualController/,
    /recovery\.assertSafe\(/,
    /manualController = new AbortController\(\)/,
    /approvals\.request\(\s*"projectStandardInit"/,
    /planProjectStandard\(/,
    /scaffoldProjectStandard\(/,
    /manualController = undefined/,
  ])
    assert.match(block, guard);
  assert.ok(block.indexOf("approvals.request(") < block.indexOf("scaffoldProjectStandard("), "approval comes first");
  const preload = await fs.readFile(new URL("../../src/desktop/preload.cjs", import.meta.url), "utf8");
  assert.match(preload, /projectStandardInit:/);
});
