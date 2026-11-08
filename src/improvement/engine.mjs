import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { Workspace } from "../tools/workspace.mjs";
import { runProcess } from "../tools/process.mjs";
import { WindowsSandbox } from "../sandbox/windows.mjs";
import { contentHash } from "../core/integrity.mjs";
import { nativeDirectory, nativeNames } from "../recovery/native-layout.mjs";

const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const canonical = (files) =>
  Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
const protectedPath = (p) =>
  /(^|\/)(tests?|__tests__|evals?|scripts|recovery|improvement|sandbox)(\/|\.)|(^|\/)(package(?:-lock)?\.json|AGENTS\.md|CLAUDE\.md)$|^src\/(desktop|tools)\/|^src\/core\/(storage|approvals|credential-import|providers|shutdown)/i.test(
    p,
  );
const transient = new Set(["reproducing", "making", "validating"]);
// A stored row that is not valid JSON is data damage, not a program bug: report a fixed code
// without the stored text so callers can turn the feature off (markas, 25 Oct 2026).
const DATA_CORRUPT = "ERR_IMPROVEMENT_DATA_CORRUPT";
function readStored(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error("Stored improvement data is unreadable"), {
      code: DATA_CORRUPT,
    });
  }
}
export class ImprovementEngine {
  constructor({
    root,
    maker,
    nodeExecutable = process.execPath,
    redact = (v) => v,
    journal,
  }) {
    Object.assign(this, {
      root: path.resolve(root),
      maker,
      nodeExecutable,
      redact,
      journal,
    });
    this.busy = false;
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    this.db = new DatabaseSync(path.join(this.root, "improvement.db"));
    try {
      this.db
        .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS active(workspace TEXT PRIMARY KEY,id TEXT NOT NULL REFERENCES candidates(id));`);
      for (const row of this.db.prepare("SELECT data FROM candidates").all()) {
        const c = readStored(row.data);
        if (transient.has(c.status)) {
          c.status = "hold";
          c.error = "Interrupted operation; no inference or effect replay";
          this.save(c);
        }
      }
      for (const row of this.db.prepare("SELECT workspace FROM active").all())
        await this.recoverActive(row.workspace);
    } catch (error) {
      // Release the file so a corrupt database can be copied or moved by the owner.
      try {
        this.db.close();
      } catch {}
      this.db = undefined;
      throw error;
    }
  }
  close() {
    this.db?.close();
  }
  save(c) {
    this.db
      .prepare(
        "INSERT INTO candidates VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data",
      )
      .run(c.id, c.workspace, c.status, JSON.stringify(c));
    return c;
  }
  async get(id) {
    const row = this.db
      .prepare("SELECT data FROM candidates WHERE id=?")
      .get(id);
    if (!row) throw Error("Unknown candidate");
    return readStored(row.data);
  }
  async list(workspace) {
    return this.db
      .prepare(
        "SELECT data FROM candidates WHERE workspace=? ORDER BY rowid DESC LIMIT 60",
      )
      .all(path.resolve(workspace))
      .map((row) => this.public(readStored(row.data)));
  }
  public(c) {
    const { base, candidate, ...rest } = c;
    return {
      ...rest,
      diff: c.editable
        .filter((p) => c.base[p] !== c.candidate[p])
        .map((p) => ({
          path: p,
          before: c.base[p].slice(0, 6000),
          after: c.candidate[p].slice(0, 6000),
        })),
    };
  }
  async create({ workspace, goal, files, editable, tests }) {
    if (typeof goal !== "string" || goal.length < 5 || goal.length > 4000)
      throw Error("Goal must be 5–4000 characters");
    for (const list of [files, editable, tests])
      if (
        !Array.isArray(list) ||
        !list.length ||
        list.length > 100 ||
        new Set(list).size !== list.length ||
        list.some((p) => typeof p !== "string" || p.includes("\\"))
      )
        throw Error("Explicit unique bounded POSIX paths required");
    if (
      editable.some(
        (p) =>
          !files.includes(p) ||
          protectedPath(p) ||
          !/\.(mjs|js|ts|tsx|css|html|md|json)$/.test(p),
      )
    )
      throw Error(
        "Editable scope includes immutable policy/test or unsupported path",
      );
    if (
      tests.some(
        (p) =>
          !files.includes(p) ||
          editable.includes(p) ||
          !/^tests\/[^\s]+\.m?js$/.test(p),
      )
    )
      throw Error("Oracle must be pinned non-editable tests/*.mjs");
    const ws = new Workspace(workspace),
      base = {};
    let bytes = 0;
    for (const p of files) {
      const filename = await ws.resolve(p);
      const s = await fs.stat(filename);
      if (!s.isFile() || s.size > 131072)
        throw Error("Snapshot file too large");
      const text = await fs.readFile(filename, "utf8");
      if (text.includes("\0") || this.redact(text) !== text)
        throw Error("Binary or credential-like snapshot blocked");
      bytes += Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024) throw Error("Snapshot exceeds 2 MiB");
      base[p] = text;
    }
    const id = randomUUID();
    const c = {
      version: 1,
      id,
      workspace: await fs.realpath(workspace),
      goal,
      files: [...files].sort(),
      editable: [...editable],
      tests: [...tests].sort(),
      base: canonical(base),
      candidate: canonical(base),
      baseHash: digest(canonical(base)),
      candidateHash: digest(canonical(base)),
      oracleHash: digest(tests.map((p) => [p, base[p]])),
      created: new Date().toISOString(),
      status: "created",
      attempts: 0,
      receipts: [],
      directory: path.join(this.root, "candidates", id),
    };
    await this.materialize(c.directory, c.candidate);
    this.save(c);
    return this.public(c);
  }
  async materialize(dir, files) {
    await fs.mkdir(dir, { recursive: true });
    for (const [p, text] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, p)), { recursive: true });
      await fs.writeFile(path.join(dir, p), text, { flag: "wx" });
    }
  }
  async assertSeal(c) {
    const observed = {};
    const walk = async (dir, prefix = "") => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = prefix + e.name;
        if (e.isSymbolicLink()) throw Error("Candidate seal symlink changed");
        if (e.isDirectory()) await walk(path.join(dir, e.name), p + "/");
        else if (e.isFile()) {
          const s = await fs.stat(path.join(dir, e.name));
          if (s.size > 131072) throw Error("Candidate seal size changed");
          observed[p] = await fs.readFile(path.join(dir, e.name), "utf8");
        } else throw Error("Candidate seal changed");
      }
    };
    await walk(c.directory);
    if (digest(canonical(observed)) !== c.candidateHash)
      throw Error("Candidate seal/hash changed after validation");
  }
  async assertBase(c) {
    const ws = new Workspace(c.workspace),
      base = {};
    for (const p of c.files) {
      base[p] = await fs.readFile(await ws.resolve(p), "utf8");
    }
    if (digest(canonical(base)) !== c.baseHash)
      throw Error(
        "Workspace base changed; activation requires a fresh candidate",
      );
  }
  async executeOracle(c, files, signal) {
    signal?.throwIfAborted();
    const exec = path.join(this.root, "executions", randomUUID());
    const executionFiles = {
      ...files,
      ".migan-oracle/preload.cjs": await fs.readFile(
        path.join(import.meta.dirname, "oracle-preload.cjs"),
        "utf8",
      ),
    };
    await this.materialize(exec, executionFiles);
    let output = "",
      code = null,
      error,
      uncertain = false;
    try {
      const r = await runProcess(
        this.nodeExecutable,
        [
          path.join(import.meta.dirname, "oracle-runner.mjs"),
          exec,
          Buffer.from(JSON.stringify(c.tests)).toString("base64"),
        ],
        { cwd: exec, workspace: c.workspace, signal, timeout: 20000 },
      );
      output = this.redact(r.output);
      code = r.code;
    } catch (e) {
      error = this.redact(e.message);
      uncertain = e.terminationUnconfirmed === true;
    }
    let unchanged = true;
    try {
      await this.assertSeal({
        ...c,
        directory: exec,
        candidateHash: digest(canonical(executionFiles)),
      });
    } catch {
      unchanged = false;
    }
    let report;
    try {
      report = JSON.parse(output);
    } catch {}
    const count = report?.counts?.tests ?? -1,
      fail = report?.counts?.failed ?? -1,
      pass = report?.counts?.passed ?? -1;
    const complete =
      count > 0 &&
      report.counts.cancelled === 0 &&
      report.counts.skipped === 0 &&
      report.counts.todo === 0 &&
      count === pass + fail;
    const sandboxed =
      Array.isArray(report?.sandbox) &&
      report.sandbox.length === c.tests.length &&
      report.sandbox.every(
        (p) =>
          p.attested &&
          p.drained === true &&
          !p.error &&
          p.metadata?.capabilities === 0 &&
          p.metadata?.network === "deny",
      );
    const status =
      !error &&
      unchanged &&
      complete &&
      sandboxed &&
      code === 0 &&
      report.success === true &&
      fail === 0
        ? "PASS"
        : !error &&
            unchanged &&
            complete &&
            sandboxed &&
            report.success === false &&
            fail > 0 &&
            report.assertion &&
            !report.unavailable
          ? "FAIL"
          : "UNAVAILABLE";
    const receipt = {
      id: randomUUID(),
      kind: "node-test-oracle/v1",
      status,
      candidateHash: digest(files),
      oracleHash: c.oracleHash,
      runtime: report?.node,
      validatorHash: await this.validatorHash(),
      testIdentityHash: digest(report?.identities || []),
      executable: this.nodeExecutable,
      count,
      pass,
      fail,
      code,
      unchanged,
      output: output.slice(-16000),
      sandbox: report?.sandbox,
      error,
      at: new Date().toISOString(),
      limitations:
        "Windows AppContainer zero network capabilities, readonly snapshot/runtime, inherited handle allowlist, Job768MiB/8process. Not a VM or kernel-exploit guarantee; acceptance still bounded by pinned trusted oracle.",
    };
    if (uncertain) receipt.retainedExecution = exec;
    else await fs.rm(exec, { recursive: true, force: true });
    return receipt;
  }
  async repair(id, { signal } = {}) {
    if (this.busy) throw Error("An improvement is already running");
    let c = await this.get(id);
    if (c.status !== "created")
      throw Error("Repair state is not created (hold is not replayed)");
    this.busy = true;
    try {
      c.status = "reproducing";
      this.save(c);
      c.baseVerdict = await this.executeOracle(c, c.base, signal);
      c.receipts.push(c.baseVerdict);
      this.save(c);
      if (c.baseVerdict.status !== "FAIL")
        throw Error(
          "Defect not reproduced by assertion: baseline must FAIL, not PASS/UNAVAILABLE",
        );
      for (let attempt = 1; attempt <= 2; attempt++) {
        signal?.throwIfAborted();
        await this.assertBase(c);
        const current = await this.get(id);
        if (current.status === "hold")
          throw Error("Recovery hold: operation interrupted");
        c.attempts = attempt;
        c.status = "making";
        this.save(c);
        const proposal = await this.maker({
          goal: c.goal,
          files: structuredClone(c.base),
          editable: c.editable,
          tests: c.tests,
          feedback: (c.verdict || c.baseVerdict).output,
          attempt,
          signal,
        });
        signal?.throwIfAborted();
        if ((await this.get(id)).status === "hold")
          throw Error("Recovery hold: operation interrupted");
        if (
          !proposal ||
          Object.keys(proposal).some((k) => k !== "patches") ||
          !Array.isArray(proposal.patches) ||
          !proposal.patches.length ||
          proposal.patches.length > 12
        )
          throw Error(
            "Invalid patch proposal; unexpected fields or empty patch",
          );
        const candidate = { ...c.base };
        for (const patch of proposal.patches) {
          if (
            !patch ||
            Object.keys(patch).sort().join(",") !== "after,before,path" ||
            !c.editable.includes(patch.path) ||
            typeof patch.before !== "string" ||
            !patch.before ||
            typeof patch.after !== "string" ||
            Buffer.byteLength(patch.after) > 131072 ||
            candidate[patch.path].split(patch.before).length !== 2
          )
            throw Error(
              "Patch violates immutable scope or exact-match precondition",
            );
          candidate[patch.path] = candidate[patch.path].replace(
            patch.before,
            patch.after,
          );
          if (
            Buffer.byteLength(candidate[patch.path]) > 131072 ||
            this.redact(candidate[patch.path]) !== candidate[patch.path]
          )
            throw Error(
              "Patch exceeds bound or contains credential-like content",
            );
        }
        c.candidate = canonical(candidate);
        c.candidateHash = digest(c.candidate);
        c.status = "validating";
        this.save(c);
        c.verdict = await this.executeOracle(c, c.candidate, signal);
        c.receipts.push(c.verdict);
        if (
          c.verdict.count !== c.baseVerdict.count ||
          c.verdict.testIdentityHash !== c.baseVerdict.testIdentityHash
        ) {
          c.verdict.status = "UNAVAILABLE";
          c.verdict.error =
            "Oracle test identities changed; early exit or missing tests";
        }
        if (
          c.verdict.status === "PASS" &&
          c.verdict.count === c.baseVerdict.count
        ) {
          await fs.rm(c.directory, { recursive: true, force: true });
          await this.materialize(c.directory, c.candidate);
          await this.assertSeal(c);
          c.status = "validated";
          return this.public(this.save(c));
        }
        if (c.verdict.status === "UNAVAILABLE")
          throw Error("Validator unavailable; cannot accept or blindly retry");
        this.save(c);
      }
      throw Error("Two repairs failed; manual diagnosis required");
    } catch (e) {
      c.status = "hold";
      c.error = this.redact(e.message);
      return this.public(this.save(c));
    } finally {
      this.busy = false;
    }
  }
  async activate(id, { candidateHash, verdictId }) {
    const c = await this.get(id);
    if (
      c.status !== "validated" ||
      candidateHash !== c.candidateHash ||
      c.verdict?.id !== verdictId ||
      c.verdict.status !== "PASS" ||
      c.verdict.candidateHash !== candidateHash ||
      c.verdict.oracleHash !== c.oracleHash
    )
      throw Error(
        "Activation requires current host PASS receipt and candidate hash",
      );
    await this.assertSeal(c);
    await this.assertBase(c);
    if (c.verdict.validatorHash !== (await this.validatorHash()))
      throw Error("Validator version changed; receipt is stale");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT id FROM active WHERE workspace=?")
        .get(c.workspace);
      if (prior && prior.id !== c.id) {
        const previous = await this.get(prior.id);
        previous.status = "retained";
        this.save(previous);
        c.previousId = prior.id;
      }
      c.status = "active";
      c.activated = new Date().toISOString();
      this.save(c);
      this.db
        .prepare(
          "INSERT INTO active VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET id=excluded.id",
        )
        .run(c.workspace, c.id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.public(c);
  }
  async active(workspace) {
    const row = this.db
      .prepare("SELECT id FROM active WHERE workspace=?")
      .get(await fs.realpath(workspace));
    if (!row) return null;
    const c = await this.get(row.id);
    await this.assertSeal(c);
    return this.public(c);
  }
  async validatorHash() {
    return digest({
      source: await Promise.all(
        [
          "oracle-runner.mjs",
          "oracle-preload.cjs",
          "engine.mjs",
          "active-runner.mjs",
          "../sandbox/windows.mjs",
          "../sandbox/appcontainer.ps1",
          "../sandbox/test-broker.mjs",
          "../sandbox/runtime-cache.mjs",
          "../sandbox/boundary-policy.mjs",
          "../sandbox/stream-control.mjs",
          "../sandbox/leases.mjs",
          "../tools/process.mjs",
          "../tools/workspace.mjs",
          "../recovery/executor.mjs",
          "../recovery/journal.mjs",
          "../recovery/windows-job.ps1",
          "../recovery/process-identity.ps1",
          "../recovery/mcp-job.ps1",
          "../recovery/native-loader.ps1",
          "../recovery/native-artifact.mjs",
          "../recovery/native-layout.mjs",
          "../recovery/native-entry.cs",
          "../recovery/native-job-tree.cs",
          "../core/integrity.mjs",
          "../../scripts/build-native.mjs",
          "../../scripts/build-native.ps1",
          "../sandbox/v8-frame-guard.mjs",
        ].map(async (p) => ({
          path: p,
          sha256: contentHash(
            await fs.readFile(path.join(import.meta.dirname, p)),
            "text-lf",
          ),
        })),
      ),
      // A rebuild invalidates prior receipts even when portable source is unchanged.
      local: await Promise.all(
        [
          ...nativeNames.flatMap((name) => [
            name + ".exe",
            name + ".dll",
            name + ".json",
          ]),
          "node-runtime.json",
        ].map(async (name) => ({
          path: "local-native/" + name,
          sha256: contentHash(
            await fs.readFile(path.join(nativeDirectory(), name)),
            "binary-raw",
          ),
        })),
      ),
    });
  }
  async recoverActive(workspace) {
    const pointer = this.db
      .prepare("SELECT id FROM active WHERE workspace=?")
      .get(workspace);
    if (!pointer) return null;
    const c = await this.get(pointer.id);
    try {
      await this.assertSeal(c);
      return this.public(c);
    } catch (error) {
      c.status = "hold";
      c.error = "Active snapshot changed; no code replay. " + error.message;
      this.save(c);
      let previous;
      try {
        if (c.previousId) {
          previous = await this.get(c.previousId);
          await this.assertSeal(previous);
          if (
            previous.verdict?.status !== "PASS" ||
            previous.verdict.candidateHash !== previous.candidateHash
          )
            previous = null;
        }
      } catch {
        previous = null;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        if (previous) {
          previous.status = "active";
          previous.recoveredFrom = c.id;
          this.save(previous);
          this.db
            .prepare("UPDATE active SET id=? WHERE workspace=?")
            .run(previous.id, workspace);
        } else
          this.db
            .prepare("DELETE FROM active WHERE workspace=?")
            .run(workspace);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return previous ? this.public(previous) : null;
    }
  }
  async testActive(workspace, { signal, expectedId, expectedHash } = {}) {
    const active = await this.active(workspace);
    if (
      !active ||
      (expectedId && active.id !== expectedId) ||
      (expectedHash && active.candidateHash !== expectedHash)
    )
      throw Error("Active candidate identity changed");
    const c = await this.get(active.id);
    if (c.baseVerdict.validatorHash !== (await this.validatorHash())) {
      c.baseVerdict = await this.executeOracle(c, c.base, signal);
      c.receipts.push(c.baseVerdict);
    }
    const verdict = await this.executeOracle(c, c.candidate, signal);
    if (
      c.baseVerdict.status !== "FAIL" ||
      verdict.status !== "PASS" ||
      verdict.count !== c.baseVerdict.count ||
      verdict.testIdentityHash !== c.baseVerdict.testIdentityHash
    ) {
      verdict.status = "UNAVAILABLE";
      c.status = "hold";
      c.error = "Active version failed revalidation";
      this.db.prepare("DELETE FROM active WHERE workspace=?").run(c.workspace);
    } else c.verdict = verdict;
    c.receipts.push(verdict);
    this.save(c);
    return verdict;
  }
  async runActive(
    workspace,
    { id, candidateHash, module, exportName, args, signal },
  ) {
    const active = await this.active(workspace);
    if (!active || active.id !== id || active.candidateHash !== candidateHash)
      throw Error("Active candidate identity changed");
    const c = await this.get(id);
    if (
      !c.editable.includes(module) ||
      !/^[$A-Z_a-z][$\w]*$/.test(exportName) ||
      !Array.isArray(args) ||
      Buffer.byteLength(JSON.stringify(args)) > 16000
    )
      throw Error("Invalid active invocation scope or size");
    if (c.verdict?.validatorHash !== (await this.validatorHash()))
      throw Error(
        "Active validator version changed; revalidate before invocation",
      );
    const exec = path.join(this.root, "executions", randomUUID());
    await this.materialize(exec, {
      ...c.candidate,
      ".migan-oracle/active-runner.mjs": await fs.readFile(
        path.join(import.meta.dirname, "active-runner.mjs"),
        "utf8",
      ),
    });
    let uncertain = false;
    try {
      const call = Buffer.from(
        JSON.stringify({ module, exportName, args }),
      ).toString("base64");
      const sandbox = new WindowsSandbox({
        root: this.root,
        nodeExecutable: this.nodeExecutable,
        journal: this.journal,
      });
      const r = await sandbox.run({
        execution: exec,
        script: ".migan-oracle/active-runner.mjs",
        args: [exec, call],
        workspace: c.workspace,
        signal,
        timeout: 20000,
      });
      if (r.code !== 0)
        throw Error(
          "Active invocation failed: " + this.redact(r.output).slice(-2000),
        );
      const result = JSON.parse(r.output);
      if (result.version !== 1) throw Error("Invalid active invocation result");
      return { candidateId: id, candidateHash, result: result.result };
    } catch (error) {
      uncertain = error.terminationUnconfirmed === true;
      if (uncertain) error.retainedExecution = exec;
      throw error;
    } finally {
      if (!uncertain) await fs.rm(exec, { recursive: true, force: true });
    }
  }
}
