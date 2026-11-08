// ARS-014 modul terminal/PowerShell bertingkat. Pemilah murni (tanpa proses, tanpa fs)
// dan integrasi Tools dengan lapisan OS palsu: tidak ada perintah nyata yang dijalankan.
import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "../../src/core/terminal-bertingkat.mjs";
import { classifyCommand as viaAllowlist } from "../../src/core/shell-allowlist.mjs";
import { Tools, TOOL_GROUPS, validateCall } from "../../src/tools/registry.mjs";

const WS = "C:\\kerja\\repo";
const ps = (c, extra = {}) => classifyCommand(c, { workspace: WS, ...extra }).tingkat;
const cmd = (c) => classifyCommand(c, { workspace: WS, shell: "cmd" }).tingkat;

test("tingkat A: baca-saja di dalam akar", () => {
  for (const c of [
    "Get-ChildItem src",
    "ls",
    "dir tests\\unit",
    "gci -Recurse -Filter *.mjs src",
    "cat README.md",
    "Get-Content docs\\INDEX.md | Select-String -Pattern ARS",
    "Test-Path package.json",
    "pwd",
    "git status",
    "git log --oneline -5",
    "git diff --stat",
    "node --test tests\\unit\\x.test.mjs",
    "Get-Content 'a b.txt' | Measure-Object",
    "Write-Output halo",
  ])
    assert.equal(ps(c), "A", c);
});

test("tingkat B: tulis di dalam akar dan perintah proyek", () => {
  for (const c of [
    "Set-Content catatan.txt halo",
    "New-Item -ItemType Directory tmp-migan\\x",
    "mkdir build",
    "Copy-Item a.txt b.txt",
    "Move-Item a.txt docs\\a.txt",
    "Write-Output halo > keluar.txt",
    "npm test",
    "npm ci",
    "npm run verify",
    "node scripts\\buat.mjs",
    "git add src\\a.mjs",
    "git commit -m 'pesan ringkas'",
  ])
    assert.equal(ps(c), "B", c);
});

test("tingkat C: luar akar, jaringan, hapus, proses, tak dikenal", () => {
  for (const c of [
    "Remove-Item a.txt",
    "rm a.txt",
    "Get-Content C:\\Windows\\win.ini",
    "Get-ChildItem ..\\lain",
    "Set-Content D:\\x.txt halo",
    "iwr https://example.invalid/a -OutFile a.zip",
    "curl https://example.invalid",
    "irm https://example.invalid",
    "Start-Process notepad.exe",
    "Stop-Process -Id 4",
    "git push origin cabang",
    "git commit --amend -m 'x'",
    "npm publish",
    "frobnicate --all",
    "& 'git' push",
    "Set-Location src",
  ])
    assert.equal(ps(c), "C", c);
});

test("tingkat X: eval, encoded, alias berbahaya, ScriptBlock, backtick, sistem", () => {
  for (const c of [
    "iex 'Get-Process'",
    "Invoke-Expression 'x'",
    "Get-Content a.txt | iex",
    "Get-Content a.txt | Invoke-Expression",
    "powershell -enc ZQBjAGgAbwA=",
    "powershell.exe -EncodedCommand ZQBjAGgAbwA=",
    "pwsh -e ZQBjAGgAbwA=",
    "cmd /c del x",
    "Invoke-Command -ScriptBlock { rm x }",
    "& { Remove-Item x }",
    "& $cmd",
    ". $profil",
    "$x = 'a'",
    "I`nvoke-Expression x",
    "Write-Output (Get-Date)",
    "Write-Output $(whoami)",
    "[scriptblock]::Create('x')",
    "Start-Process powershell",
    "Start-Process notepad -Verb RunAs",
    "Set-MpPreference -DisableRealtimeMonitoring 1",
    "Set-ExecutionPolicy Bypass",
    "netsh advfirewall set allprofiles state off",
    "Clear-RecycleBin -Force",
    "Remove-Item -Recurse C:\\Users",
    "Get-Content $env:APPDATA\\x\\vault.json",
    "Get-Content vault.json",
    "Write-Output \"$env:PATH\"",
    "git -c core.pager=x log",
    "git diff --ext-diff",
    "node -e 'x'",
    "Start-Sleep 1 &",
    "Get-Content x < y",
    "Add-Type -TypeDefinition 'x'",
    "Set-Alias ls rm",
    "Write-Output a\nRemove-Item b",
    "Get\u200b-Content x",
    "Write-Output \u2018x\u2019",
    "Get-Process | ForEach-Object { $_ }",
    "@{a=1}",
    "Set-ItemProperty HKLM:\\SOFTWARE\\x -Name y -Value 1",
    "reg add HKLM\\x",
    "x".repeat(4001),
    "",
  ])
    assert.equal(ps(c), "X", JSON.stringify(c).slice(0, 80));
});

test("tingkat gabungan = maksimum seluruh pernyataan dan pipeline", () => {
  assert.equal(ps("git status; npm test"), "B");
  assert.equal(ps("git status; Remove-Item a.txt"), "C");
  assert.equal(ps("git status && iex x"), "X");
  assert.equal(ps("Get-Content a | Set-Content b"), "B");
  assert.equal(ps("Get-Content a | Set-Content C:\\b"), "C");
});

test("alias dan nama tidak peka huruf; .exe dibuang", () => {
  assert.equal(ps("IEX 'x'"), "X");
  assert.equal(ps("GeT-cHiLdItEm"), "A");
  assert.equal(ps("powershell.EXE -NoProfile"), "X");
  assert.equal(ps("curl.exe https://example.invalid"), "C");
});

test("akar terlarang dari pemilik menjadi X", () => {
  assert.equal(ps("Get-Content D:\\data\\x.json", { forbidden: ["D:\\data"] }), "X");
  assert.equal(ps("Get-Content d:\\DATA\\sub", { forbidden: ["D:\\data"] }), "X");
  assert.equal(ps("Get-Content D:\\database", { forbidden: ["D:\\data"] }), "C");
});

test("cmd: rangkaian dan ekspansi ditolak, perintah dasar dipilah", () => {
  assert.equal(cmd("dir src"), "A");
  assert.equal(cmd("type README.md"), "A");
  assert.equal(cmd("mkdir build"), "B");
  assert.equal(cmd("del a.txt"), "C");
  assert.equal(cmd("dir C:\\Windows"), "C");
  for (const c of ["dir & del x", "type a | more", "echo %APPDATA%", "echo !x!", "dir > a", "del /s C:\\x", "powershell -c x", "rd /s /q C:\\Users", "echo ^& x", "(dir)"])
    assert.equal(cmd(c), "X", c);
});

test("hasil pemilah: alasan teks dan perintah lengkap", () => {
  const r = classifyCommand("Remove-Item a.txt", { workspace: WS });
  assert.equal(r.tingkat, "C");
  assert.equal(r.perintah, "Remove-Item a.txt");
  assert.equal(typeof r.alasan, "string");
  assert.ok(r.alasan.length > 0);
  assert.equal(viaAllowlist, classifyCommand);
  assert.equal(classifyCommand(42, { workspace: WS }).tingkat, "X");
  assert.equal(classifyCommand("ls", {}).tingkat, "X", "tanpa workspace absolut ditolak");
});

test("lapisan bertahan sendiri: encoded tanpa shell bersarang, jaringan tanpa URL, teks samaran", () => {
  const why = (c) => classifyCommand(c, { workspace: WS });
  for (const c of ["Get-ChildItem -enc abc", "Get-Content -EncodedCommand abc", "Get-Content -ec abc"]) {
    assert.equal(why(c).tingkat, "X", c);
    assert.match(why(c).alasan, /EncodedCommand/, c);
  }
  assert.equal(ps("irm"), "C");
  assert.equal(ps("Invoke-WebRequest"), "C");
  assert.match(why("Get\u200b-Content x").alasan, /tak terlihat/);
  assert.match(why("Write-Output a\nRemove-Item b").alasan, /baris baru/);
  assert.match(why("Write-Output \u2018x\u2019").alasan, /Unicode yang menyamar/);
  assert.match(why("Get-Content \u201cx\u201d").alasan, /Unicode yang menyamar/);
});

function harness({ isolated = false, approve = true, autoTierA = false } = {}) {
  const ran = [];
  const asked = [];
  const tools = new Tools({
    workspace: { root: WS },
    approvals: {
      request: async (name, args) => {
        asked.push({ name, args });
        return approve;
      },
    },
    isolated: () => isolated,
    shellAutoTierA: autoTierA,
    shellKind: "powershell",
    runShell: async (command) => {
      ran.push(command);
      return { code: 0, stdout: "ok" };
    },
  });
  return { tools, ran, asked };
}
const run = (t, command) => t.execute({ name: "shell", args: { command } }, new AbortController().signal);

test("Tools: X ditolak tanpa dialog dan tanpa proses", async () => {
  const h = harness({ isolated: true });
  await assert.rejects(run(h.tools, "iex x"), (e) => e.code === "ERR_POLICY_DENIED" && /X/.test(e.message));
  assert.equal(h.asked.length, 0);
  assert.equal(h.ran.length, 0);
});

// PIC, 27 Oct 2026: running tier A without approval changes the approval policy, so it is an owner
// setting (shellAutoTierA), off by default, pending a markas/owner decision.
test("Tools: tier A still asks unless the owner enabled shellAutoTierA", async () => {
  const h = harness({ isolated: true });
  await run(h.tools, "git status");
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].args.observation.tingkat, "A");
  assert.deepEqual(h.ran, ["git status"]);
});

test("Tools: A otomatis hanya di worktree terisolasi", async () => {
  const iso = harness({ isolated: true, autoTierA: true });
  const r = await run(iso.tools, "git status");
  assert.equal(iso.asked.length, 0);
  assert.deepEqual(iso.ran, ["git status"]);
  assert.equal(r.tingkat, "A");
  const main = harness({ isolated: false, autoTierA: true });
  await run(main.tools, "git status");
  assert.equal(main.asked.length, 1);
  assert.equal(main.asked[0].args.observation.tingkat, "A");
});

test("Tools: B dan C selalu ditanya; C membawa teks perintah lengkap", async () => {
  // Even with automatic tier A switched on, B and C still ask the owner.
  const h = harness({ isolated: true, autoTierA: true });
  await run(h.tools, "npm test");
  await run(h.tools, "Remove-Item a.txt");
  assert.equal(h.asked.length, 2);
  assert.equal(h.asked[0].args.observation.tingkat, "B");
  assert.equal(h.asked[1].args.observation.tingkat, "C");
  assert.equal(h.asked[1].args.observation.perintah, "Remove-Item a.txt");
  assert.equal(h.ran.length, 2);
});

test("Tools: penolakan pemilik tidak menjalankan proses", async () => {
  const h = harness({ isolated: true, approve: false });
  await assert.rejects(run(h.tools, "npm test"), /rejected/);
  assert.equal(h.ran.length, 0);
});

test("Tools: shell_classify otomatis, tanpa proses, di grup terminal", async () => {
  const h = harness();
  assert.ok(TOOL_GROUPS.terminal.includes("shell_classify"));
  validateCall("shell_classify", { command: "ls" });
  const r = await h.tools.execute({ name: "shell_classify", args: { command: "iex x" } }, new AbortController().signal);
  assert.equal(r.tingkat, "X");
  assert.equal(h.asked.length, 0);
  assert.equal(h.ran.length, 0);
});

test("Tools: shell POSIX tidak pernah otomatis", async () => {
  const ran = [];
  const asked = [];
  const tools = new Tools({
    workspace: { root: "/kerja/repo" },
    approvals: { request: async (n, a) => (asked.push(a), true) },
    isolated: () => true,
    shellKind: "posix",
    runShell: async (c) => (ran.push(c), { code: 0 }),
  });
  await run(tools, "ls");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].observation.tingkat, "C");
});
