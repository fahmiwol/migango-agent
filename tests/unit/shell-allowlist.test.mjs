import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBridgeController } from "../../src/desktop/bridge-controller.mjs";

// Markas, 27 Oct 2026 (replaces the 26 Oct stance for the dev worktree only): the bridge may grant a
// shell approval on its own only in an isolated worktree and only for an allowlisted command:
// npm test, npm run <script in package.json>, node --test, node <file in the worktree>,
// git status|diff|log|add|commit. Network, installs, deletes, the vault, the live folder and
// anything else still wait for the owner. Commands run through PowerShell, so any shell syntax
// that could chain or expand is refused.
const mod = await import("../../src/core/shell-allowlist.mjs").catch((e) => ({ loadError: e }));
const { allowShell } = mod;

// The worktree sits in a temp folder next to a real script OUTSIDE it, so "outside" is tested on a
// file that exists. Cleanup removes the parent folder.
async function worktree() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "migango-shell-"));
  const dir = path.join(parent, "ws");
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test", "verify:evidence": "node x.mjs" } }));
  await fs.writeFile(path.join(dir, "scripts", "cek.mjs"), "console.log(1)\n");
  await fs.writeFile(path.join(parent, "luar.mjs"), "console.log('luar')\n");
  return dir;
}

test("the module loads", () => assert.equal(mod.loadError, undefined, String(mod.loadError?.stack)));

test("allowlisted commands are allowed", async () => {
  const ws = await worktree();
  try {
    for (const command of [
      "npm test",
      "npm run verify:evidence",
      "node --test",
      "node --test tests/unit/paritas.test.mjs",
      "node --test tests/unit/*.test.mjs",
      "node scripts/cek.mjs",
      "git status",
      "git status --short",
      "git diff",
      "git diff --stat HEAD~1",
      "git log --oneline -5",
      "git add src/eval/paritas.mjs tests/unit/paritas.test.mjs",
      "git add -A",
      "git commit -m 'fix: satu tujuan per commit'",
    ])
      assert.deepEqual(allowShell(command, { workspace: ws }), { ok: true }, command);
  } finally {
    await fs.rm(path.dirname(ws), { recursive: true, force: true });
  }
});

test("everything else is refused with a reason", async () => {
  const ws = await worktree();
  try {
    for (const command of [
      "npm install",
      "npm i left-pad",
      "npm run tidak-ada",
      "npx something",
      "node -e \"process.exit()\"",
      "node --eval 1",
      "node ../luar.mjs",
      "node package.json",
      "node C:/work/live/scripts/x.mjs",
      "node scripts/tidak-ada.mjs",
      "node scripts/cek.mjs; Remove-Item -Recurse C:/",
      "npm test && curl https://contoh.test",
      "npm test | Out-File x",
      "git status > out.txt",
      "git push",
      "git push origin main",
      "git reset --hard",
      "git -c core.pager=calc log",
      "git -C ../lain status",
      "git log --output=../x.txt",
      "git diff --ext-diff",
      "git commit -m \"$(Get-Content kunci.txt)\"",
      "git commit -m 'a' --amend",
      "git add ../luar.txt",
      "git checkout main",
      "Remove-Item x",
      "curl https://contoh.test",
      "Invoke-WebRequest https://contoh.test",
      "powershell -c npm test",
      "cmd /c npm test",
      "node scripts/cek.mjs `n whoami",
      "npm test\nwhoami",
      "git commit -m 'baris satu\nwhoami'",
      "",
      "   ",
    ]) {
      const r = allowShell(command, { workspace: ws });
      assert.equal(r.ok, false, command);
      assert.ok(typeof r.reason === "string" && r.reason.length > 3, command);
    }
  } finally {
    await fs.rm(path.dirname(ws), { recursive: true, force: true });
  }
});

test("the bridge grants an allowlisted shell approval only in an isolated worktree, and refuses the rest", async () => {
  const ws = await worktree();
  try {
    let resolved = 0;
    const make = (isolated) =>
      createBridgeController({
        workspace: () => ws,
        status: () => ({}),
        redact: (s) => s,
        start: () => {},
        stop: () => true,
        loadRun: async () => null,
        resolveApproval: () => (resolved++, true),
        canGrantWrites: () => (isolated ? { ok: true } : { ok: false, reason: "checkout utama" }),
      });
    const begin = async (c) => {
      await c.execute("start", { requestId: randomUUID(), expectedWorkspace: ws, prompt: "uji shell", mode: "work" });
      c.observe({ type: "start", id: randomUUID() });
    };
    const ctl = make(true);
    await begin(ctl);
    ctl.observe({ type: "approval", id: "s1", tool: "shell", args: { command: "npm test" }, expiresAt: Date.now() + 10000 });
    ctl.observe({ type: "approval", id: "s2", tool: "shell", args: { command: "npm install" }, expiresAt: Date.now() + 10000 });
    const list = await ctl.execute("approvals", {});
    const s1 = list.find((a) => a.id === "s1"),
      s2 = list.find((a) => a.id === "s2");
    assert.equal(s1.approvable, true);
    assert.equal(s2.approvable, false);
    await ctl.execute("decide", { id: "s1", digest: s1.digest, yes: true, expectedWorkspace: ws });
    assert.equal(resolved, 1);
    await assert.rejects(ctl.execute("decide", { id: "s2", digest: s2.digest, yes: true, expectedWorkspace: ws }));
    // Refusing is always allowed.
    await ctl.execute("decide", { id: "s2", digest: s2.digest, yes: false, expectedWorkspace: ws });
    // Outside an isolated worktree even an allowlisted command waits for the owner.
    const main = make(false);
    await begin(main);
    main.observe({ type: "approval", id: "s3", tool: "shell", args: { command: "npm test" }, expiresAt: Date.now() + 10000 });
    const [s3] = await main.execute("approvals", {});
    assert.equal(s3.approvable, false);
    await assert.rejects(main.execute("decide", { id: "s3", digest: s3.digest, yes: true, expectedWorkspace: ws }));
    // Other tools (ssh, network-capable) are never approvable through the bridge.
    ctl.observe({ type: "approval", id: "x1", tool: "ssh", args: { host: "h", port: 22, command: "npm test" }, expiresAt: Date.now() + 10000 });
    const x1 = (await ctl.execute("approvals", {})).find((a) => a.id === "x1");
    assert.equal(x1.approvable, false);
  } finally {
    await fs.rm(path.dirname(ws), { recursive: true, force: true });
  }
});
