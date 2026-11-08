import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import dgram from "node:dgram";
import { WindowsSandbox } from "../../src/sandbox/windows.mjs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { leaseRoot, reconcileSandbox } from "../../src/sandbox/leases.mjs";
import { committedLeases } from "../fixtures/lease-observer.mjs";
const nodeExecutable = process.execPath;
test(
  "sandbox crash leaves a tracked profile which restart reconciles without replay",
  { timeout: 30000 },
  async (t) => {
    const { root, exec, leaseDirectory } = await setup(t);
    await fs.writeFile(path.join(exec, "wait.mjs"), "setInterval(()=>{},1000)");
    const hostfile = path.join(root, "host.mjs");
    await fs.writeFile(
      hostfile,
      `import {WindowsSandbox} from ${JSON.stringify(pathToFileURL(path.resolve("src/sandbox/windows.mjs")).href)};await new WindowsSandbox({root:${JSON.stringify(root)},leaseDirectory:${JSON.stringify(leaseDirectory)},onPhase:p=>process.stderr.write(JSON.stringify(p)+'\\n')}).run({execution:${JSON.stringify(exec)},script:'wait.mjs',timeout:20000});`,
    );
    const host = spawn(process.execPath, [hostfile], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    host.stderr.on("data", (b) => (stderr += b));
    t.after(() => {
      try {
        host.kill();
      } catch {}
    });
    let record, filename;
    for (let i = 0; i < 100; i++) {
      for (const { record: r, filename: f } of await committedLeases(
        leaseDirectory,
      )) {
        if (r.grants.includes(exec) && Number.isInteger(r.candidatePid)) {
          record = r;
          filename = f;
          break;
        }
      }
      if (record) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(
      record,
      "Native profile must be durably tracked before launch: " + stderr,
    );
    t.diagnostic(stderr.trim());
    assert.doesNotThrow(
      () => process.kill(record.candidatePid, 0),
      "Candidate must actually be alive before host crash",
    );
    const closed = new Promise((r) => host.once("close", r));
    host.kill();
    await closed;
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(record.pid, 0);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.throws(
      () => process.kill(record.pid, 0),
      "Native supervisor must die after host EOF",
    );
    assert.throws(
      () => process.kill(record.candidatePid, 0),
      "Sandbox candidate must die with supervisor",
    );
    assert.ok(await fs.stat(filename));
    const cleanups = await Promise.all(
      Array.from({ length: 3 }, () =>
        reconcileSandbox({ root: leaseDirectory }),
      ),
    );
    assert.equal(
      cleanups.reduce((a, b) => a + b, 0),
      1,
      "Three parallel recoveries must claim one orphan exactly once",
    );
    await assert.rejects(fs.stat(filename), /ENOENT/);
  },
);
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "migango-os-sandbox-"));
  const exec = path.join(root, "execution");
  await fs.mkdir(exec);
  const outside = path.join(root, "private-canary.txt");
  await fs.writeFile(outside, "CANARY");
  const sandbox = new WindowsSandbox({
    root: path.join(root, "sandbox"),
    nodeExecutable,
    leaseDirectory: path.join(root, "leases"),
  });
  t.after(async () => {
    await sandbox.close?.();
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    sandbox,
    root,
    exec,
    outside,
    leaseDirectory: path.join(root, "leases"),
  };
}
test(
  "OS sandbox runs Node without permission flags and kernel denies private host files and outbound TCP",
  { timeout: 30000 },
  async (t) => {
    const { sandbox, exec, outside } = await setup(t);
    let accepts = 0;
    const server = net.createServer((s) => {
      accepts++;
      s.end();
    });
    await new Promise((r) => server.listen(0, "0.0.0.0", r));
    t.after(() => server.close());
    const port = server.address().port;
    await new Promise((res, rej) => {
      const c = net.connect(port, "127.0.0.1");
      c.on("connect", () => {
        c.end();
        res();
      });
      c.on("error", rej);
    });
    assert.equal(await fs.readFile(outside, "utf8"), "CANARY");
    await fs.writeFile(
      path.join(exec, "probe.mjs"),
      `import fs from 'node:fs';import net from 'node:net';const r={};try{fs.readFileSync(${JSON.stringify(outside)});r.read='ALLOWED';}catch(e){r.read=e.code;}try{fs.writeFileSync(${JSON.stringify(outside)},'BAD');r.write='ALLOWED';}catch(e){r.write=e.code;}const socket=net.connect(${port},'127.0.0.1');r.tcp=await new Promise(resolve=>{socket.on('connect',()=>{socket.destroy();resolve('ALLOWED');});socket.on('error',e=>resolve(e.code));setTimeout(()=>{socket.destroy();resolve('TIMEOUT');},1500).unref();});console.log(JSON.stringify(r));`,
    );
    const r = await sandbox.run({
      execution: exec,
      script: "probe.mjs",
      args: [],
      timeout: 15000,
    });
    assert.equal(r.code, 0, r.output);
    const probe = JSON.parse(r.output);
    assert.match(probe.read, /EACCES|EPERM/);
    assert.match(probe.write, /EACCES|EPERM/);
    assert.match(probe.tcp, /EACCES|EPERM|ETIMEDOUT/);
    assert.equal(
      accepts,
      1,
      "Only positive-control host connection may reach receiver",
    );
    assert.equal(await fs.readFile(outside, "utf8"), "CANARY");
    assert.equal(r.sandbox.kind, "windows-appcontainer");
    assert.equal(r.sandbox.network, "deny");
    assert.equal(r.sandbox.capabilities, 0);
    assert.equal(r.sandbox.isAppContainer, true);
  },
);
test(
  "OS network restriction applies UDP and child processes with no Node permission flags",
  { timeout: 30000 },
  async (t) => {
    const { sandbox, exec, outside } = await setup(t);
    let candidatePackets = 0;
    const udp = dgram.createSocket("udp4");
    udp.on("message", (b) => {
      if (b.toString() === "candidate") candidatePackets++;
    });
    await new Promise((r) => udp.bind(0, "0.0.0.0", r));
    t.after(() => udp.close());
    const port = udp.address().port;
    const delivered = new Promise((resolve) =>
      udp.once("message", (b) => {
        assert.equal(b.toString(), "host");
        resolve();
      }),
    );
    const host = dgram.createSocket("udp4");
    await new Promise((res, rej) =>
      host.send(Buffer.from("host"), port, "127.0.0.1", (e) =>
        e ? rej(e) : res(),
      ),
    );
    await delivered;
    host.close();
    await fs.writeFile(
      path.join(exec, "child.mjs"),
      `import fs from 'node:fs';try{fs.readFileSync(${JSON.stringify(outside)});process.exit(42);}catch(e){process.exit(['EACCES','EPERM'].includes(e.code)?0:43);}`,
    );
    await fs.writeFile(
      path.join(exec, "probe.mjs"),
      `import dgram from 'node:dgram';import {spawnSync} from 'node:child_process';const socket=dgram.createSocket('udp4');const result=await new Promise(resolve=>{socket.on('error',e=>resolve(e.code));setTimeout(()=>resolve('API_PENDING_NO_DELIVERY'),1500).unref();socket.send(Buffer.from('candidate'),${port},'127.0.0.1',e=>resolve(e?e.code:'API_ACCEPTED_NO_DELIVERY'));});socket.close();const child=spawnSync(process.execPath,['--preserve-symlinks','--preserve-symlinks-main','child.mjs'],{stdio:'ignore',timeout:2000});console.log(JSON.stringify({udp:result,childStatus:child.status,childError:child.error?.code}));`,
    );
    const r = await sandbox.run({
      execution: exec,
      script: "probe.mjs",
      args: [],
      timeout: 15000,
    });
    assert.equal(r.code, 0, r.output);
    const p = JSON.parse(r.output);
    assert.match(p.udp, /EACCES|EPERM|API_(PENDING|ACCEPTED)_NO_DELIVERY/);
    assert.equal(
      candidatePackets,
      0,
      "Sandbox UDP must not reach real receiver",
    );
    assert.equal(p.childStatus, 0);
    assert.equal(p.childError, undefined);
  },
);
test("sandbox rejects unavailable backend and traversal before candidate can run", async (t) => {
  const { sandbox, exec } = await setup(t);
  await assert.rejects(
    sandbox.run({ execution: exec, script: "../escape.mjs", args: [] }),
    /path|scope|script/i,
  );
  const unavailable = new WindowsSandbox({
    root: path.join(exec, "state"),
    nodeExecutable: "C:/nonexistent/node.exe",
  });
  await assert.rejects(
    unavailable.run({ execution: exec, script: "probe.mjs", args: [] }),
    /unavailable|runtime|ENOENT/i,
  );
});
