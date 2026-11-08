import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  nativeDirectory,
  nativeNames,
  nativeCSharpSource,
  projectRoot,
} from "../src/recovery/native-layout.mjs";

// Passive diagnosis only: reads helper bytes/manifests and Windows metadata.
// Never executes a helper, never writes, never signs, never changes policy.
const hash = (b) => createHash("sha256").update(b).digest("hex");
export const COLLECTOR_TIMEOUT_MS = 15000;
export const COLLECTOR_MAX_OUTPUT = 64 * 1024;
const SAC_STATES = { 0: "off", 1: "enforced", 2: "evaluation" };

export function powershellPath(env = process.env) {
  const systemRoot = env.SystemRoot || "C:\\Windows";
  if (!/^[A-Za-z]:\\/.test(systemRoot))
    throw Error("SystemRoot must be an absolute drive path");
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// Paths travel as base64 JSON inside a single-quoted literal: the base64
// alphabet cannot close the quote, so no path text is ever parsed as code.
export function collectorScript(paths) {
  if (
    !Array.isArray(paths) ||
    !paths.length ||
    paths.some(
      (p) =>
        typeof p !== "string" ||
        !path.win32.isAbsolute(p) ||
        /[\0\r\n]/.test(p),
    )
  )
    throw Error("Collector requires absolute literal paths");
  const payload = Buffer.from(JSON.stringify(paths), "utf8").toString("base64");
  return String.raw`$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$decoded=[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$sac=$null
try{$sac=[int](Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState').VerifiedAndReputablePolicyState}catch{}
$rows=[System.Collections.Generic.List[object]]::new()
foreach($p in $decoded){
 $row=[ordered]@{path=[string]$p;status='Unavailable';subject=$null;issuer=$null;notAfter=$null}
 try{
  $s=Get-AuthenticodeSignature -LiteralPath ([string]$p)
  $row.status=[string]$s.Status
  $c=$s.SignerCertificate
  if($c){$row.subject=[string]$c.Subject;$row.issuer=[string]$c.Issuer;$row.notAfter=$c.NotAfter.ToUniversalTime().ToString('o')}
 }catch{}
 $rows.Add([pscustomobject]$row)
}
ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{sac=$sac;signatures=$rows.ToArray()})
`;
}

export function collectorInvocation(paths, env = process.env) {
  return {
    program: powershellPath(env),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-OutputFormat",
      "Text",
      "-EncodedCommand",
      Buffer.from(collectorScript(paths), "utf16le").toString("base64"),
    ],
    options: {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

export function collectWindowsMetadata(
  paths,
  {
    spawnImpl = spawn,
    env = process.env,
    timeoutMs = COLLECTOR_TIMEOUT_MS,
    maxOutput = COLLECTOR_MAX_OUTPUT,
  } = {},
) {
  const { program, args, options } = collectorInvocation(paths, env);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(program, args, options);
    const chunks = [];
    let bytes = 0,
      stderr = "",
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(value);
    };
    const timer = setTimeout(
      () => finish(Error("Metadata collector timed out")),
      timeoutMs,
    );
    child.stdout.on("data", (d) => {
      bytes += d.length;
      if (bytes > maxOutput)
        return finish(Error("Metadata collector output exceeded limit"));
      chunks.push(Buffer.from(d));
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < 4096) stderr += d;
    });
    child.once("error", (e) => finish(e));
    child.once("close", (code) => {
      if (code !== 0)
        return finish(
          Error(
            "Metadata collector failed: " + code + " " + stderr.slice(-500),
          ),
        );
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        finish(null, JSON.parse(text.replace(/^\uFEFF/, "")));
      } catch {
        finish(Error("Metadata collector output is not JSON"));
      }
    });
  });
}

const commonName = (dn) =>
  typeof dn === "string"
    ? (dn.match(/(?:^|,\s*)CN=("[^"]*"|[^,]*)/)?.[1] ?? "").slice(0, 120) ||
      null
    : null;

export function classifySignature(row) {
  if (!row || typeof row.status !== "string") return "UNAVAILABLE";
  const selfSigned = Boolean(row.subject) && row.subject === row.issuer;
  if (row.status === "HashMismatch") return "SIGNATURE_HASH_MISMATCH";
  if (row.status === "NotSigned") return "UNSIGNED";
  if (selfSigned) return "SELF_SIGNED";
  if (row.status === "Valid" && row.subject) return "VALID";
  if (["NotTrusted", "UnknownError"].includes(row.status) && row.subject)
    return "UNTRUSTED";
  return "UNAVAILABLE";
}

export function sacState(raw) {
  return Number.isInteger(raw) && SAC_STATES[raw]
    ? SAC_STATES[raw]
    : "unavailable";
}

const BROKEN = ["HASH_MISMATCH", "INVALID_MANIFEST", "REPARSE"];
export function classify({ helpers, sac, metadataError = null }) {
  const hold = (code) => ({ status: "HOLD", code });
  if (
    helpers.some(
      (h) =>
        BROKEN.includes(h.integrity) ||
        h.signature?.class === "SIGNATURE_HASH_MISMATCH",
    )
  )
    return hold("INTEGRITY_MISMATCH");
  if (helpers.some((h) => h.integrity === "MISSING")) return hold("MISSING");
  if (
    metadataError ||
    sac === "unavailable" ||
    helpers.some(
      (h) => h.integrity !== "OK" || h.signature?.class === "UNAVAILABLE",
    )
  )
    return hold("UNKNOWN");
  if (sac === "enforced" && helpers.some((h) => h.signature.class !== "VALID"))
    return { status: "SIGNING_REQUIRED", code: "SIGNING_REQUIRED" };
  return { status: "READY_FOR_SMOKE", code: "READY_FOR_SMOKE" };
}

function expectedFrom(root) {
  let entry;
  return (name) => {
    entry ??= hash(
      fs
        .readFileSync(path.join(root, "src/recovery/native-entry.cs"), "utf8")
        .replaceAll("\r\n", "\n"),
    );
    return {
      sourceSha256: hash(nativeCSharpSource(root, name)),
      entrySha256: entry,
    };
  };
}

function inspectHelper(fsApi, dir, name, expected) {
  const executable = path.join(dir, name + ".exe"),
    manifest = path.join(dir, name + ".json");
  const out = {
    name,
    executable,
    present: false,
    integrity: "OK",
    reasons: [],
    executableSha256: null,
  };
  let meta;
  for (const [label, file] of [
    ["manifest", manifest],
    ["executable", executable],
  ])
    try {
      if (fsApi.lstatSync(file).isSymbolicLink())
        return { ...out, integrity: "REPARSE", reasons: [label] };
      if (label === "executable") out.present = true;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      out.reasons.push(label);
    }
  if (out.reasons.length) return { ...out, integrity: "MISSING" };
  try {
    out.executableSha256 = hash(fsApi.readFileSync(executable));
    meta = JSON.parse(fsApi.readFileSync(manifest, "utf8"));
  } catch (e) {
    if (e instanceof SyntaxError)
      return { ...out, integrity: "INVALID_MANIFEST" };
    return { ...out, integrity: "UNREADABLE", reasons: [e.code || "read"] };
  }
  if (meta?.kind !== "migango-native-artifact/v2" || meta.name !== name)
    return { ...out, integrity: "INVALID_MANIFEST" };
  let want;
  try {
    want = expected(name);
  } catch {
    return { ...out, integrity: "UNREADABLE", reasons: ["source"] };
  }
  if (meta.executableSha256 !== out.executableSha256)
    out.reasons.push("executable");
  if (meta.sourceSha256 !== want.sourceSha256) out.reasons.push("source");
  if (meta.entrySha256 !== want.entrySha256) out.reasons.push("entry");
  return out.reasons.length ? { ...out, integrity: "HASH_MISMATCH" } : out;
}

function attachSignatures(helpers, metadata) {
  const rows = new Map();
  for (const row of Array.isArray(metadata?.signatures)
    ? metadata.signatures
    : [])
    if (typeof row?.path === "string")
      rows.set(path.resolve(row.path).toLowerCase(), row);
  for (const h of helpers) {
    if (!h.present) continue;
    const row = rows.get(path.resolve(h.executable).toLowerCase());
    // Only derived, non-secret fields leave the doctor; no certificate bytes.
    h.signature = {
      status: typeof row?.status === "string" ? row.status.slice(0, 40) : null,
      class: classifySignature(row),
      signer: commonName(row?.subject),
      issuer: commonName(row?.issuer),
      selfSigned: Boolean(row?.subject) && row.subject === row.issuer,
      notAfter:
        typeof row?.notAfter === "string" ? row.notAfter.slice(0, 40) : null,
    };
  }
}

const GUIDANCE = {
  READY_FOR_SMOKE: [
    "Metadata awal tidak menunjukkan penghalang. Ini BUKAN PASS.",
    [
      "Jalankan smoke nyata (npm start) di sesi desktop Windows ini.",
      "Jalankan tes native terarah lalu full gate (npm test, npm run test:desktop, npm run verify).",
      "Hasil eksekusi nyata Windows tetap penentu, bukan laporan doctor ini.",
    ],
  ],
  SIGNING_REQUIRED: [
    "Smart App Control aktif (enforced) dan minimal satu helper tidak bertanda tangan, self-signed, atau tanda tangannya tidak dipercaya. Windows kemungkinan memblokir helper tersebut.",
    [
      "Jangan matikan Smart App Control, jangan ubah kebijakan, dan jangan menambah trust root self-signed untuk melewati blokir.",
      "Dibutuhkan identitas penandatangan sah: sertifikat code signing dari CA tepercaya atau akun Artifact Signing. Ikuti runbook signing di docs/06-fungsi/FUNGSI-build-native-lokal-dan-segel-lf.md.",
      "Status tetap HOLD sampai identitas sah tersedia dan helper ditandatangani sebelum manifest hash ditulis.",
    ],
  ],
  MISSING: [
    "Satu atau lebih helper native atau manifestnya belum ada.",
    [
      "Jalankan npm run build-native dari folder miganGO, lalu jalankan doctor ini lagi.",
    ],
  ],
  INTEGRITY_MISMATCH: [
    "Byte helper, manifest, atau sumber tidak cocok (atau tanda tangan melaporkan HashMismatch). Jangan pakai helper ini.",
    [
      "Jika helper ditandatangani setelah manifest ditulis, hash executable berubah: penandatanganan wajib terjadi sebelum manifest hash dicatat (lihat runbook). Jangan menyunting hash manifest secara manual.",
      "Selain itu, periksa perubahan sumber atau artefak, lalu jalankan npm run build-native dari checkout yang sudah direview.",
    ],
  ],
  BUILD_IN_PROGRESS: [
    "Folder .build-lock ada; build native sedang berjalan atau pernah terhenti.",
    [
      "Tunggu build selesai. Jika build crash, periksa folder lock secara manual sebelum menghapusnya.",
    ],
  ],
  UNKNOWN: [
    "Metadata Windows (status tanda tangan, Smart App Control, atau keterbacaan artefak) tidak tersedia, jadi status tidak dapat ditentukan.",
    [
      "Jalankan ulang doctor dari sesi desktop Windows biasa.",
      "Periksa Windows Security > App & browser control > Smart App Control secara manual.",
      "Jangan anggap status ini PASS.",
    ],
  ],
  UNSUPPORTED: [
    "Doctor native hanya mendukung Windows.",
    ["Jalankan doctor ini di mesin Windows target."],
  ],
};

function finalize(report, verdict, detail = null) {
  const [message, steps] = GUIDANCE[verdict.code];
  const notes = [];
  const classes = report.helpers.map((h) => h.signature?.class);
  if (classes.includes("UNSIGNED"))
    notes.push(
      "Helper tanpa tanda tangan adalah build lokal pemilik; itu bukan bukti malware.",
    );
  if (classes.includes("VALID"))
    notes.push(
      "Tanda tangan Valid dari penerbit non-self-signed bukan jaminan lolos Smart App Control atau App Control.",
    );
  if (
    report.sac === "evaluation" &&
    classes.some((c) => c && c !== "VALID")
  )
    notes.push(
      "Smart App Control mode evaluasi dapat berubah menjadi enforced; helper tanpa tanda tangan sah dapat diblokir nanti.",
    );
  notes.push(
    "Doctor tidak menilai kebijakan App Control for Business/WDAC lain; event Code Integrity saat eksekusi nyata tetap otoritatif.",
  );
  return {
    ...report,
    ...verdict,
    ...(detail ? { detail: String(detail).slice(0, 300) } : {}),
    message,
    steps,
    notes,
  };
}

const emptyReport = (platform) => ({
  kind: "migango-native-doctor/v1",
  platform,
  directory: null,
  sac: null,
  helpers: [],
});

export async function diagnoseNative({
  platform = process.platform,
  root = projectRoot,
  directory,
  collect = collectWindowsMetadata,
  expected = expectedFrom(root),
  fsApi = fs,
} = {}) {
  const report = emptyReport(platform);
  if (platform !== "win32")
    return finalize(report, { status: "HOLD", code: "UNSUPPORTED" });
  try {
    report.directory = directory ?? nativeDirectory(root);
  } catch (e) {
    return finalize(report, { status: "HOLD", code: "UNKNOWN" }, e.message);
  }
  const dir = report.directory;
  try {
    if (fsApi.existsSync(path.join(dir, ".build-lock")))
      return finalize(report, { status: "HOLD", code: "BUILD_IN_PROGRESS" });
    for (let p = dir; ; p = path.dirname(p)) {
      try {
        if (fsApi.lstatSync(p).isSymbolicLink())
          return finalize(
            report,
            { status: "HOLD", code: "INTEGRITY_MISMATCH" },
            "Native directory reparse: " + p,
          );
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (path.dirname(p) === p) break;
    }
    report.helpers = nativeNames.map((name) =>
      inspectHelper(fsApi, dir, name, expected),
    );
  } catch (e) {
    return finalize(report, { status: "HOLD", code: "UNKNOWN" }, e.message);
  }
  const present = report.helpers.filter((h) => h.present);
  let metadataError = null;
  if (present.length) {
    try {
      const metadata = await collect(present.map((h) => h.executable));
      report.sac = sacState(metadata?.sac);
      attachSignatures(report.helpers, metadata);
    } catch (e) {
      metadataError = e.message || "collector failed";
      report.sac = "unavailable";
    }
  }
  return finalize(
    report,
    classify({ helpers: report.helpers, sac: report.sac, metadataError }),
    metadataError,
  );
}

export function exitCode(report) {
  return report.status === "READY_FOR_SMOKE"
    ? 0
    : report.status === "SIGNING_REQUIRED"
      ? 2
      : 1;
}

export function formatReport(r) {
  const lines = [
    "Native doctor: " + r.status + " (" + r.code + ")",
    r.message,
    ...(r.detail ? ["Detail: " + r.detail] : []),
    "Folder: " + (r.directory ?? "-"),
    "Smart App Control: " + (r.sac ?? "-"),
  ];
  for (const h of r.helpers)
    lines.push(
      "- " +
        h.name +
        ": integritas " +
        h.integrity +
        (h.reasons.length ? " [" + h.reasons.join(",") + "]" : "") +
        ", tanda tangan " +
        (h.signature
          ? h.signature.class +
            (h.signature.signer ? " oleh " + h.signature.signer : "")
          : "-") +
        (h.executableSha256 ? ", sha256 " + h.executableSha256 : ""),
    );
  lines.push("Langkah:", ...r.steps.map((s) => "  * " + s));
  lines.push("Catatan:", ...r.notes.map((s) => "  * " + s));
  return lines.join("\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  let report;
  try {
    report = await diagnoseNative();
  } catch (error) {
    report = finalize(
      emptyReport(process.platform),
      { status: "HOLD", code: "UNKNOWN" },
      error.message,
    );
  }
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(report, null, 2)
      : formatReport(report),
  );
  process.exitCode = exitCode(report);
}
