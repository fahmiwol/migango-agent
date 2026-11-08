import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {isolatedWorktree} from '../core/worktree.mjs';
import {allowShell} from '../core/shell-allowlist.mjs';
import {ROUTES} from '../core/model-registry.mjs';
import {validasiSpek} from '../agents/format-keluaran.mjs';
import {nameTerminal, isSuccess, isKnownCode} from '../core/galat-terminal.mjs';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonical = value => {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export function createBridgeController({workspace, status, start, stop, loadRun,
  resolveApproval, redact = s => s, now = Date.now, capacity = 128, canGrantWrites = isolatedWorktree,
  maxActive = () => 1, switchWorkspace, checkBuildWrite}) {
  // Markas, 27 Oct 2026 (option b): in a bridge build run the bridge may grant write_file/edit_file
  // inside that run's buildTarget only, checked per file by the host, at most 50 writes / 5 MB.
  const AUTO_FILES = 50, AUTO_BYTES = 5 * 1024 * 1024, AUTO_VIA = 'otomatis-bridge-build';
  const OWNER_ONLY = new Set(['browser_click', 'browser_type']);
  const operations = new Map(), requests = new Map(), pending = new Map();
  // Markas, 27 Oct 2026: several runs may be active, one per workspace (one lock per workspace).
  const active = new Set();
  // Owner limit: integer 1..3; anything else (hand-edited settings) falls back to 1.
  const limit = () => {
    let n;
    try { n = maxActive(); } catch { n = 1; }
    return Number.isInteger(n) && n >= 1 && n <= 3 ? n : 1;
  };
  const same = (a, b) => canonical(a) === canonical(b);
  const activeIn = ws => [...active].find(op => same(op.workspace, ws));
  const checkWorkspace = expected => {
    if (typeof expected !== 'string' || !path.isAbsolute(expected) ||
        canonical(expected) !== canonical(workspace())) throw Error('Expected workspace does not match the app workspace');
  };
  // A workspace the bridge may act in: the app workspace, or the fixed worktree of an operation.
  const known = ws => typeof ws === 'string' && path.isAbsolute(ws) &&
    (same(ws, workspace()) || [...operations.values()].some(op => op.secondary && same(op.workspace, ws)));
  // P01 (RISET-066): every terminal outcome that is not a success carries a named, safe { code, message }.
  // `cause` is what the caller knows ({code, message}); an empty message is filled from the code and
  // marked `generic`, so a later result call may replace it with the run record's own error.
  const finish = (op, status, cause = {}) => {
    op.status = status || 'unknown'; active.delete(op);
    const named = nameTerminal({status: op.status, code: cause.code, message: cause.message,
      hasRun: Boolean(op.runId), redact});
    if (named) { op.code = named.code; op.error = named.message; op.generic = !String(cause.message ?? '').trim(); }
  };
  const publicOperation = op => ({operationId:op.id, requestId:op.requestId,
    workspace:op.workspace, runId:op.runId || null, status:op.status, code:op.code || null, error:op.error || null});
  const getOperation = id => {
    const op = operations.get(id);
    if (!op) throw Error('Unknown operationId in this app session');
    // A secondary run keeps the worktree fixed at start; the primary run follows the app workspace.
    if (!op.secondary) checkWorkspace(op.workspace);
    return op;
  };
  // Attribution: by runId, then by workspace on the event, then the single active run. With several
  // active runs and nothing to tell them apart the event is not attributed (fail closed).
  const owner = event => {
    const list = [...active];
    if (event.runId) return list.find(op => op.runId === event.runId);
    if (typeof event.workspace === 'string') return activeIn(event.workspace);
    return list.length === 1 ? list[0] : undefined;
  };
  const observe = event => {
    if (event.type === 'start') {
      const waiting = [...active].filter(op => !op.runId);
      const op = typeof event.workspace === 'string' ? waiting.find(o => same(o.workspace, event.workspace))
        : waiting.length === 1 && active.size === 1 ? waiting[0] : undefined;
      if (op) op.runId = event.id;
    }
    if (event.type === 'finish' && event.runId) {
      const op = [...active].find(o => o.runId === event.runId);
      if (op) finish(op, event.status, {code:event.errorCode, message:event.error});
    }
    if (event.type === 'approval') {
      const op = owner(event);
      if (op) pending.set(event.id, {
        id:event.id, tool:event.tool, args:structuredClone(event.args),
        expiresAt:event.expiresAt, workspace:op.workspace, operationId:op.id,
        digest:hash([event.id, event.tool, event.args, event.expiresAt, op.workspace]),
      });
    }
    if (event.type === 'approval-closed') pending.delete(event.id);
  };
  const execute = async (method, p = {}) => {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw Error('Expected params object');
    switch (method) {
      case 'status': return status();
      case 'start': {
        if (typeof p.expectedWorkspace !== 'string' || !path.isAbsolute(p.expectedWorkspace))
          throw Error('Expected workspace does not match the app workspace');
        if (!uuid.test(p.requestId || '')) throw Error('requestId must be a UUID');
        if (typeof p.prompt !== 'string' || p.prompt.trim().length < 2 || p.prompt.length > 12000)
          throw Error('Prompt must contain 2..12000 characters');
        if (p.modelId !== undefined && !/^[a-zA-Z0-9_-]{1,60}$/.test(p.modelId)) throw Error('Invalid modelId');
        // Per-run hard stop for lap runners (markas, 27 Oct 2026); the runtime keeps the lower of this
        // and the owner's maxTurns, so the bridge can only shorten a run.
        if (p.maxTurns !== undefined && (!Number.isSafeInteger(p.maxTurns) || p.maxTurns < 1 || p.maxTurns > 60))
          throw Error('maxTurns must be an integer 1..60');
        // D3: one-task permission to use a cloud stand-in if the chosen local model is unreachable.
        if (p.izinkanCadangan !== undefined && typeof p.izinkanCadangan !== 'boolean')
          throw Error('izinkanCadangan must be a boolean');
        if (!['ask','work','build'].includes(p.mode)) throw Error('Only ask/work/build modes are available');
        // Build (markas, 27 Oct 2026): only with an absolute buildTarget, only on the app workspace.
        // The host checks the target after realpath against the owner's devRoots before any run.
        if (p.mode !== 'build' && p.buildTarget !== undefined) throw Error('buildTarget is only for build mode');
        if (p.mode === 'build' && (typeof p.buildTarget !== 'string' || !p.buildTarget || p.buildTarget.length > 500 ||
            !path.isAbsolute(p.buildTarget) || /[\u0000-\u001f]/.test(p.buildTarget)))
          throw Error('build mode needs an absolute buildTarget');
        // The caller may name the task route (owner override); keyword rules misread long task
        // prompts, e.g. a coding task about OCR was refused as a visual task (27 Oct 2026).
        if (p.route !== undefined && p.route !== 'auto' && (typeof p.route !== 'string' || !Object.hasOwn(ROUTES, p.route)))
          throw Error('route must be one of: ' + Object.keys(ROUTES).join(', '));
        // Optional run title (1..80 characters after trimming, no control characters).
        let title;
        if (p.title !== undefined) {
          if (typeof p.title !== 'string' || /[\u0000-\u001f\u007f]/.test(p.title) ||
              p.title.trim().length < 1 || p.title.trim().length > 80)
            throw Error('title must be a string of 1..80 characters without line breaks');
          title = p.title.trim();
        }
        // 06v4: optional output format spec, checked before any run (refused, never ignored).
        if (p.format !== undefined) {
          const checked = validasiSpek(p.format);
          if (checked && checked.ok === false) throw Error('format: ' + String(checked.alasan || 'invalid spec'));
        }
        const fingerprint = hash([canonical(p.expectedWorkspace), p.prompt, p.mode, p.modelId || null, p.route && p.route !== 'auto' ? p.route : null, title || null, p.mode === 'build' ? canonical(p.buildTarget) : null, p.maxTurns ?? null, p.format ?? null, p.izinkanCadangan === true]);
        const previous = requests.get(p.requestId);
        if (previous) {
          if (previous.fingerprint !== fingerprint) throw Error('requestId was already used with different input');
          return publicOperation(operations.get(previous.id));
        }
        // Admission is synchronous (no await before the slot is taken), so concurrent starts
        // cannot both pass the limit or the workspace lock.
        const max = limit();
        const secondary = !same(p.expectedWorkspace, workspace());
        // With the default limit of one the bridge keeps its old rule: only the app workspace.
        if (secondary && max === 1) checkWorkspace(p.expectedWorkspace);
        if (secondary && p.mode === 'build') throw Error('build mode runs only in the app workspace');
        if (active.size >= max) throw Error('Active run limit reached (' + max + '); a bridge task is running');
        if (activeIn(p.expectedWorkspace)) throw Error('This workspace already has an active run');
        if (secondary && !canGrantWrites(p.expectedWorkspace).ok)
          throw Error('A second workspace must be an isolated git worktree on a non-main branch');
        if (operations.size >= capacity) throw Error('Session operation limit reached; restart only after active work is finished');
        const op = {id:randomUUID(), requestId:p.requestId, status:'starting', secondary,
          ...(p.mode === 'build' ? {buildTarget:path.resolve(p.buildTarget), auto:{files:0, bytes:0}} : {}),
          workspace:secondary ? path.resolve(p.expectedWorkspace) : workspace()};
        operations.set(op.id, op); requests.set(p.requestId, {id:op.id, fingerprint}); active.add(op);
        const failed = error => finish(op, 'failed', {code:error?.code, message:error?.message ?? error});
        try {
          // The run's workspace goes in a separate argument, never inside the model payload.
          const task = start({prompt:p.prompt,mode:p.mode,...(p.modelId ? {modelId:p.modelId,routingMode:'auto'} : {}),
            ...(p.route && p.route !== 'auto' ? {routeOverride:p.route} : {}),
            ...(p.mode === 'build' ? {bridgeBuildTarget:path.resolve(p.buildTarget)} : {}),
            ...(p.maxTurns !== undefined ? {runTurnLimit:p.maxTurns} : {}),
            ...(p.izinkanCadangan === true ? {izinkanCadangan:true} : {}),
            ...(p.format !== undefined ? {format:structuredClone(p.format)} : {})},
            {operationId:op.id, workspace:op.workspace, origin:'bridge', ...(title ? {title} : {})});
          // The start promise resolves with {id, status} after the run ended. When the finish event could
          // not be attributed to this operation (the queue saw run.status undefined) it still tells us the
          // run id and the final status, so result can load the record.
          if (task?.then) void Promise.resolve(task).then(done => {
            if (!active.has(op)) return;
            if (typeof done?.id === 'string' && !op.runId) op.runId = done.id;
            finish(op, done?.status ?? 'finished');
          }, error => { if (active.has(op)) failed(error); });
          if (op.status === 'starting') op.status = 'running';
        } catch (error) { failed(error); }
        return publicOperation(op);
      }
      case 'operation': return publicOperation(getOperation(p.operationId));
      case 'result': {
        const op = getOperation(p.operationId);
        if (!op.runId) return {operation:publicOperation(op), run:null};
        const run = await loadRun(op.runId);
        if (!run) {
          // A run that "finished" but has no record cannot be shown to have succeeded.
          if (!active.has(op) && isSuccess(op.status)) finish(op, 'failed', {code:'ERR_NO_RUN_RECORD'});
          return {operation:publicOperation(op), run:null};
        }
        if (canonical(run.workspace) !== canonical(op.workspace)) throw Error('Result workspace mismatch');
        const status = typeof run.status === 'string' && run.status ? run.status : 'unknown';
        // Terminal and not a success: name it. While the operation is still active the record is not final.
        const named = active.has(op) ? null :
          nameTerminal({status, code:run.errorCode, message:run.error, hasRun:true, redact});
        if (named && op.generic && !isSuccess(op.status) && (String(run.error ?? '').trim() || isKnownCode(run.errorCode))) {
          op.code = named.code; op.error = named.message; op.generic = false;
        }
        // Explicit projection: no state, messages, events, vault, credentialId or arbitrary metadata.
        const result = {id:run.id, status, workspace:run.workspace,
          final:String(run.final || '').slice(0, 48000), error:named ? named.message : String(run.error || '').slice(0, 2000),
          ...(named ? {errorCode:named.code} : {}),
          usage:run.usage, validation:run.validation, agent:run.agent, routingPlan:run.routingPlan,
          profile:run.profile ? {provider:run.profile.provider, model:run.profile.model} : null};
        return JSON.parse(redact(JSON.stringify({operation:publicOperation(op), run:result})));
      }
      case 'stop': {
        const op = getOperation(p.operationId);
        if (typeof p.expectedWorkspace !== 'string' || !path.isAbsolute(p.expectedWorkspace) ||
            !same(p.expectedWorkspace, op.workspace)) throw Error('Expected workspace does not match the operation workspace');
        if (!active.has(op)) return {stopped:false, status:op.status};
        stop({operationId:op.id, runId:op.runId || null, workspace:op.workspace}); return {stopped:true};
      }
      case 'approvals': {
        if (p.operationId !== undefined) getOperation(p.operationId);
        const list = [];
        for (const [id, item] of pending) {
          if (item.expiresAt <= now()) { pending.delete(id); continue; }
          if (!known(item.workspace)) continue;
          if (p.operationId !== undefined && item.operationId !== p.operationId) continue;
          const text = JSON.stringify(item.args), visible = redact(text);
          const file = ['write_file', 'edit_file'].includes(item.tool);
          // Markas, 27 Oct 2026: an allowlisted shell command is approvable only in an isolated worktree.
          const shellOk = item.tool === 'shell' && canGrantWrites(item.workspace).ok &&
            allowShell(item.args?.command, {workspace:item.workspace}).ok;
          list.push({id, tool:item.tool, workspace:item.workspace, operationId:item.operationId,
            digest:item.digest, expiresAt:item.expiresAt,
            approvable:(file || shellOk) && visible === text && text.length <= 20000,
            argsPreview:visible.slice(0, 20000), truncated:visible.length > 20000});
        }
        return list;
      }
      case 'decide': {
        if (typeof p.expectedWorkspace !== 'string' || !path.isAbsolute(p.expectedWorkspace))
          throw Error('Expected workspace does not match the app workspace');
        const item = pending.get(p.id);
        if (!item || item.expiresAt <= now()) throw Error('Approval is not pending or has expired');
        // Approval stays per run: the caller must name the workspace of the run that asked.
        if (!known(item.workspace) || !same(item.workspace, p.expectedWorkspace)) throw Error('Approval workspace mismatch');
        if (p.operationId !== undefined && p.operationId !== item.operationId) throw Error('Approval operation mismatch');
        if (p.digest !== item.digest) throw Error('Approval digest mismatch');
        if (typeof p.yes !== 'boolean') throw Error('yes must be a boolean');
        // 27 Oct 2026: an automatic policy refusal (e.g. runner allowlist) is marked policy:true
        // with a short reason; it goes back to the model instead of ending the run.
        if (p.policy !== undefined) {
          if (p.policy !== true || p.yes !== false) throw Error('policy must be true and only with yes:false');
          if (typeof p.reason !== 'string' || !p.reason.trim() || p.reason.length > 200)
            throw Error('policy reason must contain 1..200 characters');
        }
        // 06xj: browser click/type act in the owner's logged-in sessions; only the owner approves them.
        if (p.yes && OWNER_ONLY.has(item.tool)) throw Error('browser_click/browser_type are approved only by the owner in the app');
        const view = (await execute('approvals')).find(row => row.id === p.id);
        if (p.yes && !view?.approvable) throw Error('Only complete unredacted file approvals or allowlisted shell commands in an isolated worktree can be granted by the bridge');
        // Markas, 26 Oct 2026: outside an isolated worktree on a non-main branch only the owner grants writes,
        // except the bridge build case below (27 Oct, option b).
        let via;
        if (p.yes && !canGrantWrites(item.workspace).ok) {
          const op = operations.get(item.operationId);
          if (!(['write_file', 'edit_file'].includes(item.tool) && op?.buildTarget && checkBuildWrite))
            throw Error('Bridge grants file writes only in an isolated git worktree on a non-main branch; the owner approves in the app');
          const bytes = Buffer.byteLength(String(item.args?.content ?? item.args?.after ?? ''), 'utf8');
          if (op.auto.files + 1 > AUTO_FILES || op.auto.bytes + bytes > AUTO_BYTES)
            throw Error('Bridge build write limit reached (50 writes / 5 MB per run); the owner approves further writes in the app');
          try { await checkBuildWrite(op.buildTarget, item.args?.path); }
          catch (error) { throw Error('Bridge build write refused: ' + redact(String(error.message)).slice(0, 200)); }
          op.auto.files++; op.auto.bytes += bytes; via = AUTO_VIA;
        }
        pending.delete(p.id);
        const policy = p.policy === true;
        const ok = policy ? resolveApproval(p.id, false, {policy:true, reason:p.reason}) : via ? resolveApproval(p.id, p.yes, {via}) : resolveApproval(p.id, p.yes);
        if (!ok) throw Error('Approval is no longer pending');
        return policy ? {resolved:true, approved:false, policy:true} : {resolved:true, approved:p.yes};
      }
      case 'switchWorkspace': {
        // 000b2: owner/bridge method only, never a model tool. The app-side switcher (folder-kerja
        // guard) checks devRoots, isolation and forbidden folders; here only shape and busy state.
        if (typeof switchWorkspace !== 'function') throw Error('Workspace switch is not available');
        checkWorkspace(p.expectedWorkspace);
        if (typeof p.to !== 'string' || !path.isAbsolute(p.to) || p.to.length > 500 || /[\u0000-\u001f]/.test(p.to))
          throw Error('Target must be an absolute path (max 500 characters)');
        const waiting = [...pending.values()].some(item => item.expiresAt > now());
        if (active.size > 0 || waiting)
          throw Object.assign(Error('Stop the active run and close pending approvals before switching workspace'), {code:'ERR_SWITCH_BUSY'});
        try {
          return await switchWorkspace(path.resolve(p.to));
        } catch (error) {
          throw Object.assign(Error(redact(String(error?.message)).slice(0, 300)),
            error?.code ? {code:String(error.code).slice(0, 40)} : {});
        }
      }
      default: throw Error('Unknown bridge operation');
    }
  };
  return {execute, observe};
}
