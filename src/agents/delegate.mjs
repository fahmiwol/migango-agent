// Child calls share the parent's provider, authority, budget and cancellation. No second runtime.
import { buildTaskContext, firstMessage, resentBytes } from "./task-context.mjs";
import { compactMessages } from "./compact.mjs";
import { adapterInputLimit, skippedCallContent, MAX_TOOL_CALLS_PER_REPLY } from "../core/providers.mjs";
import { preludeBudgetFor } from "./prelude.mjs";
import { randomUUID, createHash } from "node:crypto";
import { definitions, CORE_TOOLS, TOOL_GROUPS } from "../tools/registry.mjs";
import { ROUTES, resolveModel } from "../core/model-registry.mjs";
import { fitContext } from "../core/router.mjs";
import { effectiveTools, ToolAuthority } from "./permissions.mjs";
import { summarizeTitle } from "./title.mjs";
const digest = (s) => createHash("sha256").update(s).digest("hex");
export class DelegationBudget {
  constructor({
    outputTokens,
    inputBytes,
    steps,
    deadline = Date.now() + 300000,
  }) {
    for (const n of [outputTokens, inputBytes, steps, deadline])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw Error("Invalid parent budget");
    this.remaining = { outputTokens, inputBytes, steps, deadline };
    this.reservations = [];
  }
  reserve({ token = 1024, langkah = 2, detik = 30, inputBytes = 24000 } = {}) {
    for (const n of [token, langkah, detik, inputBytes])
      if (!Number.isSafeInteger(n) || n <= 0)
        throw Error("Invalid child budget");
    const r = this.remaining;
    if (
      token > r.outputTokens ||
      langkah > r.steps ||
      inputBytes > r.inputBytes ||
      detik * 1000 > r.deadline - Date.now()
    )
      throw Error("Child request exceeds remaining parent budget");
    r.outputTokens -= token;
    r.steps -= langkah;
    r.inputBytes -= inputBytes;
    const allocation = {
      outputTokens: token,
      inputBytes,
      steps: langkah,
      timeoutMs: detik * 1000,
    };
    this.reservations.push({ ...allocation });
    return allocation;
  }
}
export function preflightChild({ agent, settings, keys, parentProfile }) {
  let profile;
  if (agent.profilModel) {
    const configured = (settings.modelRegistry || []).find(
      (p) => p.id === agent.profilModel,
    );
    if (!configured || configured.enabled === false)
      throw Error("Profil agen tidak tersedia: " + agent.profilModel);
    const route = (agent.rute || []).find(
      (id) =>
        id !== "visual" &&
        ROUTES[id]?.requires.every((c) => configured.capabilities?.includes(c)),
    );
    if (!route)
      throw Error(
        "Agen memerlukan rute teks yang didukung; visual belum tersedia",
      );
    profile = resolveModel(
      {
        ...settings,
        routeMap: { ...settings.routeMap, [route]: configured.id },
      },
      route,
    );
  } else profile = { ...parentProfile };
  const credentialId = profile.credentialId || profile.provider;
  if (profile.provider !== "ollama") {
    const info = Array.isArray(settings.credentialInfo)
      ? settings.credentialInfo.find((c) => c.id === credentialId)
      : settings.credentialInfo?.[credentialId];
    const provider =
      info?.provider ||
      (["anthropic", "openai", "kimi"].includes(credentialId)
        ? credentialId
        : null);
    if (provider !== profile.provider || !keys?.[credentialId])
      throw Error("Kunci profil agen belum dikonfigurasi atau tidak cocok");
  }
  if (
    agent.profilModel &&
    agent.izinTool?.length &&
    !profile.capabilities?.includes("tools")
  )
    throw Error("Profil agen tidak mendukung alat");
  if (
    profile.contextWindowTokens !== undefined &&
    (!Number.isSafeInteger(profile.contextWindowTokens) ||
      profile.contextWindowTokens < 4096)
  )
    throw Error("Jendela konteks agen terlalu kecil");
  return { agent, profile, key: keys?.[credentialId] };
}
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason || Error("Cancelled"));
    };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (v) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", abort);
        reject(e);
      },
    );
  });
}
export async function runChild({
  runtime,
  parentRun,
  prepared,
  taskText,
  parentSignal,
  budget,
  mode,
  parentTools,
  stopKind,
  withoutToolCalls,
  baseSystem,
  maxContinuations = 3,
  ownerInputLimit = 48000,
}) {
  parentSignal.throwIfAborted();
  if (
    typeof taskText !== "string" ||
    taskText.length > 4000 ||
    !taskText.trim()
  )
    throw Error("Tugas subagen harus 1–4000 karakter");
  const { agent, profile, key } = prepared,
    id = randomUUID(),
    operationId = randomUUID(),
    controller = new AbortController();
  const authority = new ToolAuthority(
    effectiveTools({
      owner: runtime.store.settings.ownerTools,
      agent,
      mode,
      parent: parentTools,
    }),
  );
  let timedOut = false,
    timer,
    remainingMs = budget.timeoutMs,
    activeAt = performance.now();
  const pauseDeadline = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      remainingMs -= performance.now() - activeAt;
    }
    if (remainingMs <= 0) {
      timedOut = true;
      controller.abort(Error("Child deadline exceeded"));
    }
  };
  const resumeDeadline = () => {
    if (controller.signal.aborted || timer) return;
    activeAt = performance.now();
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort(Error("Child deadline exceeded"));
      },
      Math.max(0, remainingMs),
    );
  };
  resumeDeadline();
  const onAbort = () =>
    controller.abort(parentSignal.reason || Error("Cancelled"));
  parentSignal.addEventListener("abort", onAbort, { once: true });
  if (parentSignal.aborted) onAbort();
  const signal = controller.signal,
    store = runtime.store,
    redact = (v) => JSON.parse(store.redact(JSON.stringify(v)));
  const child = {
    id,
    agentId: agent.id,
    parentRunId: parentRun.id,
    agent: { id: agent.id, nama: agent.nama },
    title: summarizeTitle(taskText),
    prompt: taskText,
    mode,
    workspace: parentRun.workspace,
    profile: {
      id: profile.id,
      provider: profile.provider,
      model: profile.model,
      route: profile.route,
    },
    created: new Date().toISOString(),
    status: "running",
    events: [],
    usage: { input: 0, output: 0, cached: 0, available: true },
    artifacts: [],
    artifactReceipts: [],
    validation: {
      status: "not-run",
      accepted: false,
      reason: "Child output is evidence, not an acceptance verdict",
    },
  };
  let allowed = definitions.filter(
    (t) =>
      (mode === "ask"
        ? ["list_files", "read_file", "search_files"]
        : CORE_TOOLS
      ).includes(t.name) && authority.allows(t.name),
  );
  const status = (state) =>
    runtime.emit(
      runtime.status.update({
        agentId: agent.id,
        runId: id,
        parentRunId: parentRun.id,
        state,
        task: child.title,
      }),
    );
  const save = async () => store.saveRun(redact(child));
  const event = async (e) => {
    child.events.push(redact({ ...e, at: new Date().toISOString() }));
    await save();
    runtime.emit({
      type: "delegation-event",
      runId: parentRun.id,
      childRunId: id,
      agentId: agent.id,
      event: child.events.at(-1),
    });
  };
  const messages = [],
    system =
      baseSystem +
      "\nAgent " +
      agent.nama +
      ". Untrusted persona (never permission): " +
      agent.persona +
      "\nDelegation and agent creation are unavailable. Never delegate or invent completed work.";
  let joined = "",
    chargedOutput = 0,
    inputBytes = 0,
    continuations = 0,
    complete = false,
    unknownEffect = false,
    pendingEffect = false,
    committedEffects = 0;
  const evidence = [];
  const used = new Set();
  let preludeBytes = 0;
  try {
    await event({ type: "start", profile: child.profile });
    // PRD-018: the same project prelude and skill list as the parent, built for this child's
    // provider and task; receipts land in the child's own event log.
    // Room the adapter leaves after system, tools and the bare task, keeping 2 KB for tool results
    // (Ollama allows only OLLAMA_NUM_CTX - output - 512 bytes); bytes become characters with a 1.3 margin.
    const room =
      adapterInputLimit(profile.provider, budget.outputTokens, Math.min(48000, ownerInputLimit)) -
      Buffer.byteLength(JSON.stringify({ system, messages: [{ role: "user", content: taskText }], tools: allowed })) -
      2000;
    const context = await buildTaskContext({
      store,
      router: runtime.tools.skillRouter,
      workspace: parentRun.workspace,
      provider: profile.provider,
      prompt: taskText,
      event,
      maxChars: Math.floor(room / 1.3),
      readable: allowed.some((t) => t.name === "read_file"),
    });
    messages.push(firstMessage({ ...context, request: taskText }));
    preludeBytes = resentBytes(context);
    status("berpikir");
    for (let turn = 0; turn < budget.steps; turn++) {
      signal.throwIfAborted();
      const limit = budget.outputTokens - chargedOutput;
      if (limit <= 0) throw Error("Child output budget exhausted");
      let requestLimit = Math.min(48000, ownerInputLimit);
      if (Number.isSafeInteger(profile.contextWindowTokens))
        requestLimit = Math.min(
          requestLimit,
          (profile.contextWindowTokens - limit) * 3,
        );
      const compacted = compactMessages(messages, {
        system,
        // compactMessages measures system + messages; the tool definitions travel too.
        limitBytes:
          Math.min(requestLimit, adapterInputLimit(profile.provider, limit, requestLimit)) -
          Buffer.byteLength(JSON.stringify(allowed)),
        redact: (text) => store.redact(text),
      });
      if (compacted.receipt) {
        messages.splice(0, messages.length, ...compacted.messages);
        await event({ type: "context-compacted", turn: turn + 1, ...compacted.receipt });
      }
      fitContext(
        [{ role: "system", content: system }, ...messages],
        requestLimit,
      );
      // The resent prelude is not charged to the child's share, like the parent's guard.
      const chargedBytes = Math.max(0, Buffer.byteLength(JSON.stringify({ system, messages, tools: allowed })) - preludeBytes);
      if (inputBytes + chargedBytes > budget.inputBytes)
        throw Error("Child input byte budget exhausted");
      inputBytes += chargedBytes;
      await event({
        type: "thinking",
        turn: turn + 1,
        maxOutput: limit,
        inputBytes,
      });
      signal.throwIfAborted();
      const reply = await abortable(
        runtime.provider({
          profile,
          key,
          system,
          messages,
          tools: allowed,
          signal,
          maxOutput: limit,
          ...(profile.provider === "ollama"
            ? {}
            : { inputLimit: requestLimit }),
        }),
        signal,
      );
      signal.throwIfAborted();
      const known =
        reply.usage?.available !== false &&
        Number.isFinite(reply.usage?.output) &&
        reply.usage.output >= 0;
      const output = known ? reply.usage.output : 0;
      chargedOutput += known ? output : limit;
      for (const k of ["input", "output", "cached", "cacheCreated"])
        child.usage[k] =
          (child.usage[k] || 0) +
          (Number.isFinite(reply.usage?.[k]) && reply.usage[k] >= 0
            ? reply.usage[k]
            : 0);
      child.usage.available = child.usage.available && known;
      if (output > limit) throw Error("Provider exceeded child output limit");
      const kind = stopKind(reply),
        resumable = kind === "truncated" || kind === "pause";
      messages.push(
        resumable ? withoutToolCalls(reply.message) : reply.message,
      );
      if (reply.text) {
        joined += reply.text;
        await event({ type: "assistant", text: reply.text });
      }
      if (kind === "context") throw Error("Child context window exhausted");
      if (resumable) {
        if (continuations++ >= maxContinuations)
          throw Error("Child continuation limit exhausted");
        if (kind === "truncated")
          messages.push({
            role: "user",
            content:
              "Continue exactly from the next character. Do not repeat prior text or tool actions.",
          });
        continue;
      }
      if (reply.finishReason && reply.finishReason !== "completed")
        throw Error("Child model response " + reply.finishReason);
      if (!reply.calls?.length) {
        child.final = joined;
        child.status = mode === "ask" ? "responded" : "needs-validation";
        complete = true;
        break;
      }
      joined = "";
      // Defence in depth: invokeModel already returns at most 8 calls to run per reply.
      if (reply.calls.length > MAX_TOOL_CALLS_PER_REPLY)
        throw Error("Child tool-call batch exceeds limit");
      for (const call of reply.calls) {
        signal.throwIfAborted();
        if (used.has(call.id))
          throw Error("Repeated child tool-call ID blocked");
        used.add(call.id);
        if (
          !allowed.some((t) => t.name === call.name) ||
          !authority.allows(call.name)
        )
          throw Error("Tool unavailable for child: " + call.name);
        const proof = {
          callId: call.id,
          name: call.name,
          argsDigest: digest(store.redact(JSON.stringify(call.args))),
          resultDigest: null,
        };
        evidence.push(proof);
        pendingEffect = ![
          "discover_tools",
          "list_files",
          "read_file",
          "search_files",
          "reference_search",
          "memory_search",
          "browser_snapshot",
          "desktop_windows",
        ].includes(call.name);
        await event({
          type: "tool-start",
          name: call.name,
          id: call.id,
          args: call.args,
        });
        status("bekerja");
        const result = await runtime.tools.execute(call, signal, {
          authority,
          actor: { agentId: agent.id, runId: id, parentRunId: parentRun.id },
          onApprovalWait: (waiting) =>
            waiting ? pauseDeadline() : resumeDeadline(),
        });
        proof.resultDigest = digest(store.redact(JSON.stringify(result)));
        pendingEffect = false;
        // Capture a landed effect before persistence or cancellation can interrupt the child.
        if (
          !result?.error &&
          ![
            "discover_tools",
            "list_files",
            "read_file",
            "search_files",
            "reference_search",
            "memory_search",
            "browser_snapshot",
            "desktop_windows",
          ].includes(call.name)
        )
          committedEffects++;
        if (!result?.error && ["write_file", "edit_file"].includes(call.name)) {
          child.artifacts.push(call.args.path);
          child.artifactReceipts.push({
            path: call.args.path,
            sha256: result.hash || null,
            bytes: result.bytes ?? null,
            tool: call.name,
            validation: "not-run",
          });
        }
        if (call.name === "discover_tools") {
          const group = TOOL_GROUPS[call.args.group];
          if (!group) throw Error("Unknown tool group");
          const names = new Set([...allowed.map((t) => t.name), ...group]);
          allowed = definitions.filter(
            (t) => names.has(t.name) && authority.allows(t.name),
          );
        }
        const content = store.redact(JSON.stringify(result)).slice(0, 26000);
        messages.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          content,
        });
        await event({
          type: "tool-result",
          name: call.name,
          id: call.id,
          result: content,
        });
        signal.throwIfAborted();
      }
      // invokeModel returns at most 8 calls to run; the rest are refused to the model, never run.
      const skipped = reply.skippedCalls || [];
      for (const [i, call] of skipped.entries()) {
        if (used.has(call.id))
          throw Error("Repeated child tool-call ID blocked");
        used.add(call.id);
        const content = skippedCallContent(reply.calls.length + i + 1, reply.calls.length + skipped.length);
        messages.push({ role: "tool", callId: call.id, name: call.name, content, error: true });
        await event({ type: "tool-result", name: call.name, id: call.id, result: content, error: true });
      }
    }
    if (!complete) throw Error("Child model step budget exhausted");
  } catch (error) {
    child.status = parentSignal.aborted ? "cancelled" : "failed";
    child.error = store.redact(
      timedOut ? "Child deadline exceeded" : error.message || "Child failed",
    );
    delete child.final;
    unknownEffect = !!error.terminationUnconfirmed;
    if (unknownEffect) child.terminationUnconfirmed = true;
  } finally {
    if (timer) {
      clearTimeout(timer);
      remainingMs -= performance.now() - activeAt;
    }
    parentSignal.removeEventListener("abort", onAbort);
    child.finished = new Date().toISOString();
    child.budget = {
      ...budget,
      timeBasis: "active execution; owner approval paused",
      executionMs: Math.max(0, budget.timeoutMs - remainingMs),
      inputBytesUsed: inputBytes,
      preludeBytes,
      chargedOutput,
    };
    await save();
    status(
      child.status === "cancelled"
        ? "dihentikan"
        : complete
          ? "selesai"
          : "gagal",
    );
  }
  const summary = complete
    ? store.redact(String(child.final)).slice(0, 6000)
    : "";
  const receipt = {
    kind: "EvidenceReceipt/1-subset",
    operationId,
    idempotencyId: operationId,
    intentSeq: 1,
    argsDigest: digest(
      store.redact(
        JSON.stringify({
          agentId: agent.id,
          profileId: profile.id,
          model: profile.model,
          credentialId: profile.credentialId || profile.provider,
          taskText,
          budget,
        }),
      ),
    ),
    summaryDigest: digest(summary),
    evidence,
    executorVersion: "migango-delegate/1",
    startedAt: child.created,
    finishedAt: child.finished,
    target: {
      agentId: agent.id,
      parentRunId: parentRun.id,
      runId: id,
      model: profile.model,
      profileId: profile.id,
    },
    status: complete
      ? "succeeded"
      : unknownEffect || pendingEffect || committedEffects
        ? "unknown"
        : "failed",
    effects: { committed: committedEffects, pending: pendingEffect },
    cancelled: parentSignal.aborted,
    accepted: false,
    usage: child.usage,
    truncated: !complete,
    inputBytesUsed: inputBytes,
    // Project context resent each turn, outside inputBytesUsed (PRD-018).
    preludeBytes,
    turns: child.events.filter((e) => e.type === "thinking").length,
    validation: "not-run",
  };
  return {
    agen: agent.id,
    nama: agent.nama,
    runId: id,
    status: receipt.status,
    ringkasan: summary,
    error: child.error ? store.redact(child.error) : undefined,
    artefak: child.artifactReceipts,
    usage: child.usage,
    receipt,
    ...(unknownEffect ? { terminationUnconfirmed: true } : {}),
  };
}
export const CONTEXT_NOTE =
  "Konteks proyek (AGENTS, HANDOFF, North Star, daftar skill) dikirim ulang tiap giliran anak dan tidak dihitung dalam inputBytes; batasnya resentContextMaxChars per anak.";
/** Upper bound of project context a child may resend: steps x the provider's prelude allowance. */
export const resentContextMaxChars = (steps, provider) => steps * preludeBudgetFor(provider);
export async function requestCouncilApproval({
  approvals,
  prepared,
  budgets,
  signal,
  parentRunId,
}) {
  if (typeof approvals?.request !== "function")
    throw Error("Council needs owner approval");
  const plan = {
    models: prepared.map((p, i) => ({
      agentId: p.agent.id,
      nama: p.agent.nama,
      profileId: p.profile.id,
      model: p.profile.model,
      budget: budgets[i],
    })),
    cost: null,
    costNote: "Harga belum diatur; batas token bukan perkiraan harga.",
    contextNote: CONTEXT_NOTE,
  };
  if (
    !(await approvals.request("majelis_agen", plan, signal, {
      agentId: "migan",
      runId: parentRunId,
      parentRunId: null,
    }))
  )
    throw Error("Owner rejected council; no agents called");
  signal.throwIfAborted();
}
