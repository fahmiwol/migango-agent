// Project standard scaffold (SPT v1) for "Proyek baru" and for applying the standard to the open
// project. Mirrors the reference `init --profil dasar|web|ai` layout, but every template lives in
// this repository so the distribution build never reads the owner's machine (D-055).
// Non-destructive: files are created with the exclusive "wx" flag, so an existing file is kept.
import fs from "node:fs/promises";
import path from "node:path";

export const PROFILES = ["dasar", "web", "ai"];
const VERSION = "1";
const JENIS = ["north-star", "riset", "arsitektur", "cluster", "prd", "epic", "story", "fungsi", "skill", "keputusan"];
const STATUS = ["draft", "aktif", "selesai", "ditunda", "batal"];
const TYPED_DIRS = [
  "docs/01-riset",
  "docs/02-arsitektur",
  "docs/03-cluster",
  "docs/04-prd",
  "docs/05-epic",
  "docs/06-fungsi",
  "docs/07-keputusan",
  ".agents/skills",
];
const PROFILE_DIRS = {
  dasar: ["src", "tests/unit", "tests/integration", "scripts", "config"],
  web: ["src/app", "src/api", "src/ui", "src/lib", "public", "tests/unit", "tests/integration", "scripts", "config"],
  ai: [
    "src/core",
    "src/rag",
    "src/agents",
    "src/tools",
    "src/memory",
    "src/eval",
    "prompts",
    "evals",
    "tests/unit",
    "tests/integration",
    "scripts",
    "config",
  ],
};

function fm(o) {
  // Titles come from folder names; a JSON-quoted string stays a string for every YAML parser.
  const lines = Object.entries(o).map(
    ([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(", ")}]` : k === "judul" ? JSON.stringify(v) : v}`,
  );
  return `---\n${lines.join("\n")}\n---\n`;
}

const BODY = {
  "north-star": (j) => `# North Star — ${j}

> LOCK: ubah hanya lewat dokumen keputusan di \`docs/07-keputusan\`.

## Visi (2–3 tahun)
## Masalah yang diselesaikan
## Sasaran & metrik (angka, kapan)
## Non-goal (sengaja tidak dikerjakan)
## Batasan (dana, waktu, infra, lisensi)
## Pengguna utama
`,
  arsitektur: (j) => `# ${j}

## Tujuan komponen
## Lapisan (model · memori & pengetahuan · orkestrasi & tools · governance & observability)
## Antarmuka (input/output, protokol: HTTP/MCP/A2A)
## Data & penyimpanan (rinci di ERD)
## Kegagalan & pemulihan
## Diagram
\`\`\`mermaid
flowchart LR
  A[Klien] --> B[Komponen]
\`\`\`
`,
  erd: (j) => `# ${j}

Satu tabel = satu entitas. Tulis kolom kunci, relasi, dan siapa yang boleh menulis.

\`\`\`mermaid
erDiagram
  PENGGUNA ||--o{ PESANAN : membuat
  PENGGUNA {
    string id
    string nama
  }
  PESANAN {
    string id
    string pengguna_id
  }
\`\`\`

## Entitas
## Relasi
## Aturan data (wajib, unik, dihapus atau diarsipkan)
## Migrasi
`,
  cluster: (j) => `# Cluster — ${j}

## Ruang lingkup (domain / kelompok fungsi)
## Di luar cluster ini
## Pemilik
> Daftar PRD, epic, dan fungsi anggota cluster ini muncul di \`docs/INDEX.md\`.
`,
  prd: (j) => `# ${j}

## Masalah
## Pengguna & skenario
## Sasaran & metrik keberhasilan
## Ruang lingkup / di luar lingkup
## Kebutuhan fungsional
## Kebutuhan non-fungsional (keamanan, performa, biaya)
## Kriteria terima
## Risiko & asumsi
## Pertanyaan terbuka (keputusan pemilik)
`,
};

const CHECK_SECRETS = `// Scans staged content for secret-looking strings. Prints file:line only, never the value.
// NUL-separated names keep non-ASCII paths intact; renames are included; the staged blob is read,
// not the working tree. A staged file that cannot be read blocks the commit.
import { execFileSync } from 'node:child_process';
const PK = '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----';
const POLA = [/sk-[A-Za-z0-9_-]{20,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /github_pat_[A-Za-z0-9_]{30,}/, /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/, /AIza[0-9A-Za-z_-]{35}/, /\\b\\d{8,10}:[A-Za-z0-9_-]{35}\\b/,
  /eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}/, new RegExp(PK)];
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const files = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).split('\\0').filter(Boolean);
let bad = 0;
for (const f of files) {
  let t; try { t = git(['show', ':' + f]); } catch { console.error('TIDAK TERBACA ' + f); bad++; continue; }
  // Binary files (PDF/PNG streams) produce random pattern hits; secrets live in text.
  if (t.includes('\\u0000')) continue;
  t.split('\\n').forEach((line, i) => { if (POLA.some((p) => p.test(line))) { console.error('RAHASIA? ' + f + ':' + (i + 1)); bad++; } });
}
if (bad) { console.error(bad + ' baris mencurigakan. Pindahkan rahasia ke secrets/env, lalu commit lagi.'); process.exit(1); }
`;

const AGENTS = (nama, profil) => `# AGENTS.md — ${nama}

Satu berkas aturan untuk semua agen (miganGO, Claude, Codex, Cursor, Copilot, Gemini, Ollama).
Struktur mengikuti Standar Proyek v1 (SPT, profil \`${profil}\`). Jaga berkas ini < 150 baris.

## Mulai sesi
1. Baca \`docs/09-log/HANDOFF.md\` → \`docs/00-NORTH-STAR.md\` → \`docs/INDEX.md\` → dokumen yang relevan saja.
2. Keputusan pemilik terbaru ada di \`docs/09-log/OWNER-LOG.md\` dan \`docs/07-keputusan\`; itu mengalahkan catatan lama.

## Peta
- \`docs/00-NORTH-STAR.md\` arah (LOCK) · \`docs/INDEX.md\` peta per cluster
- \`docs/01-riset\` … \`docs/07-keputusan\`: satu dokumen per riset/arsitektur/cluster/PRD/epic/fungsi/keputusan
- \`docs/02-arsitektur/ARSITEKTUR.md\` (ARD) · \`docs/02-arsitektur/ERD.md\` (data) · \`docs/04-prd\` (PRD)
- \`.agents/skills/<nama>/SKILL.md\` prosedur yang bisa diulang
- \`docs/08-ops\` runbook & error · \`docs/09-log\` handoff, living log, owner log

## Dokumen
- Tiap dokumen bertipe punya frontmatter: id, jenis, judul, status, cluster, terkait, dibuat, diubah.
- Id baru = nomor berikutnya di foldernya (PRD-002, ARS-002, D-001). Jangan pakai id ganda.
- Sesudah menambah dokumen, perbarui \`docs/INDEX.md\` dan \`docs/registri.json\`.
- Test: (isi perintah test proyek)

## Aturan
- Satu hal, satu berkas. Cari yang sudah ada sebelum membuat baru; jangan buat berkas kedua untuk hal yang sama.
- Alur: North Star → riset → arsitektur → cluster → PRD → epic/story → fungsi/skill → eksekusi.
- Required loop: catat → uji → iterasi → review → push → deploy → verifikasi live → catat.
- Tandai ADA/TIDAK ADA, NYATA/STUB, "belum diuji". Commit ≠ live.
- Rahasia tidak pernah di repo, dokumen, atau chat. Hook: \`git config core.hooksPath .githooks\`; dari Windows: \`git update-index --chmod=+x .githooks/pre-commit\`.
- Akhir sesi: perbarui HANDOFF.md, LIVING_LOG.md, dan CHANGELOG.md (tulis WHY).
- Bahasa: komunikasi Indonesia, komentar kode Inggris.
`;

const ROOT = (nama, profil, tgl, judul = plainTitle(nama)) => ({
  "AGENTS.md": AGENTS(nama, profil),
  "CLAUDE.md": "@AGENTS.md\n\n<!-- Catatan khusus Claude Code saja. Aturan umum tetap di AGENTS.md. -->\n",
  "README.md": `# ${nama}\n\nApa ini, untuk siapa, cara menjalankan. Arah: [North Star](docs/00-NORTH-STAR.md) · Peta: [INDEX](docs/INDEX.md).\n`,
  "CHANGELOG.md": `# Changelog — ${nama}\n\nFormat: semver, tiap entri menulis WHY.\n\n## 0.1.0 - ${tgl}\n- Proyek dibuat dengan Standar Proyek v1 (SPT, profil ${profil}).\n`,
  ".gitignore": "node_modules/\n.env\n.env.*\n!.env.example\n*.secret*\nsecrets.json\n*.pem\n*.key\n.DS_Store\n",
  "docs/00-NORTH-STAR.md":
    fm({ id: "NORTH-STAR", jenis: "north-star", judul, status: "draft", cluster: "inti", terkait: [], dibuat: tgl, diubah: tgl }) +
    "\n" +
    BODY["north-star"](nama),
  "docs/02-arsitektur/ARSITEKTUR.md":
    fm({
      id: "ARS-000",
      jenis: "arsitektur",
      judul: `Arsitektur ${judul} (gambaran besar)`,
      status: "draft",
      cluster: "inti",
      terkait: ["NORTH-STAR"],
      dibuat: tgl,
      diubah: tgl,
    }) +
    "\n" +
    BODY.arsitektur(`Arsitektur ${nama} — gambaran besar (ARD)`),
  "docs/02-arsitektur/ERD.md":
    fm({
      id: "ARS-001",
      jenis: "arsitektur",
      judul: `Model data ${judul} (ERD)`,
      status: "draft",
      cluster: "inti",
      terkait: ["ARS-000"],
      dibuat: tgl,
      diubah: tgl,
    }) +
    "\n" +
    BODY.erd(`Model data ${nama} (ERD)`),
  "docs/03-cluster/CLUSTER-inti.md":
    fm({ id: "CLUSTER-inti", jenis: "cluster", judul: "Inti", status: "aktif", cluster: "inti", terkait: [], dibuat: tgl, diubah: tgl }) +
    "\n" +
    BODY.cluster("Inti"),
  "docs/04-prd/PRD-001-kebutuhan-awal.md":
    fm({
      id: "PRD-001",
      jenis: "prd",
      judul: "Kebutuhan awal",
      status: "draft",
      cluster: "inti",
      terkait: ["NORTH-STAR", "ARS-000"],
      dibuat: tgl,
      diubah: tgl,
    }) +
    "\n" +
    BODY.prd("Kebutuhan awal"),
  "docs/08-ops/RUNBOOK.md": `# Runbook — ${nama}\n\n## Lingkungan\n## Deploy\n## Verifikasi live\n## Rollback\n## Kontak & akses (sebut lokasi rahasia, bukan isinya)\n`,
  "docs/08-ops/ERRORS.md": `# Error log — ${nama}\n\n| Tanggal | Gejala | Penyebab | Perbaikan | Pencegahan |\n|---|---|---|---|---|\n`,
  "docs/09-log/LIVING_LOG.md": `# Living log — ${nama}\n\nCatatan berjalan: apa yang dikerjakan, dicoba, gagal, dan dipelajari. Terbaru di bawah.\n\n- ${tgl}: proyek dibuat (SPT v${VERSION}, profil ${profil}).\n`,
  "docs/09-log/OWNER-LOG.md": `# Owner log — ${nama}\n\nPermintaan dan keputusan pemilik, dengan tanggal. Entri baru mengalahkan entri lama pada topik yang sama; entri lama tidak dihapus.\n\n| Tanggal | Topik | Permintaan / keputusan | Status |\n|---|---|---|---|\n| ${tgl} | proyek | Proyek dibuat dengan profil ${profil}. | selesai |\n`,
  "docs/09-log/HANDOFF.md": `# Handoff — ${nama}\n\nDiperbarui: ${tgl}\n\n## Status terakhir\n## Selesai\n## Terbuka / keputusan yang menunggu pemilik\n## Langkah berikut\n## Prompt siap-tempel untuk sesi berikutnya\n`,
  ".githooks/pre-commit": "#!/bin/sh\n# Block commits that contain secrets. Enable: git config core.hooksPath .githooks\nnode .githooks/cek-rahasia.mjs || exit 1\n",
  ".githooks/cek-rahasia.mjs": CHECK_SECRETS,
});

const PROFILE_FILES = (nama, tgl) => ({
  web: {
    "docs/08-ops/DEPLOY.md": `# Deploy — ${nama}\n\n## Target (host, domain)\n## Build\n## Rilis & verifikasi live\n## Rollback\n`,
  },
  ai: {
    "config/models.example.json":
      JSON.stringify(
        {
          default: "lokal",
          models: {
            lokal: { provider: "ollama", model: "isi-nama-model", url: "http://127.0.0.1:11434" },
            cloud: { provider: "isi", model: "isi", key_env: "NAMA_ENV_KUNCI" },
          },
        },
        null,
        2,
      ) + "\n",
    "src/core/README.md":
      "# core/\n\nLapisan abstraksi model: satu interface dasar + model factory, supaya ganti penyedia (Claude/GPT/Ollama) tidak menulis ulang kode.\n",
    "src/rag/README.md":
      "# rag/\n\nEmpat modul terpisah: embedder, retriever, store, indexer. Default agentic: cek relevansi & kelengkapan, tulis ulang query bila perlu.\n",
    "evals/README.md": `# evals/\n\nSet uji tetap (golden) + held-out. Catat angka baseline di CHANGELOG sebelum mengubah retrieval/prompt. Dibuat ${tgl}.\n`,
  },
});

// Folder names can carry control characters on POSIX; keep templates and YAML lines intact.
// Markdown keeps the readable name; frontmatter and index cells drop YAML/table syntax characters.
function cleanName(name) {
  const text = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!text) throw new Error("Nama proyek wajib diisi");
  return text;
}
function plainTitle(name) {
  const text = name
    .replace(/[#[\]{}|"'`]/g, " ")
    .replace(/^[\s&*!>%@,?:-]+/, "")
    .replace(/:(\s|$)/g, " -$1")
    .replace(/\s+/g, " ")
    .trim();
  return text || "Proyek";
}

export function validateProfile(profile = "dasar") {
  if (!PROFILES.includes(profile)) throw new Error(`profil harus salah satu: ${PROFILES.join(", ")}`);
  return profile;
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function validDate(today) {
  if (today === undefined) return localToday();
  const parsed = new Date(`${today}T00:00:00Z`);
  const ok =
    /^\d{4}-\d{2}-\d{2}$/.test(String(today)) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(today);
  if (!ok) throw new Error("tanggal harus YYYY-MM-DD yang sah");
  return today;
}

const inside = (root, p) => {
  const r = path.relative(root, p);
  return r === "" || (!r.startsWith("..") && !path.isAbsolute(r));
};

class LinkError extends Error {
  constructor(rel) {
    super(`Ada tautan (symlink/junction) di ${rel}; standar proyek tidak diterapkan agar tidak menulis ke luar proyek`);
    this.code = "ERR_PROJECT_STANDARD_LINK";
  }
}

// Walks one path segment at a time with lstat and never follows a link (D-002 pattern).
// Returns "missing", "file" or "dir" for the full path.
async function inspect(realRoot, rel) {
  let current = realRoot;
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    let s;
    try {
      s = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return "missing";
      throw error;
    }
    const here = parts.slice(0, i + 1).join("/");
    if (s.isSymbolicLink()) throw new LinkError(here);
    if (i < parts.length - 1 && !s.isDirectory()) throw new Error(`Bukan folder: ${here}`);
    if (i === parts.length - 1) return s.isDirectory() ? "dir" : "file";
  }
  return "dir";
}

// Creates each missing segment without `recursive`, so a link planted between checks is refused.
async function makeDir(realRoot, relDir) {
  let current = realRoot;
  const parts = relDir === "." ? [] : relDir.split("/");
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const s = await fs.lstat(current);
    if (s.isSymbolicLink()) throw new LinkError(parts.slice(0, i + 1).join("/"));
    if (!s.isDirectory()) throw new Error(`Bukan folder: ${parts.slice(0, i + 1).join("/")}`);
  }
  return current;
}

async function writeNew(realRoot, relPath, content, log, mode) {
  const dir = await makeDir(realRoot, path.posix.dirname(relPath));
  const state = await inspect(realRoot, relPath);
  if (state !== "missing") {
    log.push(`lewati (sudah ada) ${relPath}`);
    return false;
  }
  try {
    const file = path.join(dir, path.posix.basename(relPath));
    await fs.writeFile(file, content, { flag: "wx", ...(mode ? { mode } : {}) });
    // A folder swapped for a link between the check and the write is caught here; the stray file goes.
    if (!inside(realRoot, await fs.realpath(dir))) {
      await fs.rm(file, { force: true }).catch(() => {});
      throw new LinkError(path.posix.dirname(relPath));
    }
    log.push(`buat ${relPath}`);
    return true;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    log.push(`lewati (sudah ada) ${relPath}`);
    return false;
  }
}

function parseFM(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const o = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, "").trim();
    if (/^\[.*\]$/.test(v))
      v = v
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    else v = v.replace(/^["']|["']$/g, "");
    o[kv[1]] = v;
  }
  return o;
}

// Bounded so a large existing project cannot stall the main process; links are never followed.
const SCAN_LIMIT = { files: 2000, depth: 6, bytes: 256 * 1024 };
// `budget` is shared by every folder of one scan and counts each entry visited.
async function walkMarkdown(dir, budget, out = [], depth = 0) {
  if (depth > SCAN_LIMIT.depth || budget.left <= 0) return out;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (--budget.left < 0) break;
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walkMarkdown(p, budget, out, depth + 1);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// Same rules as the reference index: only canonical files are typed documents.
async function scanDocuments(root) {
  const rel = (p) => path.relative(root, p).split(path.sep).join("/");
  const files = [path.join(root, "docs", "00-NORTH-STAR.md")];
  const typed = (d, f) => {
    const b = path.basename(f);
    if (d === ".agents/skills") return b === "SKILL.md";
    if (d === "docs/01-riset") return b === "README.md";
    if (d === "docs/05-epic") return b === "README.md" || /^STORY-\d+/.test(b);
    return true;
  };
  const budget = { left: SCAN_LIMIT.files };
  for (const d of TYPED_DIRS) files.push(...(await walkMarkdown(path.join(root, d), budget)).filter((f) => typed(d, f)));
  const docs = [];
  for (const f of files) {
    let meta;
    try {
      const s = await fs.lstat(f);
      if (!s.isFile() || s.size > SCAN_LIMIT.bytes) continue;
      meta = parseFM(await fs.readFile(f, "utf8"));
    } catch {
      continue;
    }
    if (!meta?.id) continue;
    const terkait = Array.isArray(meta.terkait) ? meta.terkait : meta.terkait ? [meta.terkait] : [];
    docs.push({ ...meta, terkait, path: rel(f) });
  }
  docs.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  return docs;
}

function renderIndex(docs) {
  const back = new Map();
  for (const d of docs) for (const t of d.terkait) (back.get(t) || back.set(t, []).get(t)).push(d.id);
  const byCluster = new Map();
  for (const d of docs) {
    const c = d.cluster || "(tanpa cluster)";
    (byCluster.get(c) || byCluster.set(c, []).get(c)).push(d);
  }
  const count = STATUS.map((s) => `${s} ${docs.filter((d) => d.status === s).length}`).join(" · ");
  // Owner documents may carry `|` or brackets in their titles; keep table cells and links intact.
  const cell = (v) => String(v ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "\\|");
  const label = (v) => cell(v).replace(/[[\]]/g, (c) => "\\" + c);
  let md = `# INDEX\n\n> Peta dokumen proyek. ${docs.length} dokumen: ${count}.\n`;
  for (const [c, list] of [...byCluster].sort((a, b) => a[0].localeCompare(b[0]))) {
    md += `\n## ${c}\n\n| ID | Jenis | Judul | Status | Terkait | Dirujuk oleh |\n|---|---|---|---|---|---|\n`;
    list.sort(
      (a, b) => JENIS.indexOf(a.jenis) - JENIS.indexOf(b.jenis) || a.id.localeCompare(b.id, "en", { numeric: true }),
    );
    for (const d of list) {
      const link = path.posix.relative("docs", d.path);
      md += `| ${cell(d.id)} | ${cell(d.jenis)} | [${label(d.judul)}](${encodeURI(link)}) | ${cell(d.status)} | ${cell(d.terkait.join(", "))} | ${cell((back.get(d.id) || []).join(", "))} |\n`;
    }
  }
  return md;
}

const INDEX_FILES = ["docs/registri.json", "docs/INDEX.md"];
const templateFiles = (profile) => [
  ...Object.keys(ROOT("x", profile, "2000-01-01")),
  ...Object.keys(PROFILE_FILES("x", "2000-01-01")[profile] || {}),
];
const profileDirs = (profile) => [...TYPED_DIRS, ...PROFILE_DIRS[profile]];

async function realProjectRoot(root) {
  const realRoot = await fs.realpath(root);
  if (!(await fs.stat(realRoot)).isDirectory()) throw new Error("Akar proyek harus folder");
  return realRoot;
}

/**
 * Lists what a run would create and keep, in run order, without writing anything.
 * Throws before any write when a link (symlink/junction) sits on a template path.
 */
export async function planProjectStandard({ root, profile = "dasar" } = {}) {
  validateProfile(profile);
  const realRoot = await realProjectRoot(root);
  const create = [],
    keep = [];
  const add = async (rel) => ((await inspect(realRoot, rel)) === "missing" ? create : keep).push(rel);
  for (const f of templateFiles(profile)) await add(f);
  for (const d of profileDirs(profile)) {
    const state = await inspect(realRoot, d);
    if (state === "file") throw new Error(`Bukan folder: ${d}`);
    const planned = create.some((f) => f.startsWith(d + "/"));
    const empty = state === "missing" || (await fs.readdir(path.join(realRoot, d))).length === 0;
    if (empty && !planned) create.push(`${d}/.gitkeep`);
  }
  for (const f of INDEX_FILES) await add(f);
  return { create, keep };
}

/**
 * Lays out the project standard in `root` (an existing folder) and returns a log of
 * "buat <path>" / "lewati (sudah ada) <path>" lines. Never overwrites a file.
 */
export async function scaffoldProjectStandard({ root, name, profile = "dasar", today, platform = process.platform } = {}) {
  validateProfile(profile);
  const nama = cleanName(name);
  const tgl = validDate(today);
  const realRoot = await realProjectRoot(root);
  // Preflight refuses links before the first write; each write re-checks its own path.
  await planProjectStandard({ root: realRoot, profile });
  const log = [];
  for (const [f, content] of Object.entries(ROOT(nama, profile, tgl))) {
    const created = await writeNew(realRoot, f, content, log, f === ".githooks/pre-commit" ? 0o755 : undefined);
    // Windows keeps no executable bit, so git would store the hook as 100644 and POSIX clones skip
    // it. The owner's git index is not touched; the log says how to mark it.
    if (created && f === ".githooks/pre-commit" && platform === "win32")
      log.push(
        "peringatan hook: sebelum commit pertama jalankan `git update-index --add --chmod=+x .githooks/pre-commit` agar hook tetap jalan di macOS/Linux",
      );
  }
  for (const [f, content] of Object.entries(PROFILE_FILES(nama, tgl)[profile] || {}))
    await writeNew(realRoot, f, content, log);
  for (const d of profileDirs(profile)) {
    const dir = await makeDir(realRoot, d);
    if ((await fs.readdir(dir)).length === 0) await writeNew(realRoot, `${d}/.gitkeep`, "", log);
  }
  // The index is derived, but an existing one belongs to the project and is kept as well.
  const docs = await scanDocuments(realRoot);
  const registry = { standar: `SPT v${VERSION}`, catatan: "Dibangkitkan oleh miganGO saat proyek dibuat", dokumen: docs };
  await writeNew(realRoot, INDEX_FILES[0], JSON.stringify(registry, null, 2) + "\n", log);
  await writeNew(realRoot, INDEX_FILES[1], renderIndex(docs), log);
  return log;
}

// Every path a scaffold of any profile may contain; used to treat a fresh scaffold as an empty project.
const KNOWN_FILES = new Set(
  PROFILES.flatMap((p) => [...templateFiles(p), ...profileDirs(p).map((d) => `${d}/.gitkeep`), ...INDEX_FILES]),
);
const KNOWN_DIRS = new Set(
  [...KNOWN_FILES].flatMap((f) => f.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))),
);

/** True when `root` holds nothing but scaffold paths (no links, no other files or folders). */
export async function isFreshScaffold(root, rel = "") {
  let entries;
  try {
    entries = await fs.readdir(path.join(root, rel), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  for (const e of entries) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) return false;
    if (e.isDirectory()) {
      if (!KNOWN_DIRS.has(child) || !(await isFreshScaffold(root, child))) return false;
    } else if (!e.isFile() || !KNOWN_FILES.has(child)) return false;
  }
  return true;
}
