// ARS-014 modul terminal/PowerShell bertingkat. Pemilah murni: tidak menjalankan proses,
// tidak membaca disk. Tingkat: A baca-saja di akar, B tulis di akar / perintah proyek,
// C luar akar / jaringan / hapus / proses / tak dikenal, X selalu ditolak.
// Prinsip: apa pun yang tidak bisa dipilah dengan yakin naik tingkat, tidak pernah turun.
import path from "node:path";

const W = path.win32;
const ORDER = ["A", "B", "C", "X"];
const MAX_LEN = 4000;

const ALIASES = {
  ls: "get-childitem", gci: "get-childitem", dir: "get-childitem",
  cat: "get-content", gc: "get-content", type: "get-content",
  sls: "select-string", measure: "measure-object", gi: "get-item",
  gl: "get-location", pwd: "get-location", echo: "write-output", write: "write-output",
  select: "select-object", sort: "sort-object", where: "where-object", "?": "where-object",
  "%": "foreach-object", foreach: "foreach-object", ft: "format-table", fl: "format-list",
  rm: "remove-item", del: "remove-item", rd: "remove-item", ri: "remove-item",
  erase: "remove-item", rmdir: "remove-item",
  iwr: "invoke-webrequest", curl: "invoke-webrequest", wget: "invoke-webrequest",
  irm: "invoke-restmethod", iex: "invoke-expression", icm: "invoke-command",
  saps: "start-process", start: "start-process", spps: "stop-process", kill: "stop-process",
  sc: "set-content", ac: "add-content", ni: "new-item", md: "new-item", mkdir: "new-item",
  cp: "copy-item", copy: "copy-item", cpi: "copy-item", mv: "move-item", move: "move-item",
  mi: "move-item", ren: "rename-item", rni: "rename-item", rename: "rename-item",
  sal: "set-alias", nal: "new-alias", sajb: "start-job", ipmo: "import-module",
  cd: "set-location", chdir: "set-location", sl: "set-location",
  pushd: "push-location", popd: "pop-location", ii: "invoke-item",
  sp: "set-itemproperty", gp: "get-itemproperty", si: "set-item", tee: "tee-object",
};
const set = (s) => new Set(s.split(/\s+/).filter(Boolean));
const NESTED = set("powershell pwsh cmd bash sh wsl wscript cscript mshta rundll32 regsvr32 powershell_ise");
const EVAL = set(`invoke-expression invoke-command start-job start-threadjob add-type set-alias new-alias
  foreach-object register-scheduledtask new-service set-service new-pssession enter-pssession`);
const SYSTEM_X = set(`set-mppreference add-mppreference remove-mppreference set-executionpolicy netsh bcdedit
  clear-recyclebin format-volume clear-disk remove-partition diskpart cmdkey get-credential
  convertfrom-securestring reg vssadmin wmic schtasks stop-computer restart-computer takeown icacls
  runas certutil bitsadmin set-netfirewallprofile new-netfirewallrule set-netfirewallrule
  disable-netfirewallrule remove-netfirewallrule set-acl disable-computerrestore gpupdate secedit
  cipher sdelete set-localuser new-localuser add-localgroupmember enable-psremoting unblock-file
  set-processmitigation format shutdown`);
const READ_A = set(`get-childitem get-content select-string measure-object get-item test-path get-location
  write-output write-host select-object sort-object format-table format-list where-object
  get-filehash resolve-path split-path join-path get-date out-string convertfrom-json
  convertto-json compare-object`);
const WRITE_B = set(`set-content add-content out-file new-item copy-item move-item rename-item set-item
  clear-content tee-object expand-archive compress-archive`);
const NET_C = set("invoke-webrequest invoke-restmethod start-bitstransfer test-netconnection ssh scp");
const PROC_C = set(`stop-process start-service stop-service restart-service set-location push-location
  pop-location invoke-item import-module`);
const REGISTRY = set("set-itemproperty new-itemproperty remove-itemproperty get-itemproperty");

const deny = (alasan) => ({ t: "X", why: alasan });
const level = (t, why) => ({ t, why });
const worse = (a, b) => (ORDER.indexOf(b.t) > ORDER.indexOf(a.t) ? b : a);

// Teks yang menyamarkan isi: kontrol, karakter tak terlihat, kutip/dash Unicode.
const HIDDEN = /[\u0000-\u001f\u007f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
const LOOKALIKE = /[\u2010-\u2015\u2212\u2018-\u201f\u00ab\u00bb\u2039\u203a\uff02\uff07]/;
const SECRET_MARK = /appdata|vault\.json|\\microsoft\\credentials|[\\/]\.ssh([\\/]|$)/i;

export function isEncodedFlag(token, slash) {
  const m = /^(-+|\/)([a-z]+)$/i.exec(token);
  if (!m || (m[1] === "/" && !slash)) return false;
  const w = m[2].toLowerCase();
  return w === "ec" || "encodedcommand".startsWith(w);
}

/** Pecah teks PowerShell menjadi pernyataan -> pipeline -> perintah. Melempar alasan X. */
export function tokenizePs(text) {
  const statements = [[]];
  let command = { tokens: [], redirects: [], call: false };
  let tok = null;
  let pendingRedirect = false;
  const pushTok = () => {
    if (!tok) return;
    if (pendingRedirect) command.redirects.push(tok.text), (pendingRedirect = false);
    else command.tokens.push(tok);
    tok = null;
  };
  const endCommand = () => {
    pushTok();
    if (pendingRedirect) throw "pengalihan tanpa tujuan";
    statements.at(-1).push(command);
    command = { tokens: [], redirects: [], call: false };
  };
  const word = () => (tok ||= { text: "", quoted: false, dynamic: false });
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === " ") pushTok();
    else if (c === "'") {
      const t = word();
      t.quoted = true;
      for (i++; ; i++) {
        if (i >= text.length) throw "kutip tunggal tidak ditutup";
        if (text[i] === "'" && text[i + 1] === "'") t.text += "'", i++;
        else if (text[i] === "'") break;
        else t.text += text[i];
      }
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw "kutip ganda tidak ditutup";
      const inner = text.slice(i + 1, end);
      if (/[$`]/.test(inner)) throw "ekspansi di dalam kutip ganda";
      if (/[^\x20-\x7e]/.test(inner)) throw "karakter non-ASCII di dalam kutip ganda";
      const t = word();
      t.quoted = true;
      t.text += inner;
      i = end;
    } else if (/[^\x20-\x7e]/.test(c)) throw "karakter non-ASCII di luar kutip tunggal";
    else if (c === "`") throw "backtick (escape) di luar kutip tunggal";
    else if ("{}()[]@".includes(c)) throw `"${c}" (ScriptBlock/subekspresi/tipe) tidak dipilah`;
    else if (c === "<") throw "pengalihan masukan";
    else if (c === "#" && !tok) throw "komentar menyembunyikan isi";
    else if (c === ";") endCommand(), statements.push([]);
    else if (c === "|") {
      endCommand();
      if (text[i + 1] === "|") statements.push([]), i++;
    } else if (c === "&") {
      if (text[i + 1] === "&") endCommand(), statements.push([]), i++;
      else {
        pushTok();
        if (command.tokens.length || command.call) throw "& latar belakang atau posisi aneh";
        command.call = true;
      }
    } else if (c === ">") {
      if (tok && !tok.quoted && /^[1-6*]$/.test(tok.text)) tok = null;
      pushTok();
      if (pendingRedirect) throw "pengalihan ganda";
      if (text[i + 1] === ">") i++;
      if (text[i + 1] === "&") {
        if (!/^[1-6]$/.test(text[i + 2] || "")) throw "pengalihan & tidak dikenal";
        i += 2;
      } else pendingRedirect = true;
    } else {
      const t = word();
      if (c === "$") t.dynamic = true;
      t.text += c;
    }
  }
  endCommand();
  return statements;
}

const lowerKey = (p) => W.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
function within(root, target) {
  const r = lowerKey(root);
  const t = lowerKey(target);
  return t === r || t.startsWith(r.endsWith("\\") ? r : r + "\\");
}

/** Tempat argumen menunjuk: "in" (di akar), "out" (luar/tak pasti), "url", "machine". Melempar alasan X. */
function placeOf(token, ctx) {
  const text = token.text;
  if (SECRET_MARK.test(text)) throw "menyentuh lokasi rahasia/data aplikasi";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return "url";
  if (token.dynamic) return "out";
  if (/^(hklm:|hkey_local_machine|registry::)/i.test(text)) return "machine";
  if (/^[a-z][a-z0-9]+:/i.test(text) || text.startsWith("~") || text.startsWith("\\\\")) return "out";
  const abs = W.resolve(ctx.workspace, text);
  for (const f of ctx.forbidden) if (within(f, abs)) throw "akar terlarang pemilik";
  return within(ctx.workspace, abs) ? "in" : "out";
}

const isFlag = (t, slash) => !t.quoted && (t.text.startsWith("-") || (slash && t.text.startsWith("/")));
const values = (tokens, slash) =>
  tokens.flatMap((t) => {
    if (!isFlag(t, slash)) return [t];
    const at = t.text.indexOf(":");
    return at > 0 ? [{ ...t, text: t.text.slice(at + 1) }] : [];
  });

function pathsLevel(tokens, ctx, inside, slash = false) {
  let out = level(inside, "argumen di dalam akar");
  for (const t of values(tokens, slash)) {
    const p = placeOf(t, ctx);
    if (p === "machine") throw "registri mesin (HKLM)";
    if (p === "out" || p === "url") out = worse(out, level("C", `argumen di luar akar: ${t.text}`));
  }
  return out;
}

const baseName = (raw) => W.basename(raw.replace(/\//g, "\\")).toLowerCase().replace(/\.exe$/, "");
const hasArg = (args, list) => args.some((a) => list.includes(a.text.toLowerCase()));
const GIT_BAD = /^(-c|--exec-path|--git-dir|--work-tree|--namespace|--config-env|--ext-diff|--upload-pack|--receive-pack|--exec|--output)(=|$)/i;
const GIT_READ = set("status log diff show rev-parse ls-files blame");

function gitLevel(args, ctx) {
  for (const a of args) if (GIT_BAD.test(a.text)) throw `opsi git berisiko: ${a.text}`;
  const sub = args.find((a) => !isFlag(a))?.text.toLowerCase();
  const outside = args.some((a) => !isFlag(a) && /^([a-z]:|\\\\|\.\.)/i.test(a.text) && placeOf(a, ctx) === "out");
  let r;
  if (!sub || GIT_READ.has(sub)) r = level("A", "git baca-saja");
  else if (sub === "add") r = level("B", "git add");
  else if (sub === "commit")
    r = hasArg(args, ["--amend", "--no-verify", "-n"]) ? level("C", "git commit mengubah riwayat/hook") : level("B", "git commit");
  else r = level("C", `git ${sub} (jaringan/riwayat/cabang)`);
  return outside ? worse(r, level("C", "git dengan path luar akar")) : r;
}

function npmLevel(args) {
  if (hasArg(args, ["-g", "--global"])) return level("C", "npm global");
  const sub = args.find((a) => !isFlag(a))?.text.toLowerCase();
  if (["test", "t", "ci", "install", "i", "run", "run-script"].includes(sub)) return level("B", `npm ${sub} di proyek`);
  return level("C", `npm ${sub || ""} tidak dikenal`.trim());
}

const NODE_X = ["-e", "--eval", "-p", "--print", "-i", "--interactive", "-r", "--require", "--import", "--loader", "--experimental-loader"];
function nodeLevel(args, ctx) {
  if (args.some((a) => NODE_X.includes(a.text.toLowerCase().split("=")[0]))) throw "node mengevaluasi/memuat kode bebas";
  if (args.length === 1 && ["--version", "-v"].includes(args[0].text)) return level("A", "versi node");
  if (args[0]?.text === "--test") {
    const files = args.slice(1).filter((a) => !a.text.startsWith("--test-reporter"));
    if (files.some((a) => isFlag(a))) return level("C", "opsi node --test tidak dikenal");
    return pathsLevel(files, ctx, "A");
  }
  const [first, ...rest] = args;
  if (!first || isFlag(first) || !/\.(m|c)?js$/i.test(first.text)) return level("C", "node tanpa skrip proyek");
  return pathsLevel([first, ...rest], ctx, "B");
}

function startProcessLevel(args) {
  for (const a of args) {
    if (a.text.toLowerCase() === "runas") throw "Start-Process meminta hak admin";
    if (NESTED.has(baseName(a.text))) throw "Start-Process membuka shell bersarang";
  }
  return level("C", "Start-Process membuka proses baru");
}

const RECURSE = /^(-r(e(c(u(r(s(e)?)?)?)?)?)?|\/s)$/i;

/** Pilah satu perintah dengan nama literal `rawName` dan argumen token. */
function commandLevel(rawName, args, ctx, slash) {
  const base = baseName(rawName);
  const name = ALIASES[base] || base;
  if (NESTED.has(name)) throw `shell bersarang: ${base}`;
  if (EVAL.has(name)) throw `evaluasi dinamis/alias: ${name}`;
  if (SYSTEM_X.has(name)) throw `perintah sistem/keamanan: ${name}`;
  if (name === "git") return gitLevel(args, ctx);
  if (name === "npm") return npmLevel(args);
  if (name === "node") return nodeLevel(args, ctx);
  if (name === "start-process") return startProcessLevel(args);
  if (REGISTRY.has(name)) return worse(level("C", "registri"), pathsLevel(args, ctx, "C"));
  if (name === "remove-item") {
    const recurse = args.some((a) => isFlag(a, slash) && RECURSE.test(a.text));
    const places = values(args, slash).map((a) => placeOf(a, ctx));
    if (places.includes("machine")) throw "registri mesin (HKLM)";
    const outside = places.some((p) => p !== "in");
    if (recurse && outside) throw "hapus rekursif di luar akar";
    return level("C", outside ? "menghapus berkas di luar akar" : "menghapus berkas");
  }
  if (NET_C.has(name)) return worse(level("C", "akses jaringan"), pathsLevel(args, ctx, "C"));
  if (PROC_C.has(name)) return worse(level("C", `proses/lokasi: ${name}`), pathsLevel(args, ctx, "C"));
  if (READ_A.has(name)) return pathsLevel(args, ctx, "A", slash);
  if (WRITE_B.has(name)) return pathsLevel(args, ctx, "B", slash);
  values(args, slash).forEach((a) => placeOf(a, ctx));
  return level("C", `perintah tidak dikenal: ${base}`);
}

function checkTokens(tokens, ctx, slash) {
  for (const t of tokens) {
    placeOf({ text: t.text }, ctx);
    if (!t.quoted && isEncodedFlag(t.text, slash)) throw "-EncodedCommand menyembunyikan perintah";
  }
}

function classifyPs(text, ctx) {
  let total = level("A", "baca-saja di dalam akar");
  for (const statement of tokenizePs(text))
    for (const c of statement) {
      if (!c.tokens.length) {
        if (c.call || c.redirects.length || statement.length > 1) throw "perintah kosong dalam rangkaian";
        continue;
      }
      checkTokens(c.tokens, ctx, true);
      let [head, ...args] = c.tokens;
      if (!c.call && !head.quoted && head.text === ".") {
        if (!args.length) throw "dot-source kosong";
        [head, ...args] = args;
        total = worse(total, level("C", "dot-source menjalankan skrip di sesi"));
      }
      if (head.dynamic) throw "nama perintah dinamis ($)";
      if (/[\\/]/.test(head.text)) total = worse(total, level("C", `menjalankan program/skrip: ${head.text}`));
      total = worse(total, commandLevel(head.text, args, ctx, false));
      for (const target of c.redirects) {
        const p = placeOf({ text: target }, ctx);
        total = worse(total, p === "in" ? level("B", "pengalihan ke berkas di akar") : level("C", "pengalihan ke luar akar"));
      }
    }
  return total;
}

function classifyCmd(text, ctx) {
  if (/[&|<>()%!^`]/.test(text)) throw "operator/ekspansi cmd tidak dipilah";
  const tokens = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m; (m = re.exec(text)); ) {
    if (m[2]?.includes('"')) throw "kutip cmd tidak seimbang";
    tokens.push({ text: m[1] ?? m[2], quoted: m[1] !== undefined });
  }
  if (!tokens.length) throw "perintah kosong";
  checkTokens(tokens, ctx, false);
  const [head, ...args] = tokens;
  const base = baseName(head.text);
  if (["echo", "dir", "type"].includes(base)) return pathsLevel(args, ctx, "A", true);
  if (["del", "erase", "rd", "rmdir"].includes(base)) return commandLevel("remove-item", args, ctx, true);
  return commandLevel(head.text, args, ctx, true);
}

/**
 * Pilah satu teks perintah. ctx: {workspace (absolut), shell: "powershell"|"cmd", forbidden: [absolut]}.
 * Hasil: {tingkat: "A"|"B"|"C"|"X", alasan, perintah, shell}. Tidak pernah melempar.
 */
export function classifyCommand(command, ctx = {}) {
  const shell = ctx.shell === "cmd" ? "cmd" : "powershell";
  const out = (r) => ({ tingkat: r.t, alasan: r.why, perintah: typeof command === "string" ? command : "", shell });
  if (typeof command !== "string" || !command.trim()) return out(deny("perintah kosong atau bukan teks"));
  if (command.length > MAX_LEN) return out(deny(`perintah lebih dari ${MAX_LEN} karakter`));
  if (typeof ctx.workspace !== "string" || !W.isAbsolute(ctx.workspace)) return out(deny("workspace absolut tidak diketahui"));
  if (HIDDEN.test(command)) return out(deny("karakter kontrol/tak terlihat/baris baru"));
  if (LOOKALIKE.test(command)) return out(deny("kutip/dash Unicode yang menyamar"));
  const forbidden = (Array.isArray(ctx.forbidden) ? ctx.forbidden : []).filter((f) => typeof f === "string" && W.isAbsolute(f));
  try {
    return out((shell === "cmd" ? classifyCmd : classifyPs)(command, { workspace: ctx.workspace, forbidden }));
  } catch (reason) {
    return out(deny(typeof reason === "string" ? reason : "pemilah gagal; ditolak demi aman"));
  }
}

export const TINGKAT = Object.freeze([...ORDER]);
