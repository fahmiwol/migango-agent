const { contextBridge, ipcRenderer } = require("electron");
const request = (method, payload) =>
  ipcRenderer.invoke("workbench", method, payload).then((r) => {
    if (!r.ok) throw new Error(r.error);
    return r.data;
  });
contextBridge.exposeInMainWorld(
  "workbench",
  Object.freeze({
    settings: () => request("settings"),
    saveSettings: (s) => request("saveSettings", s),
    testConnection: () => request("testConnection"),
    // Model names from Gemini models.list; the key never reaches the renderer.
    geminiModels: () => request("geminiModels"),
    ownerTool: (name, args) => request("ownerTool", { name, args }),
    recoveryList: () => request("recoveryList"),
    recoveryHoldsAll: () => request("recoveryHoldsAll"),
    recoveryHoldSwitch: (id) => request("recoveryHoldSwitch", { id }),
    recoveryInspect: (id) => request("recoveryInspect", id),
    recoveryTerminate: (id) => request("recoveryTerminate", { id }),
    recoveryResolve: (id, note) => request("recoveryResolve", { id, note }),
    improvementList: () => request("improvementList"),
    improvementCreate: (spec) => request("improvementCreate", spec),
    improvementRepair: (id) => request("improvementRepair", { id }),
    improvementActivate: (id, candidateHash, verdictId) =>
      request("improvementActivate", { id, candidateHash, verdictId }),
    improvementTest: (id) => request("improvementTest", { id }),
    improvementExecute: (id, candidateHash, call) =>
      request("improvementExecute", { id, candidateHash, call }),
    researchList: (query) => request("researchList", query),
    researchCatalog: () => request("researchCatalog"),
    researchImport: (text) => request("researchImport", text),
    researchAnnotate: (record) => request("researchAnnotate", record),
    researchExport: () => request("researchExport"),
    connectBrain: () => request("connectBrain"),
    pickWorkspace: () => request("pickWorkspace"),
    files: () => request("files"),
    readFile: (p) => request("readFile", p),
    skills: () => request("skills"),
    memory: (query) => request("memory", query),
    memoryNote: (content) => request("memoryNote", content),
    memoryFact: (fact) => request("memoryFact", fact),
    run: (task) => request("run", task),
    stop: () => request("stop"),
    approve: (id, yes) => request("approve", { id, yes }),
    history: () => request("history"),
    loadRun: (id) => request("loadRun", id),
    browserNavigate: (url) => request("browserNavigate", url),
    browserLayout: (rect, visible) =>
      request("browserLayout", { rect, visible }),
    browserSnapshot: () => request("browserSnapshot"),
    openArtifacts: () => request("openArtifacts"),
    // Read-only agen.status view (ARS-004 §2); the renderer cannot write status.
    agentStatus: () => request("agentStatus"),
    agentCatalog: () => request("agentCatalog"),
    // "Apa yang baru": fixed in-app file; arguments are deliberately ignored (06xg).
    whatsNew: () => request("whatsNew"),
    employeeProfiles: () => request("employeeProfiles"),
    teamMemberAdd: (input) => request("teamMemberAdd", input),
    teamMemberRemove: (id) => request("teamMemberRemove", { id }),
    // Canvas-like preview and project files (ARS-004 §13, K05).
    previewArtifact: (path) => request("previewArtifact", path),
    openPreview: (layout) => request("openPreview", layout),
    closePreview: (token) => request("closePreview", token),
    listDirectory: (query) => request("listDirectory", query),
    createProject: (input) => request("createProject", input),
    projectStandardInit: (input) => request("projectStandardInit", input),
    onPreviewInvalidated: (callback) => {
      const listener = (_, event) => {
        if (event?.type === "preview.invalidated") callback(event);
      };
      ipcRenderer.on("workbench-event", listener);
      return () => ipcRenderer.removeListener("workbench-event", listener);
    },
    onAgentStatus: (callback) => {
      const listener = (_, event) => {
        if (event?.type === "agen.status") callback(event);
      };
      ipcRenderer.on("workbench-event", listener);
      return () => ipcRenderer.removeListener("workbench-event", listener);
    },
    onEvent: (callback) => {
      const listener = (_, event) => callback(event);
      ipcRenderer.on("workbench-event", listener);
      return () => ipcRenderer.removeListener("workbench-event", listener);
    },
  }),
);
