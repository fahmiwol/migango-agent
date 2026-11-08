import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  diagnoseNative,
  collectorScript,
  collectorInvocation,
  collectWindowsMetadata,
  classifySignature,
  exitCode,
} from "../../scripts/native-doctor.mjs";
import { nativeNames } from "../../src/recovery/native-layout.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const expected = () => ({ sourceSha256: "s".repeat(64), entrySha256: "e".repeat(64) });
const UNSIGNED = { status: "NotSigned", subject: null, issuer: null };
const VALID = {
  status: "Valid",
  subject: "CN=Contoh Penerbit, O=Contoh, C=ID",
  issuer: "CN=Contoh Public Code Signing CA, O=Contoh CA",
  notAfter: "2027-10-25T00:00:00.0000000Z",
};
const SELF = { status: "Valid", subject: "CN=Lokal", issuer: "CN=Lokal" };

async function fixture(t, skip = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "migango-native-doctor-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const name of nativeNames) {
    if (skip.includes(name)) continue;
    const exe = Buffer.from("MZ fake helper " + name);
    await fs.writeFile(path.join(dir, name + ".exe"), exe);
    await fs.writeFile(
      path.join(dir, name + ".json"),
      JSON.stringify({
        kind: "migango-native-artifact/v2",
        name,
        ...expected(),
        executableSha256: hash(exe),
      }),
    );
  }
  return dir;
}

function collector(sac, row) {
  const calls = [];
  const collect = async (paths) => {
    calls.push(paths);
    return {
      sac,
      signatures: paths.map((p) => ({
        path: p,
        ...(typeof row === "function" ? row(p) : row),
      })),
    };
  };
  return { collect, calls };
}

const run = (directory, collect, platform = "win32") =>
  diagnoseNative({ platform, directory, collect, expected });

async function snapshot(dir) {
  const out = {};
  for (const name of (await fs.readdir(dir)).sort()) {
    const file = path.join(dir, name);
    const stat = await fs.stat(file);
    out[name] = [hash(await fs.readFile(file)), stat.size, stat.mtimeMs];
  }
  return out;
}

test("unsigned helpers under enforced Smart App Control require signing without calling them malware", async (t) => {
  const dir = await fixture(t);
  const { collect } = collector(1, UNSIGNED);
  const r = await run(dir, collect);
  assert.equal(r.status, "SIGNING_REQUIRED");
  assert.equal(r.sac, "enforced");
  assert.equal(exitCode(r), 2);
  assert.ok(r.helpers.every((h) => h.integrity === "OK"));
  assert.ok(r.helpers.every((h) => h.signature.class === "UNSIGNED"));
  assert.ok(r.notes.some((n) => /bukan bukti malware/.test(n)));
  assert.ok(!/malware/i.test(r.message));
});

test("unsigned helpers with Smart App Control off or evaluation are only ready for smoke", async (t) => {
  const dir = await fixture(t);
  for (const [sac, state] of [
    [0, "off"],
    [2, "evaluation"],
  ]) {
    const r = await run(dir, collector(sac, UNSIGNED).collect);
    assert.equal(r.status, "READY_FOR_SMOKE");
    assert.equal(r.sac, state);
    assert.equal(exitCode(r), 0);
    assert.match(r.message, /BUKAN PASS/);
    assert.ok(r.steps.some((s) => /eksekusi nyata/.test(s)));
  }
  const evaluation = await run(dir, collector(2, UNSIGNED).collect);
  assert.ok(evaluation.notes.some((n) => /mode evaluasi/.test(n)));
});

test("Valid publisher signature is ready for smoke but never presented as a SAC guarantee", async (t) => {
  const dir = await fixture(t);
  const r = await run(dir, collector(1, VALID).collect);
  assert.equal(r.status, "READY_FOR_SMOKE");
  assert.ok(r.helpers.every((h) => h.signature.class === "VALID"));
  assert.equal(r.helpers[0].signature.signer, "Contoh Penerbit");
  assert.equal(r.helpers[0].signature.selfSigned, false);
  assert.ok(r.notes.some((n) => /bukan jaminan/.test(n)));
  assert.match(r.message, /BUKAN PASS/);
});

test("self-signed or untrusted signatures still require a legitimate signer when SAC is enforced", async (t) => {
  const dir = await fixture(t);
  const self = await run(dir, collector(1, SELF).collect);
  assert.equal(self.status, "SIGNING_REQUIRED");
  assert.ok(self.helpers.every((h) => h.signature.class === "SELF_SIGNED"));
  const mixed = await run(
    dir,
    collector(1, (p) =>
      p.endsWith("mcp-job.exe")
        ? { status: "UnknownError", subject: "CN=X", issuer: "CN=Y" }
        : VALID,
    ).collect,
  );
  assert.equal(mixed.status, "SIGNING_REQUIRED");
  assert.equal(
    mixed.helpers.find((h) => h.name === "mcp-job").signature.class,
    "UNTRUSTED",
  );
});

test("unavailable metadata is HOLD UNKNOWN, never ready or signing required", async (t) => {
  const dir = await fixture(t);
  const failed = await run(dir, async () => {
    throw Error("collector boom");
  });
  assert.equal(failed.status, "HOLD");
  assert.equal(failed.code, "UNKNOWN");
  assert.equal(exitCode(failed), 1);
  assert.match(failed.detail, /collector boom/);
  for (const sac of [null, 7, "1"]) {
    const r = await run(dir, collector(sac, VALID).collect);
    assert.equal(r.code, "UNKNOWN", "SAC " + sac);
  }
  const partial = await run(dir, async (paths) => ({
    sac: 1,
    signatures: paths.slice(1).map((p) => ({ path: p, ...VALID })),
  }));
  assert.equal(partial.code, "UNKNOWN");
  const garbage = await run(dir, collector(0, { status: "Unavailable" }).collect);
  assert.equal(garbage.code, "UNKNOWN");
});

test("integrity mismatch outranks signature state and points at signing order", async (t) => {
  const dir = await fixture(t);
  await fs.writeFile(path.join(dir, "windows-job.exe"), "MZ signed after manifest");
  const r = await run(dir, collector(1, VALID).collect);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "INTEGRITY_MISMATCH");
  const job = r.helpers.find((h) => h.name === "windows-job");
  assert.equal(job.integrity, "HASH_MISMATCH");
  assert.deepEqual(job.reasons, ["executable"]);
  assert.ok(r.steps.some((s) => /sebelum manifest hash/.test(s)));
  const stale = await diagnoseNative({
    platform: "win32",
    directory: await fixture(t),
    collect: collector(0, VALID).collect,
    expected: () => ({ sourceSha256: "x", entrySha256: "e".repeat(64) }),
  });
  assert.equal(stale.code, "INTEGRITY_MISMATCH");
  assert.ok(stale.helpers.every((h) => h.reasons.includes("source")));
  const authenticode = await run(
    await fixture(t),
    collector(0, { ...VALID, status: "HashMismatch" }).collect,
  );
  assert.equal(authenticode.code, "INTEGRITY_MISMATCH");
  const badManifest = await fixture(t);
  await fs.writeFile(path.join(badManifest, "mcp-job.json"), "{not json");
  assert.equal((await run(badManifest, collector(0, VALID).collect)).code, "INTEGRITY_MISMATCH");
});

test("missing helper is MISSING, not a fake signing requirement", async (t) => {
  const dir = await fixture(t, ["process-identity"]);
  await fs.rm(path.join(dir, "mcp-job.json"));
  const { collect, calls } = collector(1, UNSIGNED);
  const r = await run(dir, collect);
  assert.equal(r.status, "HOLD");
  assert.equal(r.code, "MISSING");
  assert.equal(exitCode(r), 1);
  assert.deepEqual(
    r.helpers.find((h) => h.name === "process-identity").reasons,
    ["manifest", "executable"],
  );
  assert.deepEqual(r.helpers.find((h) => h.name === "mcp-job").reasons, ["manifest"]);
  assert.match(r.steps[0], /npm run build-native/);
  assert.ok(calls[0].every((p) => !p.endsWith("process-identity.exe")));
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "migango-native-empty-"));
  t.after(() => fs.rm(empty, { recursive: true, force: true }));
  const none = collector(1, UNSIGNED);
  const absent = await run(empty, none.collect);
  assert.equal(absent.code, "MISSING");
  assert.equal(none.calls.length, 0, "Nothing to inspect, no collector call");
});

test("build lock and non-Windows platforms hold without touching metadata", async (t) => {
  const dir = await fixture(t);
  await fs.mkdir(path.join(dir, ".build-lock"));
  const locked = collector(0, VALID);
  const r = await run(dir, locked.collect);
  assert.equal(r.code, "BUILD_IN_PROGRESS");
  assert.equal(locked.calls.length, 0);
  const other = collector(0, VALID);
  for (const platform of ["linux", "darwin"]) {
    const u = await run(dir, other.collect, platform);
    assert.equal(u.status, "HOLD");
    assert.equal(u.code, "UNSUPPORTED");
    assert.equal(exitCode(u), 1);
  }
  assert.equal(other.calls.length, 0);
});

test("doctor is read-only, passes only helper paths to the collector and leaks no certificate material", async (t) => {
  const dir = await fixture(t);
  const before = await snapshot(dir);
  const { collect, calls } = collector(1, () => ({
    ...VALID,
    rawData: "-----BEGIN CERTIFICATE-----MIIBfake-----END CERTIFICATE-----",
    privateKey: "PRIVATE KEY fake",
    thumbprint: "AB".repeat(20),
  }));
  const r = await run(dir, collect);
  assert.deepEqual(await snapshot(dir), before, "No artifact bytes or mtimes changed");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    calls[0],
    nativeNames.map((n) => path.join(dir, n + ".exe")),
  );
  const text = JSON.stringify(r);
  for (const leak of ["BEGIN CERTIFICATE", "PRIVATE KEY", "AB".repeat(20), "O=Contoh"])
    assert.ok(!text.includes(leak), "Report must not contain " + leak);
});

test("collector script embeds hostile paths only as inert base64 literal data", () => {
  const hostile = [
    "C:\\x\\a'; Remove-Item -Recurse C:\\ ; '.exe",
    "C:\\x\\$(Start-Process calc).exe",
    "C:\\x\\`n\"quoted\" & whoami.exe",
    "C:\\Program Files\\migan ü\\windows-job.exe",
  ];
  const script = collectorScript(hostile);
  for (const p of hostile) assert.ok(!script.includes(p));
  for (const bad of ["Remove-Item", "Start-Process", "whoami"])
    assert.ok(!script.includes(bad));
  const literal = script.match(/FromBase64String\('([^']*)'\)/)[1];
  assert.match(literal, /^[A-Za-z0-9+/=]+$/);
  assert.deepEqual(JSON.parse(Buffer.from(literal, "base64").toString("utf8")), hostile);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath/);
  assert.match(script, /Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'/);
  for (const effect of ["Set-", "New-Item", "Remove-", "Start-Process", "Invoke-", "& $", "Add-Type"])
    assert.ok(!script.includes(effect), "Collector must stay read-only: " + effect);
  for (const bad of [[], ["relative\\a.exe"], ["C:\\a\nb.exe"], ["C:\\a\0.exe"], [42]])
    assert.throws(() => collectorScript(bad), /absolute literal paths/);
});

test("collector invocation is fixed signed PowerShell with shell disabled", () => {
  const paths = ["C:\\n\\windows-job.exe"];
  const inv = collectorInvocation(paths, { SystemRoot: "C:\\Windows" });
  assert.equal(inv.program, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(inv.options.shell, false);
  assert.equal(inv.options.windowsHide, true);
  assert.deepEqual(inv.args.slice(0, -1), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-OutputFormat",
    "Text",
    "-EncodedCommand",
  ]);
  assert.ok(!inv.args.some((a) => a.includes(paths[0])));
  assert.equal(
    Buffer.from(inv.args.at(-1), "base64").toString("utf16le"),
    collectorScript(paths),
  );
  assert.throws(() => collectorInvocation(paths, { SystemRoot: "relative" }));
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => (child.kills++, true);
  return child;
}

test("metadata collector spawns only PowerShell, parses bounded JSON and kills on overrun or timeout", async () => {
  const paths = ["C:\\n\\windows-job.exe", "C:\\n\\mcp-job.exe"];
  const spawned = [];
  const spawnWith = (drive) => (program, args, options) => {
    spawned.push({ program, args, options });
    const child = fakeChild();
    setImmediate(() => drive(child));
    return child;
  };
  const ok = await collectWindowsMetadata(paths, {
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: spawnWith((c) => {
      c.stdout.emit("data", Buffer.from('\uFEFF{"sac":1,"signatures":[]}'));
      c.emit("close", 0);
    }),
  });
  assert.deepEqual(ok, { sac: 1, signatures: [] });
  let overrun;
  await assert.rejects(
    collectWindowsMetadata(paths, {
      maxOutput: 16,
      spawnImpl: spawnWith((c) => {
        overrun = c;
        c.stdout.emit("data", Buffer.alloc(32, 0x41));
      }),
    }),
    /exceeded limit/,
  );
  assert.equal(overrun.kills, 1);
  let hung;
  await assert.rejects(
    collectWindowsMetadata(paths, {
      timeoutMs: 20,
      spawnImpl: spawnWith((c) => (hung = c)),
    }),
    /timed out/,
  );
  assert.equal(hung.kills, 1);
  await assert.rejects(
    collectWindowsMetadata(paths, {
      spawnImpl: spawnWith((c) => {
        c.stderr.emit("data", "denied");
        c.emit("close", 1);
      }),
    }),
    /collector failed: 1 denied/,
  );
  await assert.rejects(
    collectWindowsMetadata(paths, {
      spawnImpl: spawnWith((c) => {
        c.stdout.emit("data", Buffer.from("not json"));
        c.emit("close", 0);
      }),
    }),
    /not JSON/,
  );
  for (const call of spawned) {
    assert.match(call.program, /\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
    assert.equal(call.options.shell, false);
    assert.ok(!paths.includes(call.program), "Candidate helper is never spawned");
  }
});

test("signature classification matrix", () => {
  assert.equal(classifySignature(UNSIGNED), "UNSIGNED");
  assert.equal(classifySignature(VALID), "VALID");
  assert.equal(classifySignature(SELF), "SELF_SIGNED");
  assert.equal(classifySignature({ ...SELF, status: "UnknownError" }), "SELF_SIGNED");
  assert.equal(classifySignature({ ...VALID, status: "NotTrusted" }), "UNTRUSTED");
  assert.equal(classifySignature({ ...VALID, status: "HashMismatch" }), "SIGNATURE_HASH_MISMATCH");
  assert.equal(classifySignature({ status: "Valid" }), "UNAVAILABLE");
  assert.equal(classifySignature({ status: "Unavailable" }), "UNAVAILABLE");
  assert.equal(classifySignature(undefined), "UNAVAILABLE");
});
