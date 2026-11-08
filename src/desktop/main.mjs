import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  safeStorage,
  session as electronSession,
  shell,
  WebContentsView,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Store } from "../core/storage.mjs";
import { Approvals } from "../core/approvals.mjs";
import { Workspace } from "../tools/workspace.mjs";
import { MCP } from "../tools/mcp.mjs";
import { Tools } from "../tools/registry.mjs";
import { WindowsDesktop } from "../tools/windows.mjs";
import { createAppScreen } from "./screen-wiring.mjs";
import { AgentRuntime } from "../agents/runtime.mjs";
import { ControlledBrowser } from "./browser.mjs";
import { SkillLibrary } from "../tools/skills.mjs";
import { invokeModel } from "../core/providers.mjs";
import { chooseRoute } from "../core/router.mjs";
import { ContextStore } from "../memory/context-store.mjs";
import {
  readAnthropicCredential,
  readKimiCredential,
} from "../core/credential-import.mjs";
import { ReferenceLibrary } from "../research/references.mjs";
import { createHash } from "node:crypto";
import { gracefulShutdown } from "../core/shutdown.mjs";
import { REFERENCE_CATALOG } from "../research/catalog.mjs";
import { configureProcessRecovery } from "../tools/process.mjs";
import { ImprovementEngine } from "../improvement/engine.mjs";
import { opusMaker } from "../improvement/maker.mjs";
import { reconcileSandbox } from "../sandbox/leases.mjs";
import { assertNativeReady } from "../recovery/native-artifact.mjs";
import { createHoldSwitcher, holdMismatchMessage } from "./recovery-holds.mjs";
import { createHoldBannerLog } from "./hold-banner-log.mjs";
import {
  AgentStatusChannel,
  createReadOnlyIpc,
} from "./agent-status-channel.mjs";
import { openCatalog } from "../agents/catalog.mjs";
import { createWhatsNewIpc } from "./whats-new-ipc.mjs";
import { createTeamConfig } from "./agent-team-config.mjs";
import { startLocalBridge } from "./local-bridge.mjs";
import { openOptionalStore, openOptionalStoreAsync } from "./optional-store.mjs";
import {
  openRecoveryJournal,
  StartupBlockedError,
} from "./startup-recovery.mjs";
import { createBridgeController } from "./bridge-controller.mjs";
import { checkBridgeBuildTarget, checkBuildWriteTarget } from "./bridge-build.mjs";
import { withRunOrigin } from "./run-origin.mjs";
import { codeOfThrown } from "../core/galat-terminal.mjs";
// GATE D3 C1: errors thrown before a run exists (e.g. the D3 stop) keep their code for the renderer.
const galatKode = (error) => {
  const code = codeOfThrown(error);
  return code ? { code } : {};
};
import {
  checkSwitchTarget,
  createWorkspaceSwitcher,
  gitCommonDir,
} from "../core/folder-kerja.mjs";
import { createWindowIntent } from "./window-intent.mjs";
import {
  PREVIEW_SCHEME,
  PreviewRegistry,
  guestWebPreferences,
  hardenPreviewContents,
  hardenPreviewSession,
} from "./preview.mjs";
import {
  createProject,
  listDirectory,
  validateProjectName,
} from "./project-files.mjs";
import { SkillRouter } from "../agents/skill-router.mjs";
import { CostMeter } from "../core/cost-meter.mjs";
import {
  planProjectStandard,
  scaffoldProjectStandard,
  validateProfile,
} from "../core/project-standard.mjs";
const ui = path.resolve(import.meta.dirname, "../../ui/index.html");
const stableDataRoot = path.join(app.getPath("appData"), "migan-workbench");
app.setName("miganGO");
if (process.platform === "win32") app.setAppUserModelId("io.migan.migango");
app.setPath("userData", stableDataRoot);
if (!process.argv.includes("--hardware-acceleration"))
  app.disableHardwareAcceleration();
if (process.env.WORKBENCH_TEST_DATA)
  app.setPath("userData", path.resolve(process.env.WORKBENCH_TEST_DATA));
let window, store, tools, runtime, browser, mcp, approvals, context;
let localBridge, bridgeController;
const windowIntent = createWindowIntent(() => window);
let manualController;
let references;
// Startup status of the optional local stores (state, fixed reason, short codes).
let storeStatus = {};
let recovery, improvement;
let activeTask,
  manualTask,
  closing = false;
let statusChannel, statusIpc;
const send = (event) => {
  if (window && !window.isDestroyed())
    window.webContents.send("workbench-event", event);
};
// Replaced by statusChannel.wrap(send) once userData is known; captured callers keep working.
let forward = send;
// Canvas-like artifact previews (ARS-004 §13, K05): pure registry, Electron wiring below.
const previews = new PreviewRegistry();
let previewView = null,
  previewToken = null,
  previewRect = null,
  previewVisible = false;
const emit = (event) => {
  forward(event);
  runtime?.observe(event);
  bridgeController?.observe(event);
  for (const invalidated of previews.observe(event)) {
    forward(invalidated);
    // The open preview reloads itself after a finished write in its scope.
    if (invalidated.token === previewToken) previewView?.webContents.reload();
  }
};
// Must run before app ready: a standard, secure scheme so the guest gets its own origin per token.
if (PREVIEW_SCHEME !== "mgpreview") throw Error("Preview scheme mismatch");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mgpreview",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
function closePreviewView() {
  if (!previewView) return;
  window?.contentView.removeChildView(previewView);
  previewView.webContents.close();
  previewView = null;
  previewToken = null;
}
function layoutPreview() {
  if (!previewView || !previewRect) return;
  const bounds = window.getContentBounds();
  const x = Math.max(0, Math.min(Math.round(previewRect.x), bounds.width));
  const y = Math.max(0, Math.min(Math.round(previewRect.y), bounds.height));
  const width = Math.max(
    0,
    Math.min(Math.round(previewRect.width), bounds.width - x),
  );
  const height = Math.max(
    0,
    Math.min(Math.round(previewRect.height), bounds.height - y),
  );
  if (width > 0 && height > 0) previewView.setBounds({ x, y, width, height });
  previewView.setVisible(previewVisible);
}
async function showPreview({ token, rect, visible }) {
  if (typeof token !== "string" || !previews.has(token))
    throw Error("Unknown preview");
  for (const k of ["x", "y", "width", "height"])
    if (!Number.isFinite(rect?.[k])) throw Error("Invalid preview rectangle");
  previewRect = rect;
  previewVisible = visible === true;
  if (previewToken !== token) {
    closePreviewView();
    // In-memory partition per preview: nothing persists and nothing is shared with the app or browser.
    const guest = electronSession.fromPartition("preview-" + token);
    hardenPreviewSession(guest, token);
    guest.protocol.handle(PREVIEW_SCHEME, async (request) => {
      const r = await previews.respond(request.url);
      return new Response(r.data, {
        status: r.status,
        headers: { "Content-Type": r.mimeType, ...r.headers },
      });
    });
    previewView = new WebContentsView({
      webPreferences: guestWebPreferences(guest),
    });
    hardenPreviewContents(previewView.webContents, token);
    window.contentView.addChildView(previewView);
    previewToken = token;
    layoutPreview();
    await previewView.webContents.loadURL(previews.urlOf(token));
  }
  layoutPreview();
}
async function useWorkspace(root) {
  if (runtime?.active || activeTask || manualController)
    throw Error("Stop current operation before changing workspace");
  await store.setWorkspace(root);
  tools.workspace = new Workspace(root);
  tools.skills = new SkillLibrary(root, [
    path.resolve(import.meta.dirname, "../../.agents/skills"),
  ]);
  await mcp.close();
  closePreviewView();
  previews.closeAll();
}
// 000b2: git common dir of the app's own repo; null (switch refused) when it cannot be read.
let repoCommonDirCache;
function appRepoCommonDir() {
  if (repoCommonDirCache === undefined) {
    try {
      repoCommonDirCache = gitCommonDir(app.getAppPath());
    } catch {
      repoCommonDirCache = null;
    }
  }
  return repoCommonDirCache;
}
if (
  !app.requestSingleInstanceLock({
    intent: process.argv.includes("--background") ? "background" : "show",
  })
)
  app.quit();
else {
  app.on("second-instance", (_event, commandLine, _directory, data) =>
    windowIntent.request(commandLine, data),
  );
  app
    .whenReady()
    .then(async () => {
      assertNativeReady();
      store = new Store(app.getPath("userData"), safeStorage);
      // PRD-019: one meter for every paid call (runtime, team children, repair maker, connection test).
      const costMeter = new CostMeter({ root: store.root, settings: () => store.settings });
      const firstRun = !(
        await Promise.all(
          ["state.json", "settings.json"].map((name) =>
            fs.access(path.join(store.root, name)).then(
              () => true,
              () => false,
            ),
          ),
        )
      ).some(Boolean);
      await store.init();
      // Read-only agen.status channel for external readers (ARS-004 §2, D-005).
      statusChannel = await new AgentStatusChannel({ root: store.root }).open();
      forward = statusChannel.wrap(send);
      // Fail-closed by design: a broken journal stops startup with plain safe steps.
      recovery = await openRecoveryJournal(path.join(store.root, "recovery.db"));
      await reconcileSandbox();
      configureProcessRecovery(recovery);
      // A broken improvement.db (SQLite error or an unreadable stored row) turns the feature
      // off with a status; the app still starts. Other errors still surface.
      const improvementOpen = await openOptionalStoreAsync(
        async () => {
          const engine = new ImprovementEngine({
            root: path.join(store.root, "improvement"),
            // PRD-019: the repair maker's Opus calls are metered and capped like every other call.
            maker: opusMaker(store, emit, (request) => costMeter.call(request, invokeModel)),
            journal: recovery,
            nodeExecutable:
              process.env.WORKBENCH_NODE || "C:/Program Files/nodejs/node.exe",
            redact: (text) => store.redact(text),
          });
          await engine.init();
          return engine;
        },
        { degrade: (error) => error?.code === "ERR_IMPROVEMENT_DATA_CORRUPT" },
      );
      improvement = improvementOpen.store;
      storeStatus.improvement = improvementOpen.status;
      const importIndex = process.argv.indexOf("--import-anthropic-key-file");
      if (importIndex >= 0) {
        const credential = await readAnthropicCredential(
          process.argv[importIndex + 1],
        );
        await store.saveSettings({
          ...store.settings,
          active: "anthropic",
          profiles: {
            ...store.settings.profiles,
            anthropic: { model: "claude-sonnet-5-5" },
          },
          keys: { anthropic: credential },
          autoRouting: false,
          modelRegistry: [
            {
              id: "sonnet-55",
              label: "Sonnet 5.5",
              provider: "anthropic",
              model: "claude-sonnet-5-5",
              credentialId: "anthropic",
              capabilities: ["text", "tools", "code"],
              enabled: true,
              priority: 20,
            },
            {
              id: "opus-55",
              label: "Opus 5.5",
              provider: "anthropic",
              model: "claude-opus-5-5",
              credentialId: "anthropic",
              capabilities: ["text", "tools", "code"],
              enabled: true,
              priority: 50,
            },
          ],
          routeMap: {
            conversation: "sonnet-55",
            summary: "sonnet-55",
            research: "sonnet-55",
            coding: "sonnet-55",
            debugging: "opus-55",
            planning: "opus-55",
            creative: "sonnet-55",
            review: "opus-55",
          },
        });
      }
      const kimiImportIndex = process.argv.indexOf("--import-kimi-key-file");
      if (kimiImportIndex >= 0) {
        const credential = await readKimiCredential(
          process.argv[kimiImportIndex + 1],
        );
        await store.saveSettings({
          ...store.settings,
          profiles: {
            ...store.settings.profiles,
            kimi: { model: "kimi-k2.6" },
          },
          credentials: [
            {
              id: "kimi",
              provider: "kimi",
              key: credential,
              label: "Kimi · impor pemilik",
            },
          ],
          modelRegistry: [
            ...(store.settings.modelRegistry || []).filter(
              (p) => p.id !== "kimi-coder",
            ),
            {
              id: "kimi-coder",
              label: "Kimi K2.6",
              provider: "kimi",
              model: "kimi-k2.6",
              credentialId: "kimi",
              capabilities: ["text", "tools", "code"],
              contextWindowTokens: 262144,
              enabled: true,
              priority: 60,
            },
          ],
        });
      }
      if (process.argv.includes("--enable-adaptive-router")) {
        await store.saveSettings({
          ...store.settings,
          autoRouting: true,
          adaptiveRouting: {
            version: 1,
            enabled: true,
            models: {
              low: "kimi-coder",
              medium: "kimi-coder",
              high: "opus-55",
            },
          },
        });
      }
      if (firstRun && process.argv.includes("--self-workspace"))
        await store.setWorkspace(path.resolve(import.meta.dirname, "../.."));
      window = new BrowserWindow({
        width: 1420,
        height: 920,
        minWidth: 900,
        minHeight: 640,
        title: "miganGO",
        icon: path.resolve(import.meta.dirname, "../../ui/assets/migango.ico"),
        backgroundColor: "#11151b",
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(import.meta.dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (e) => e.preventDefault());
      window.webContents.on("will-attach-webview", (e) => e.preventDefault());
      window.webContents.session.setPermissionRequestHandler((wc, p, cb) =>
        cb(false),
      );
      browser = new ControlledBrowser(window, store, emit);
      // A corrupt, locked or full local database leaves that store null; the app still starts
      // and each task reports local memory as unavailable.
      const contextOpen = openOptionalStore(
        () => new ContextStore(path.join(store.root, "context.db")),
      );
      const referencesOpen = openOptionalStore(
        () => new ReferenceLibrary(path.join(store.root, "references.db")),
      );
      context = contextOpen.store;
      references = referencesOpen.store;
      // Fixed reason and short codes only; reads show them, writes refuse with a plain message.
      Object.assign(storeStatus, {
        context: contextOpen.status,
        references: referencesOpen.status,
      });
      mcp = new MCP(store, { recovery });
      approvals = new Approvals(emit);
      // ARS-014 §4: one desktop connector for desktop tools and screen capture. screen_capture
      // still needs owner approval per call; ocr_read output stays untrusted; images go to app
      // data artifacts, never the workspace. Input control mode is not wired here.
      const desktop = new WindowsDesktop();
      const screen = createAppScreen({
        getWindow: () => window,
        dataRoot: store.root,
        desktop,
      });
      tools = new Tools({
        workspace: new Workspace(store.settings.workspace),
        approvals,
        browser,
        mcp,
        store,
        skills: new SkillLibrary(store.settings.workspace, [
          path.resolve(import.meta.dirname, "../../.agents/skills"),
        ]),
        context,
        references,
        recovery,
        // PRD-017: project skills plus owner-configured folders (none by default).
        skillRouter: new SkillRouter({ dirs: () => store.settings.skillDirs || [] }),
        desktop,
        screen,
      });
      tools.contextStatus = storeStatus.context;
      runtime = new AgentRuntime({ store, tools, emit });
      // PRD-019: daily ledger and hard caps for paid providers, in the app's data folder.
      runtime.meter = costMeter;
      const startTask = (payload, meta) => {
        if (closing || runtime.active || activeTask || manualController)
          throw Error("A task is running or the app is closing");
        // GATE D3 C1/C2: the owner's task box tags each task with a taskId; it comes back with the
        // error so the renderer can offer a rerun of exactly that task. Bridge tasks never carry one.
        const { taskId: idMasuk, ...tanpaTaskId } = payload || {};
        const taskId = !meta && typeof idMasuk === "string" && /^[A-Za-z0-9-]{8,64}$/.test(idMasuk) ? idMasuk : undefined;
        // origin/title come only from the bridge meta; UI payloads are stripped of both.
        const task = runtime.start(withRunOrigin(tanpaTaskId, meta));
        activeTask = task;
        void task
          .catch((error) =>
            emit({ type: "error", text: store.redact(error.message), ...galatKode(error), ...(taskId ? { taskId } : {}) }),
          )
          .finally(() => {
            if (activeTask === task) activeTask = undefined;
          });
        return task;
      };
      // Bridge build (markas, 27 Oct 2026): the target is checked after realpath against the owner's
      // devRoots (never the repo, live folder, userData or a system folder) BEFORE the run starts,
      // must already be the app workspace (opened by the owner), and is only ever a NEW project:
      // confirming an existing folder stays the owner's decision. Approvals, tiers and the cost
      // meter apply exactly as for any other run. The task is set as activeTask at once.
      const startBridgeBuild = (payload, meta) => {
        if (closing || runtime.active || activeTask || manualController)
          throw Error("A task is running or the app is closing");
        const task = (async () => {
          const checked = await checkBridgeBuildTarget(payload.bridgeBuildTarget, {
            devRoots: store.settings.devRoots || [],
            forbidden: [app.getAppPath(), store.root],
            repoCommonDir: appRepoCommonDir(),
          });
          const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
          if (!same(checked.root, tools.workspace.root))
            throw Error("buildTarget harus sama dengan workspace aktif; pemilik membuka folder itu lebih dulu");
          const { bridgeBuildTarget, ...rest } = payload;
          return runtime.start(withRunOrigin({
            ...rest,
            target: { kind: "new", root: checked.root, activeRoot: app.getAppPath(), confirmedByOwner: false },
          }, meta));
        })();
        activeTask = task;
        void task
          .catch((error) => emit({ type: "error", text: store.redact(error.message), ...galatKode(error) }))
          .finally(() => {
            if (activeTask === task) activeTask = undefined;
          });
        return task;
      };
      // 000b2: guarded workspace switch (ARS-014). Owner/bridge only, never a model tool.
      // Only isolated worktrees of this repo under the owner's devRoots; never the live app
      // folder or the data folder; refused while a run or an approval is active.
      const workspaceSwitcher = createWorkspaceSwitcher({
        check: (to) =>
          checkSwitchTarget(to, {
            devRoots: store.settings.devRoots || [],
            forbidden: [app.getAppPath(), store.root],
            repoCommonDir: appRepoCommonDir(),
          }),
        isBusy: () =>
          Boolean(
            closing ||
              runtime.active ||
              activeTask ||
              manualController ||
              approvals.pending.size,
          ),
        apply: (root) => useWorkspace(root),
        audit: (entry) => forward({ ...entry, to: entry.to && store.redact(entry.to) }),
      });
      // Banner HOLD di Beranda: daftar HOLD semua folder (field aman) dan pindah lewat id jurnal.
      // Every HOLD-list answer the Beranda banner relies on is logged (cause of a vanished banner unproven).
      const holdLog = createHoldBannerLog(path.join(store.root, "logs", "hold-banner.jsonl"));
      const holdSwitcher = createHoldSwitcher({
        recovery,
        redact: (text) => store.redact(text),
        isBusy: () =>
          Boolean(
            closing ||
              runtime.active ||
              activeTask ||
              manualController ||
              approvals.pending.size,
          ),
        realpath: (p) => fs.realpath(p),
        apply: (root) => useWorkspace(root),
      });
      if (!process.argv.includes("--no-local-bridge")) {
        bridgeController = createBridgeController({
          workspace: () => tools.workspace.root,
          status: () => ({
            app: "miganGO",
            version: app.getVersion(),
            bridgeVersion: 1,
            workspace: tools.workspace.root,
            busy: Boolean(runtime.active || activeTask || manualController),
            closing,
            profiles: (store.settings.modelRegistry || []).map((p) => ({
              id: p.id,
              provider: p.provider,
              model: p.model,
              enabled: p.enabled !== false,
              configured:
                p.provider === "ollama" ||
                Boolean(store.keys[p.credentialId || p.provider]),
            })),
          }),
          start: (payload, meta) => (payload.mode === "build" ? startBridgeBuild(payload, meta) : startTask(payload, meta)),
          stop: () => runtime.stop(),
          loadRun: (id) => store.loadRun(id),
          // Only the bridge may pass a policy decision; the owner's UI path below never does.
          resolveApproval: (id, yes, decision) => approvals.resolve(id, yes, decision),
          redact: (text) => store.redact(text),
          switchWorkspace: (to) => workspaceSwitcher.switchTo(to, { actor: "bridge" }),
          // Option b (markas, 27 Oct): per-file guard for bridge-granted writes in a bridge build run.
          checkBuildWrite: (target, file) =>
            checkBuildWriteTarget(target, file, {
              devRoots: store.settings.devRoots || [],
              forbidden: [app.getAppPath(), store.root],
              repoCommonDir: appRepoCommonDir(),
            }),
        });
        localBridge = await startLocalBridge({
          descriptorPath: path.join(store.root, "local-bridge/connection.json"),
          handle: (method, params) => bridgeController.execute(method, params),
        });
      }
      // A broken agents.json never stops the app: Migan only, with a plain warning.
      const catalogView = await openCatalog({ root: store.root });
      runtime.catalog = catalogView.catalog;
      const teamConfig = createTeamConfig({
        catalog: catalogView.catalog,
        settings: () => store.settings,
        isBusy: () =>
          !!(runtime.active || activeTask || manualController || closing),
        isTrusted: (e) =>
          e.sender === window.webContents &&
          e.senderFrame === window.webContents.mainFrame &&
          e.senderFrame.url === pathToFileURL(ui).href,
      });
      statusIpc = createReadOnlyIpc({
        methods: {
          agentStatus: () => runtime.agentStatus(),
          agentCatalog: () => ({
            cards: catalogView.catalog.panelCards(),
            warning: catalogView.warning,
          }),
        },
        // Same sender rule as the dispatcher; checked again on purpose.
        isTrusted: (e) =>
          e.sender === window.webContents &&
          e.senderFrame === window.webContents.mainFrame &&
          e.senderFrame.url === pathToFileURL(ui).href,
      });
      // 06xg: "Apa yang baru" reads one fixed file inside the app, never the workspace.
      const whatsNewIpc = createWhatsNewIpc({
        appRoot: app.getAppPath(),
        version: app.getVersion(),
        isTrusted: (e) =>
          e.sender === window.webContents &&
          e.senderFrame === window.webContents.mainFrame &&
          e.senderFrame.url === pathToFileURL(ui).href,
      });
      runtime.announceStatus();
      window.on("resize", () => {
        browser.update();
        layoutPreview();
      });
      window.on("close", (event) => {
        event.preventDefault();
        if (closing) return;
        closing = true;
        window.setTitle("miganGO · Menghentikan pekerjaan…");
        void gracefulShutdown({
          abort: () => {
            runtime.stop();
            manualController?.abort();
          },
          pending: [activeTask, manualTask],
          closeWorkers: async () => {
            await localBridge?.close();
            await mcp.close();
          },
          closeStores: () => {
            context?.close();
            references?.close();
            improvement?.close();
            configureProcessRecovery(undefined);
            recovery.close();
          },
          destroy: () => {
            browser.close();
            window.destroy();
          },
        }).catch((error) => {
          closing = false;
          runtime.locked =
            "Shutdown could not confirm worker cleanup. " +
            store.redact(error.message);
          window.setTitle("miganGO · Periksa proses");
          emit({ type: "error", text: runtime.locked });
        });
      });
      ipcMain.handle("workbench", async (event, method, payload) => {
        try {
          if (
            event.sender !== window.webContents ||
            event.senderFrame !== window.webContents.mainFrame ||
            event.senderFrame.url !== pathToFileURL(ui).href
          )
            throw new Error("Untrusted IPC sender");
          if (JSON.stringify(payload ?? null).length > 180000)
            throw new Error("Request too large");
          if (closing && !["stop", "approve", "browserLayout"].includes(method))
            throw Error("Application is closing; wait for task cleanup");
          let data;
          switch (method) {
            case "recoveryList":
              data = recovery.list({
                workspace: tools.workspace.root,
                status: "hold",
              });
              break;
            case "recoveryHoldsAll":
              data = holdSwitcher.listAll();
              void holdLog.record({ ok: true, n: data.length });
              break;
            case "recoveryHoldSwitch":
              data = await holdSwitcher.switchTo(payload?.id);
              break;
            case "recoveryInspect": {
              const row = recovery.get(payload);
              if (
                row.workspace !==
                path.resolve(tools.workspace.root).toLowerCase()
              )
                throw Error(
                  holdMismatchMessage(row.workspace, tools.workspace.root),
                );
              data = await recovery.inspect(payload);
              break;
            }
            case "recoveryResolve":
            case "recoveryTerminate": {
              if (runtime.active || activeTask || manualController)
                throw Error("Stop current operation first");
              const row = recovery.get(payload.id);
              if (
                row.workspace !==
                path.resolve(tools.workspace.root).toLowerCase()
              )
                throw Error(
                  holdMismatchMessage(row.workspace, tools.workspace.root),
                );
              manualController = new AbortController();
              try {
                if (
                  !(await approvals.request(
                    method,
                    {
                      id: row.id,
                      pid: row.pid,
                      started: row.started,
                      executable: row.executable,
                      note: payload.note,
                      warning:
                        "External effects are not undone. Identity is rechecked before termination.",
                    },
                    manualController.signal,
                  ))
                )
                  throw Error("Owner rejected recovery action");
                data =
                  method === "recoveryTerminate"
                    ? await recovery.terminateOwned(row.id)
                    : await recovery.resolve(row.id, {
                        decision: "acknowledge-effects",
                        note: store.redact(payload.note),
                      });
                if (
                  !recovery.list({
                    workspace: tools.workspace.root,
                    status: "hold",
                  }).length
                )
                  runtime.locked = undefined;
              } finally {
                manualController = undefined;
              }
              break;
            }
            case "improvementList":
              data = improvement ? await improvement.list(tools.workspace.root) : [];
              break;
            case "improvementCreate":
              if (!improvement)
                throw new Error(
                  "Fitur perbaikan diri sedang mati karena databasenya tidak bisa dibuka; fitur lain tetap jalan. Buka ulang miganGO, dan bila tetap mati salin folder data sebagai cadangan lalu hubungi pengembang. / Self-improvement is off because its database could not be opened.",
                );
              if (runtime.active || activeTask || manualController)
                throw Error("Stop current operation first");
              data = await improvement.create({
                ...payload,
                workspace: tools.workspace.root,
              });
              break;
            case "improvementRepair":
            case "improvementActivate":
            case "improvementExecute":
            case "improvementTest": {
              if (!improvement)
                throw new Error(
                  "Fitur perbaikan diri sedang mati karena databasenya tidak bisa dibuka; fitur lain tetap jalan. Buka ulang miganGO, dan bila tetap mati salin folder data sebagai cadangan lalu hubungi pengembang. / Self-improvement is off because its database could not be opened.",
                );
              if (runtime.active || activeTask || manualController)
                throw Error("Stop current operation first");
              recovery.assertSafe(tools.workspace.root);
              const candidate = await improvement.get(payload.id);
              if (
                candidate.workspace !==
                (await fs.realpath(tools.workspace.root))
              )
                throw Error("Candidate workspace mismatch");
              manualController = new AbortController();
              try {
                if (
                  !(await approvals.request(
                    method,
                    {
                      id: candidate.id,
                      goal: candidate.goal,
                      editable: candidate.editable,
                      tests: candidate.tests,
                      candidateHash: candidate.candidateHash,
                      verdictId: candidate.verdict?.id,
                      invocation:
                        method === "improvementExecute"
                          ? payload.call
                          : undefined,
                      warning:
                        method === "improvementRepair"
                          ? "Run pinned tests on disposable copy and send scoped files to Opus5.5. Up to 2 calls, 4096 output tokens each. Code remains trusted, not an OS/network sandbox."
                          : method === "improvementActivate"
                            ? "Activate validated snapshot pointer; original source is not overwritten."
                            : "Run pinned active version with filesystem/child restrictions; not a network/kernel sandbox.",
                    },
                    manualController.signal,
                  ))
                )
                  throw Error("Owner rejected candidate action");
                manualTask =
                  method === "improvementRepair"
                    ? improvement.repair(candidate.id, {
                        signal: manualController.signal,
                      })
                    : method === "improvementActivate"
                      ? improvement.activate(candidate.id, {
                          candidateHash: payload.candidateHash,
                          verdictId: payload.verdictId,
                        })
                      : method === "improvementExecute"
                        ? improvement.runActive(tools.workspace.root, {
                            ...payload.call,
                            id: candidate.id,
                            candidateHash: payload.candidateHash,
                            signal: manualController.signal,
                          })
                        : improvement.testActive(tools.workspace.root, {
                            signal: manualController.signal,
                            expectedId: candidate.id,
                            expectedHash: candidate.candidateHash,
                          });
                data = await manualTask;
              } finally {
                manualController = undefined;
                manualTask = undefined;
              }
              break;
            }
            case "settings":
              data = {
                ...store.publicSettings(),
                version: app.getVersion(),
                openLastRun: process.argv.includes("--open-last-run"),
                brainAvailable: await fs
                  .access("C:/brain/mcp/server.js")
                  .then(
                    () => true,
                    () => false,
                  ),
              };
              break;
            case "connectBrain": {
              if (runtime.active || activeTask)
                throw new Error("Stop the current task first");
              await fs.access("C:/brain/mcp/server.js");
              const entry = {
                id: "brain",
                command: "node",
                args: ["C:/brain/mcp/server.js"],
                allowTools: [
                  "brain_context",
                  "brain_search",
                  "brain_get",
                  "brain_learn",
                  "brain_session",
                ],
              };
              const config = {
                ...store.settings,
                memoryEnabled: true,
                mcp: [
                  ...store.settings.mcp.filter((m) => m.id !== "brain"),
                  entry,
                ],
              };
              data = await store.saveSettings(config);
              break;
            }
            case "saveSettings":
              if (runtime.active || activeTask || manualController)
                throw new Error("Stop task before changing providers");
              await mcp.close();
              data = await store.saveSettings(payload);
              break;
            case "testConnection": {
              if (runtime.active || activeTask)
                throw new Error("Stop the current task first");
              const profile = chooseRoute(
                { ...store.settings, routes: {} },
                "ask",
              );
              const started = Date.now();
              // The connection test is a paid call too (PRD-019).
              const result = await costMeter.call({
                profile,
                key: store.keys[profile.provider],
                system: "Reply concisely in Indonesian.",
                messages: [
                  { role: "user", content: "Balas tepat: KONEKSI_OK" },
                ],
                tools: [],
                signal: new AbortController().signal,
                maxOutput: 128,
              }, invokeModel);
              if (result.finishReason !== "completed" || !result.text.trim())
                throw new Error(
                  "Provider replied without a complete answer: " +
                    result.finishReason,
                );
              data = {
                provider: profile.provider,
                model: profile.model,
                text: store.redact(result.text),
                latencyMs: Date.now() - started,
                usage: result.usage,
              };
              break;
            }
            case "pickWorkspace": {
              if (runtime.active || activeTask || manualController)
                throw new Error("Stop task before changing folder");
              const chosen = await dialog.showOpenDialog(window, {
                properties: ["openDirectory"],
                title: "Pilih folder kerja",
              });
              if (!chosen.canceled)
                await useWorkspace(await fs.realpath(chosen.filePaths[0]));
              data = store.publicSettings();
              break;
            }
            case "previewArtifact": {
              const opened = await previews.open({
                workspace: tools.workspace,
                path: payload,
              });
              data = { token: opened.token, url: opened.url };
              break;
            }
            case "openPreview":
              await showPreview(payload || {});
              data = { shown: previewToken === payload?.token };
              break;
            case "closePreview":
              if (previewToken === payload) closePreviewView();
              previews.close(payload);
              data = { closed: true };
              break;
            case "listDirectory":
              data = await listDirectory(tools.workspace, payload?.dir ?? "", {
                offset: payload?.offset ?? 0,
              });
              break;
            case "createProject": {
              if (runtime.active || activeTask || manualController)
                throw new Error("Stop task before creating a project");
              const name = validateProjectName(payload?.name);
              const chosen = await dialog.showOpenDialog(window, {
                properties: ["openDirectory", "createDirectory"],
                title: "Pilih tempat proyek baru",
              });
              if (chosen.canceled)
                throw new Error("Pembuatan proyek dibatalkan");
              const activeRoot = await fs.realpath(tools.workspace.root);
              const { root, standard } = await createProject({
                projectsRoot: chosen.filePaths[0],
                name,
                profile: validateProfile(payload?.profile ?? "dasar"),
              });
              await useWorkspace(root);
              data = { root, activeRoot, standard };
              break;
            }
            case "projectStandardInit": {
              // Owner-only: applies the project standard to the open project; existing files are kept.
              if (runtime.active || activeTask || manualController)
                throw new Error("Stop task before applying the project standard");
              recovery.assertSafe(tools.workspace.root);
              const profile = validateProfile(payload?.profile ?? "dasar");
              const root = await fs.realpath(tools.workspace.root);
              manualController = new AbortController();
              try {
                const plan = await planProjectStandard({ root, profile });
                if (
                  !(await approvals.request(
                    "projectStandardInit",
                    {
                      workspace: root,
                      profile,
                      create: plan.create,
                      keep: plan.keep.length,
                      warning:
                        "Hanya menambah berkas yang belum ada; berkas yang sudah ada tidak diubah. / Adds missing files only.",
                    },
                    manualController.signal,
                  ))
                )
                  throw new Error("Owner rejected the project standard");
                data = {
                  root,
                  log: await scaffoldProjectStandard({
                    root,
                    name: path.basename(tools.workspace.root),
                    profile,
                  }),
                };
              } finally {
                manualController = undefined;
              }
              break;
            }
            case "files":
              data = await tools.workspace.list();
              break;
            case "readFile":
              data = await tools.workspace.read(payload);
              break;
            case "skills":
              data = await tools.skills.list();
              break;
            case "researchList":
              if (!references) {
                data = [];
                break;
              }
              data = references.list(
                tools.workspace.root,
                String(payload || ""),
              );
              break;
            case "researchCatalog":
              data = REFERENCE_CATALOG;
              break;
            case "researchImport":
              if (!references)
                throw new Error(
                  "Pustaka riset lokal tidak tersedia / Local research library unavailable",
                );
              data = references.import(
                tools.workspace.root,
                store.redact(payload),
              );
              break;
            case "researchAnnotate":
              if (!references)
                throw new Error(
                  "Pustaka riset lokal tidak tersedia / Local research library unavailable",
                );
              data = references.annotate(
                tools.workspace.root,
                JSON.parse(store.redact(JSON.stringify(payload))),
              );
              break;
            case "researchExport": {
              if (!references)
                throw new Error(
                  "Pustaka riset lokal tidak tersedia / Local research library unavailable",
                );
              const content = references.markdown(tools.workspace.root);
              const dir = path.join(store.root, "artifacts");
              await fs.mkdir(dir, { recursive: true });
              const output = path.join(dir, "research-" + Date.now() + ".md");
              await fs.writeFile(output, content, { flag: "wx" });
              data = {
                path: output,
                sha256: createHash("sha256").update(content).digest("hex"),
                validation:
                  "owner-asserted source notes; semantic verification not automatic",
              };
              break;
            }
            case "memory":
              if (!context) {
                data = {
                  mode: "unavailable",
                  records: [],
                  status: storeStatus.context,
                };
                break;
              }
              data = {
                mode: context.mode,
                facts: context.currentFacts(tools.workspace.root),
                records: context.search(
                  tools.workspace.root,
                  String(payload || ""),
                ),
              };
              break;
            case "memoryFact": {
              // Owner-only: the renderer's settings/memory UI. No model tool writes facts.
              if (!context)
                throw new Error(
                  "Memori lokal tidak tersedia / Local memory unavailable",
                );
              data = context.setFact({
                workspace: tools.workspace.root,
                topic: store.redact(String(payload?.topic ?? "")),
                statement: store.redact(String(payload?.statement ?? "")),
                source: "owner-ui",
              });
              break;
            }
            case "memoryNote":
              if (!context)
                throw new Error(
                  "Memori lokal tidak tersedia / Local memory unavailable",
                );
              data = context.add({
                workspace: tools.workspace.root,
                kind: "user-note",
                content: store.redact(String(payload)),
                source: "owner-ui",
                trust: "explicit",
              });
              break;
            case "run": {
              startTask(payload);
              data = { accepted: true };
              break;
            }
            case "stop":
              runtime.stop();
              manualController?.abort();
              data = true;
              break;
            case "ownerTool": {
              if (runtime.active || activeTask || manualController)
                throw Error("Stop current operation first");
              if (runtime.locked) throw Error(runtime.locked);
              if (
                !["shell", "desktop_windows", "desktop_focus"].includes(
                  payload?.name,
                )
              )
                throw Error("Manual tool unavailable");
              manualController = new AbortController();
              try {
                manualTask = tools.execute(
                  { name: payload.name, args: payload.args },
                  manualController.signal,
                );
                data = JSON.parse(
                  store.redact(JSON.stringify(await manualTask)),
                );
              } catch (error) {
                if (error.terminationUnconfirmed)
                  runtime.locked = store.redact(error.message);
                throw error;
              } finally {
                manualController = undefined;
                manualTask = undefined;
              }
              break;
            }
            case "approve":
              data = approvals.resolve(payload.id, payload.yes);
              break;
            case "history":
              data = await store.history();
              break;
            case "loadRun":
              data = await store.loadRun(payload);
              break;
            case "browserNavigate":
              if (runtime.active || activeTask)
                throw new Error("Stop task before manually navigating browser");
              data = await browser.navigate(payload);
              break;
            case "browserLayout":
              browser.layout(payload.rect, payload.visible);
              data = true;
              break;
            case "browserSnapshot":
              data = await browser.snapshot();
              break;
            case "employeeProfiles": {
              const { listEmployeeProfiles } =
                await import("../agents/employee-profiles.mjs");
              data = {
                profiles: structuredClone(listEmployeeProfiles()),
                warning: null,
              };
              break;
            }
            case "geminiModels": {
              // IPC gemini:models. The key stays in main; no saved key = no network call.
              const { listGeminiModels } = await import("../core/gemini-models.mjs");
              data = await listGeminiModels({ key: store.keys.gemini });
              break;
            }
            case "agentStatus":
            case "agentCatalog":
              data = statusIpc.handle(event, method, payload);
              break;
            case "whatsNew":
              data = await whatsNewIpc.handle(event, method, payload);
              break;
            case "teamMemberAdd":
            case "teamMemberRemove":
              data = await teamConfig(event, method, payload);
              break;
            case "openArtifacts": {
              const dir = path.join(store.root, "artifacts");
              await fs.mkdir(dir, { recursive: true });
              await shell.openPath(dir);
              data = true;
              break;
            }
            default:
              throw new Error("Unknown operation");
          }
          return { ok: true, data };
        } catch (e) {
          if (method === "recoveryHoldsAll")
            void holdLog?.record({ ok: false, error: store?.redact(e.message) || "Application error" });
          return {
            ok: false,
            error: store?.redact(e.message) || "Application error",
          };
        }
      });
      await window.loadFile(ui);
      windowIntent.ready(process.argv.includes("--background"));
    })
    .catch((error) => {
      void localBridge?.close();
      if (process.argv.includes("--background")) {
        console.error(
          "miganGO background startup failed: " +
            (error instanceof StartupBlockedError
              ? `${error.title}\n${error.message}`
              : store?.redact(error.message) || "Application error"),
        );
        // A non-zero exit lets launchers and watchdogs see the failed start.
        app.exit(1);
        return;
      }
      // StartupBlockedError carries a plain title and safe steps without raw paths.
      const blocked = error instanceof StartupBlockedError;
      dialog.showErrorBox(
        blocked ? error.title : "miganGO gagal dibuka",
        blocked ? error.message : store?.redact(error.message) || error.message,
      );
      app.exit(1);
    });
  app.on("window-all-closed", () => app.quit());
}
