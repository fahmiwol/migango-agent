const api = window.workbench,
  $ = (id) => document.getElementById(id);
let settings,
  mode = "ask",
  tab = "files",
  busy = false,
  approvalId = null,
  previousId = null,
  language = "id",
  toastTimer,
  galaxy,
  workspaceTabs,
  skillsRevision = 0,
  memoryRevision = 0;
const memorySources = window.createMemorySourceStatus({
  language: () => language,
});
memorySources.reset();
const en = {
  memorySourcesTitle: "Memory for this task",
  taskTeamSettingsTitle: "Team for this task",
  teamTemporaryHint:
    "Members are used only for this task. The original employee profiles remain saved.",
  teamLearnHint:
    "For this send only: save sourced summaries in project memory. They still need review and do not automatically train a model.",
  teamCouncilHint:
    "A team with several models asks you to review its plan and limits before starting.",
  workspaceChat: "Conversation",
  workspaceTeam: "AI team",
  workspaceResults: "Results",
  workspaceTabHint: "One task, everything together.",
  backToChat: "Back to conversation",
  miganPrimary: "Migan · your cross-domain assistant",
  addEmployee: "＋ Add an AI employee",
  employeeRecruit: "New member profile and settings",
  employeeTemplateLabel: "Start from a sample profile or create your own",
  resultsEyebrow: "WORK RESULTS",
  resultsTitle: "From a conversation to a result.",
  resultsHint: "Open files and inspect the recorded outputs.",
  openResultsFolder: "Open results folder ↗",
  projectMemory: "PROJECT MEMORY",
  memoryHint:
    "Local notes for this folder. Your notes and session summaries keep their sources; they are not verified facts.",
  searchMemory: "Search",
  newMemory: "Add a note",
  memoryPrivacy:
    "Saved on this laptop for this folder. Do not enter tokens or passwords.",
  saveMemory: "Save note",
  new: "New task",
  workspace: "WORKSPACE",
  folder: "Choose project folder",
  recent: "RECENT TASKS",
  local: "Yours. On your computer.",
  memory: "External memory via MCP · no model loaded at startup",
  settings: "Connections & settings",
  eyebrow: "YOUR PRIVATE WORKSPACE",
  title: "What would you like to work on?",
  headerCaption: "From an idea to a result you can inspect.",
  navHome: "Home",
  navTasks: "Activity",
  navComputer: "Computer & terminal",
  navMemory: "Memory",
  navSkills: "Skills & MCP",
  navResearch: "Research",
  navRecovery: "Recovery",
  guideTitle: "Big ideas, small steps.",
  guideBody: "Describe a goal. Review actions, then inspect the result.",
  guideAction: "Help me get started ↗",
  toolsPanel: "Workspace panel",
  taskList: "Task list",
  stagePlan: "Plan",
  stagePlanHint: "Define the goal",
  stageWork: "Work",
  stageWorkHint: "Model and tools",
  stageTest: "Test",
  stageTestHint: "Not validated",
  stageReview: "Review",
  stageReviewHint: "Inspect the result",
  taskControl: "Task controls",
  selectedModel: "Selected model",
  workspaceName: "Workspace",
  turnLimit: "Turn limit",
  tokenUsage: "Token usage",
  permissionNote: "Consequential actions need your permission.",
  availableSkills: "AVAILABLE SKILLS",
  skillHint:
    "Choose guidance for the next task. Selecting a skill does not execute tools or activate MCP.",
  localDesktop: "Local desktop",
  oneTask: "One active task · approved actions",
  artifacts: "Open results ↗",
  newProject: "New project",
  projectEyebrow: "NEW PROJECT",
  projectTitle: "Build the app in its own project folder",
  projectHint:
    "The agent does not write into the open folder unless you choose it. Name the project, then choose where its folder is created.",
  projectNameLabel: "Project name",
  cancel: "Cancel",
  useCurrentFolder: "Use this folder (the agent may write here)",
  createProject: "Create new project",
  agents: "Manage agents",
  taskTeamLabel: "Who will help",
  taskTeamHint:
    "Migan works alone by default. Choose an employee from the AI team if needed. Selecting does not run a model.",
  teamMemberName: "Agent name",
  teamMemberModel: "Model",
  teamMemberAccess: "Access",
  teamRead: "Read only",
  teamEdit: "Read and propose changes",
  teamNone: "Conversation without tools",
  teamAdd: "Add agent",
  teamTemporary: "Use a temporary team",
  teamLearn: "Save lessons from this team",
  agentsEyebrow: "AGENT TEAM",
  agentsTitle: "Meet the team helping you",
  agentsHint:
    "Migan is the main agent. Other agents are called only when needed.",
  close: "Close",
  hello: "ONE IDEA, MANY POSSIBILITIES",
  intro: "Start with your goal.",
  introBody:
    "Choose a folder, connect a model, and start. See the plan, review actions, and inspect the result.",
  connect: "Connect a model",
  choose: "Choose a workspace",
  first: "Try your first task",
  understand: "Understand a project",
  understandDesc: "Files and how things work",
  build: "Build an application",
  buildDesc: "From an idea to a first version",
  document: "Create a document",
  documentDesc: "An artifact you can use",
  ask: "Ask",
  work: "Work",
  buildMode: "Build an app",
  budget: "Read automatically · review changes",
  stop: "■ Stop",
  send: "Start",
  footnote:
    "Review results before using.",
  detail: "Details",
  files: "Files",
  browser: "Browser",
  activity: "Activity",
  projectFiles: "PROJECT FILES",
  browserNote:
    "Isolated browser session. Downloads, popups, passwords and device permissions are restricted.",
  activityNote: "Actions and evidence will appear here.",
  settingsTitle: "Model connections",
  keyHelp:
    "Use a platform API key. Windows encrypts it; saved keys are never returned to this window. Saving makes no model call.",
  activeProvider: "Active provider",
  ollamaHelp:
    "No model is started or downloaded on this laptop. Verify the remote machine and model capabilities.",
  advanced: "Model routes & advanced MCP",
  lightRoute: "Ask / summaries",
  codingRoute: "Coding / work",
  mcpWarning:
    "MCP, shell and SSH are trusted capabilities without an OS sandbox. Review exact commands. Never put secrets in arguments or JSON.",
  save: "Save connections",
  yourDecision: "YOUR DECISION",
  review: "Review this action",
  oneShot:
    "This approval applies once to the displayed action. Silence is not approval.",
  deny: "Reject",
  allow: "Approve once",
};
const idText = new Map(
  [...document.querySelectorAll("[data-i18n]")].map((e) => [e, e.innerHTML]),
);
function toast(message) {
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 6000);
}
function safe(fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      toast(e.message);
    }
  };
}
function setBusy(value) {
  busy = value;
  $("send").disabled = value;
  $("stop").hidden = !value;
  $("pickFolder").disabled = value;
  $("settingsBtn").disabled = value;
  $("taskModel").disabled = value;
  $("taskTeam").disabled = value;
  syncTeamFlags();
  syncTeamControls();
  $("refreshWindows").disabled = value;
  $("terminalRun").disabled = value;
  $("createCandidate").disabled = value;
  $("memorySave").disabled = value;
  $("memoryNote").readOnly = value;
  galaxy?.setBusy(value);
  renderModeHint();
}
function addMessage(role, text) {
  const box = document.createElement("div");
  box.className = "message " + role;
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent =
    role === "user"
      ? "ANDA / YOU"
      : role === "error"
        ? "PERLU DIPERIKSA / NEEDS REVIEW"
        : "AGEN / AGENT";
  const content = document.createElement("div");
  content.className = "message-text";
  if (role === "assistant")
    window.miganMarkdown.render(
      content,
      text,
      safe(async (url) => {
        await api.browserNavigate(url);
        await switchTab("browser");
      }),
    );
  else content.textContent = text;
  box.append(label, content);
  $("messages").append(box);
  box.scrollIntoView({ block: "nearest" });
  return content;
}
function addActivity(event) {
  const box = document.createElement("details");
  box.className = "activity-item";
  const time = document.createElement("div");
  time.className = "activity-time";
  time.textContent = event.at ? new Date(event.at).toLocaleTimeString() : "";
  const summary = document.createElement("summary");
  summary.textContent =
    (event.type === "tool-start" ? "↗ " : "✓ ") + (event.name || event.type);
  const pre = document.createElement("pre");
  pre.textContent =
    event.result || JSON.stringify(event.args || event, null, 2);
  box.append(time, summary, pre);
  $("activity").append(box);
}
async function refreshFiles() {
  const result = await api.files();
  // Accept the legacy empty-array response as well as the current IPC envelope.
  // Malformed payloads stay explicit errors; they must not look like an empty folder.
  const files = Array.isArray(result) ? result : result?.files;
  const truncated = !Array.isArray(result) && result?.truncated === true;
  if (!Array.isArray(files))
    throw Error("Daftar berkas tidak valid / Invalid file list response");
  $("fileList").replaceChildren();
  if (!files.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      language === "id"
        ? "Folder masih kosong. Mulai dari ide pertama Anda."
        : "This folder is empty. Start with your first idea.";
    $("fileList").append(empty);
  }
  for (const p of files) {
    const button = document.createElement("button");
    button.textContent = "▱ " + p;
    button.title = p;
    button.onclick = safe(async () => {
      $("fileName").textContent = p;
      $("filePreview").hidden = false;
      // HTML/SVG/Markdown open as a live, isolated preview (K05); other files stay plain text.
      if (/\.(html?|svg|md)$/i.test(p)) {
        await showLivePreview(p);
        return;
      }
      await hideLivePreview();
      const r = await api.readFile(p);
      $("fileText").textContent = r.text + (r.truncated ? "\n[TRUNCATED]" : "");
    });
    $("fileList").append(button);
  }
  if (truncated) toast("Daftar dibatasi 600 berkas / File list limited to 600");
}
async function refreshSkills() {
  const revision = ++skillsRevision;
  const skills = await api.skills();
  if (revision !== skillsRevision) return;
  const selected = $("skill").value;
  $("skill").replaceChildren(
    new Option(
      language === "id" ? "Tanpa skill tambahan" : "No additional skill",
      "",
    ),
  );
  for (const s of skills) {
    const o = new Option(s.name + " · " + s.source, s.path);
    o.title = s.description;
    $("skill").append(o);
  }
  if ([...$("skill").options].some((option) => option.value === selected))
    $("skill").value = selected;
  $("skillList").replaceChildren();
  for (const skill of skills) {
    const button = document.createElement("button");
    button.className = "skill-entry";
    button.setAttribute(
      "aria-pressed",
      String(skill.path === $("skill").value),
    );
    const title = document.createElement("strong");
    title.textContent = skill.name;
    const description = document.createElement("small");
    description.textContent = skill.description || skill.source;
    button.append(title, description);
    button.onclick = () => {
      if (busy) return;
      $("skill").value = skill.path;
      $("skillList")
        .querySelectorAll("button")
        .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      $("prompt").focus();
      toast(
        (language === "id" ? "Skill dipilih: " : "Skill selected: ") +
          skill.name,
      );
    };
    $("skillList").append(button);
  }
  if (!skills.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent =
      language === "id"
        ? "Belum ada skill di ruang kerja ini."
        : "No skills found in this workspace.";
    $("skillList").append(p);
  }
}
function runStatusLabel(status) {
  const labels = {
    running: ["Sedang dikerjakan", "Running"],
    responded: ["Jawaban siap", "Response ready"],
    "needs-validation": ["Perlu diuji", "Needs validation"],
    failed: ["Gagal · periksa catatan", "Failed · review notes"],
    cancelled: ["Dihentikan", "Stopped"],
    interrupted: ["Terputus", "Interrupted"],
  };
  return labels[status]?.[language === "en" ? 1 : 0] || status;
}
// "Sedang dikerjakan" on Beranda: running runs from the history list, details from loadRun.
// Text only (textContent); a failed load still shows the summary card, never a fake cost.
let sedangRevision = 0;
async function renderSedangDikerjakan(all) {
  const revision = ++sedangRevision;
  const S = window.miganSedangDikerjakan;
  const box = $("sedangDikerjakan");
  if (!S || !box) return;
  const running = window.miganSedangDikerjakan.pilihBerjalan(all).slice(0, 3);
  const full = await Promise.all(
    running.map((r) => api.loadRun(r.id).catch(() => r)),
  );
  if (revision !== sedangRevision) return;
  box.replaceChildren();
  box.hidden = !full.length;
  if (!full.length) return;
  const head = document.createElement("strong");
  head.className = "sedang-dikerjakan-title";
  head.textContent = language === "en" ? "In progress" : "Sedang dikerjakan";
  box.append(head);
  const para = (cls, text) => {
    const p = document.createElement("p");
    p.className = cls;
    p.textContent = text;
    return p;
  };
  for (const run of full) {
    const k = window.miganSedangDikerjakan.kartu(run, language);
    const card = document.createElement("article");
    card.className = "sedang-kartu" + (k.otomatis ? " otomatis" : "");
    // Header (title + badge) is separated from the body; raw tool facts are only in Rincian.
    const top = document.createElement("div");
    top.className = "sedang-kepala";
    const title = document.createElement("b");
    title.className = "sedang-judul";
    title.textContent = k.judul;
    top.append(title);
    if (k.otomatis) {
      const badge = document.createElement("span");
      badge.className = "sedang-lencana";
      badge.textContent = language === "en" ? "Automatic" : "Otomatis";
      top.append(badge);
    }
    const details = document.createElement("details");
    details.className = "sedang-rincian";
    const summary = document.createElement("summary");
    summary.textContent = language === "en" ? "Details" : "Rincian";
    const facts = [
      k.rincian.alat && (language === "en" ? "Tool: " : "Alat: ") + k.rincian.alat,
      k.rincian.berkas && (language === "en" ? "File: " : "Berkas: ") + k.rincian.berkas,
      k.rincian.catatanGiliran,
    ].filter(Boolean);
    details.append(summary, para("sedang-fakta", facts.join(" · ")));
    card.append(
      top,
      para("sedang-asal", k.asal),
      para("sedang-tujuan", k.tujuan),
      para("sedang-langkah", k.langkah),
      para("sedang-giliran", k.giliran),
      para("sedang-biaya", k.biaya),
      details,
    );
    box.append(card);
  }
}
async function refreshHistory() {
  const all = (await api.history()).filter((r) => !r.parentRunId);
  void renderSedangDikerjakan(all).catch(() => {});
  // Bridge (queue) runs are labelled "Otomatis" and hidden by default; "Semua" shows them.
  const filter = window.miganRunsFilter;
  const mode = $("historyFilter")?.value || filter.DEFAULT_MODE;
  const runs = filter.filterRuns(all, mode);
  $("history").replaceChildren();
  $("taskCount").textContent = String(runs.length);
  const empty = filter.emptyText(mode, all.length, runs.length);
  if (empty) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = empty;
    $("history").append(p);
  }
  for (const r of runs) {
    const b = document.createElement("button");
    b.setAttribute("aria-current", String(r.id === previousId));
    b.textContent = r.title;
    if (filter.isAutomatic(r)) {
      const tag = document.createElement("span");
      tag.className = "run-origin-tag";
      tag.textContent = filter.label;
      b.append(" ", tag);
    }
    const small = document.createElement("small");
    small.textContent =
      runStatusLabel(r.status) +
      " · " +
      new Date(r.created).toLocaleDateString();
    small.title = "Status: " + r.status;
    b.append(small);
    b.onclick = safe(async () => {
      if (busy)
        throw Error("Hentikan tugas aktif dahulu / Stop the active task first");
      await showRun(r.id);
    });
    $("history").append(b);
  }
}
if ($("historyFilter")) $("historyFilter").onchange = safe(refreshHistory);
async function showRun(id) {
  const r = await api.loadRun(id);
  if (busy) return; // A bridge start while loading owns the visible thread.
  previousId = id;
  memorySources.reset({ historical: true });
  $("welcome").hidden = true;
  $("messages").replaceChildren();
  $("activity").replaceChildren();
  addMessage("user", r.prompt);
  for (const e of r.events) {
    memorySources.event(e);
    if (e.type === "assistant") addMessage("assistant", e.text);
    if (e.type === "model.dipilih") showModelChoice(e);
    if (e.type === "model.cadangan") showModelFallback(e);
    else if (e.type === "model.saldo") showModelNote(window.miganModelChoice.saldoText(e));
    else if (e.type === "model.alamat") showModelNote(window.miganModelChoice.alamatText(e));
    if (e.type.startsWith("tool-")) addActivity(e);
  }
  if (r.error) addErrorMessage(r.error, r.errorCode);
  $("runStatus").textContent =
    runStatusLabel(r.status) +
    " · " +
    r.profile.provider +
    " / " +
    r.profile.model +
    " · " +
    r.workspace;
  if (r.validation)
    $("runStatus").textContent += " · acceptance: " + r.validation.status;
  $("prompt").placeholder = "Lanjutkan pekerjaan ini / Continue this task";
  updateBadge();
  galaxy?.event({
    type: "finish",
    profile: r.profile,
    status: r.status,
    error: r.error,
    usage: r.usage,
    validation: r.validation,
  });
  await refreshHistory();
}
// Settings › Harga model: one row per built-in or owner model; numbers are validated on save.
function priceRow(row = {}) {
  const box = document.createElement("div");
  box.className = "price-row";
  const field = (key, label) => {
    const input = document.createElement("input");
    input.dataset.key = key;
    input.setAttribute("aria-label", label + " " + (row.model || "model baru"));
    input.value = row[key] ?? "";
    if (key === "model") {
      input.placeholder = "kimi/nama-model";
      input.readOnly = !!row.bawaan;
    } else input.inputMode = "decimal";
    return input;
  };
  box.append(
    field("model", "Model"),
    field("input", "Input"),
    field("output", "Output"),
    field("cached", "Baca cache"),
    field("cacheCreated", "Tulis cache"),
  );
  const action = document.createElement("button");
  action.type = "button";
  if (row.bawaan) {
    action.textContent = "Pakai bawaan";
    action.onclick = () => {
      for (const key of ["input", "output", "cached", "cacheCreated"])
        box.querySelector(`[data-key="${key}"]`).value = row.bawaan[key] ?? "";
    };
  } else {
    action.textContent = "Hapus";
    action.onclick = () => box.remove();
  }
  box.append(action);
  if (row.catatan) {
    const note = document.createElement("small");
    note.className = row.bawaan?.kedaluwarsa ? "price-note warning" : "price-note hint";
    note.textContent = row.catatan;
    box.append(note);
  }
  return box;
}
function showPrices() {
  $("priceRows").replaceChildren(
    ...window.miganPriceTable
      .rowsFor(settings.builtinPrices || [], settings.modelPrices || {})
      .map(priceRow),
  );
}
function collectPrices() {
  const rows = [...$("priceRows").querySelectorAll(".price-row")].map((box) =>
    Object.fromEntries(
      [...box.querySelectorAll("input")].map((i) => [i.dataset.key, i.value]),
    ),
  );
  return window.miganPriceTable.collect(rows, settings.builtinPrices || []);
}
$("addPrice").onclick = () => $("priceRows").append(priceRow());
// A refused run names the step that fixes it, with a button that opens it.
// D3: "pakai model cloud untuk tugas ini" reruns exactly the task that stopped, once, with
// izinkanCadangan (never stored in settings). GATE D3 C2: keyed by the task's taskId, never by a
// global "last task", so another task's stop can never rerun the owner's previous one on a paid model.
const tugasUi = window.miganModelChoice.pencatatTugas(() => crypto.randomUUID());
function addErrorMessage(text, code, taskId) {
  const content = addMessage("error", text);
  window.miganModelChoice.pasangTombolCloud({
    doc: document,
    wadah: content.parentElement,
    ulang: tugasUi.ulangan(taskId, code),
    kirim: safe(async (payload) => {
      setBusy(true);
      $("runStatus").textContent = "Menghubungkan model cloud… / Connecting cloud model…";
      try {
        await api.run(tugasUi.catat(payload));
      } catch (e) {
        setBusy(false);
        addMessage("error", e.message);
      }
    }),
  });
  const action = window.miganPriceTable.errorAction(code);
  if (!action) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "error-action";
  button.textContent = action.label;
  button.onclick = safe(() => openSettings(action.target));
  content.parentElement.append(button);
}
function showSettingsData() {
  if (settings.persistenceWarning) toast(settings.persistenceWarning);
  showPrices();
  const priorModel = $("taskModel").value;
  $("taskModel").replaceChildren(
    ...window.miganModelChoice.optionsFor(settings.taskModels).map((o) => {
      const option = new Option(o.label, o.value);
      option.disabled = o.disabled;
      option.title = o.title;
      return option;
    }),
  );
  if ([...$("taskModel").options].some((o) => o.value === priorModel && !o.disabled))
    $("taskModel").value = priorModel;
  showRunpodSlot();
  void showGeminiSlot().catch((e) => ($("geminiError").textContent = e.message));
  $("modelRegistry").value = JSON.stringify(
    settings.modelRegistry || [],
    null,
    2,
  );
  $("routeMap").value = JSON.stringify(settings.routeMap || {}, null, 2);
  $("credentialKey").value = "";
  $("credentialId").value = "";
  $("credentialList").textContent = (settings.credentialInfo || [])
    .map(
      (c) =>
        c.label +
        " · " +
        c.provider +
        " · " +
        (c.configured ? "tersimpan" : "belum diisi"),
    )
    .join("\n");
  $("activeProvider").value = settings.active;
  $("appVersion").textContent = settings.version ? "v" + settings.version : "";
  // Braces matter: without them the workspace line ran outside the loop ("p is not defined",
  // since alpha.19) and every setting below it was never shown.
  for (const p of ["openai", "anthropic", "kimi", "ollama"]) {
    $(p + "Model").value = settings.profiles[p].model || "";
    if (p === "anthropic")
      $("anthropicWorkspace").value = settings.profiles.anthropic.workspaceId || "";
  }
  $("ollamaURL").value = settings.profiles.ollama.baseURL || "";
  $("ollamaCadangan").value = (settings.profiles.ollama.alamatCadangan || []).join(", ");
  for (const p of ["openai", "anthropic", "kimi"]) {
    $(p + "Key").value = "";
    $(p + "Configured").textContent = settings.configured[p]
      ? "✓ Tersimpan aman di brankas Windows — tidak perlu diisi ulang"
      : "Belum ada kunci / No stored key";
    $(p + "Key").placeholder = settings.configured[p]
      ? "•••••••• · tersimpan di brankas"
      : "Tempel API key di sini";
  }
  $("lightRoute").value = settings.routes.light || "";
  $("codingRoute").value = settings.routes.coding || "";
  $("maxTurns").value = settings.maxTurns;
  // Pindah-workspace: owner-registered dev roots (server re-validates with validateDevRoots).
  $("devRoots").value = window.miganDevRoots.format(settings.devRoots);
  $("devRootsStatus").textContent = window.miganDevRoots.summary(settings.devRoots);
  $("devRootsError").textContent = "";
  renderTerminalTiers();
  $("memoryEnabled").checked = !!settings.memoryEnabled;
  // GATE S2 P1: Brain is opt-in and per API provider; the server drops locked providers.
  $("brainAktif").checked = settings.brainKonteks?.aktif === true;
  $("brainAnthropic").checked = settings.brainKonteks?.penyedia?.anthropic === true;
  $("brainOpenai").checked = settings.brainKonteks?.penyedia?.openai === true;
  $("memoryStatus").textContent = settings.mcp.some((m) => m.id === "brain")
    ? "Otak eksternal terdaftar — mulai saat disetujui / Registered, starts on approval"
    : "Belum tersambung / Not connected";
  $("mcpConfig").value = JSON.stringify(settings.mcp, null, 2);
  $("workspacePath").textContent = settings.workspace;
  updateBadge();
  refreshTeamChoices();
}
function updateBadge() {
  const selection = $("taskModel").value;
  const named = (settings.modelRegistry || []).find((p) => p.id === selection);
  const provider =
    settings.routes[mode === "ask" ? "light" : "coding"] || settings.active;
  const model = settings.profiles[provider]?.model;
  // U1: the chip is always the model for the NEXT task; the running task's model is in the task control.
  const next = {
    selection: selection === "auto" ? "auto" : "",
    next: named
      ? named.label + " / " + named.model
      : model
        ? provider + " / " + model
        : "",
  };
  $("routeBadge").textContent = window.miganTeksAwam.modelLabel(
    { slot: "chip", ...next },
    language,
  );
  galaxy?.setContext(settings, next);
  renderModeHint();
}
// Spec section 5: the hint follows the selected mode, the build folder, the language and the busy lock.
function renderModeHint() {
  const hint = $("modeHint");
  if (!hint) return;
  document
    .querySelectorAll("[data-mode]")
    .forEach((b) =>
      b.setAttribute("aria-pressed", String(b.dataset.mode === mode)),
    );
  const main = document.createElement("span");
  main.textContent = window.miganTeksAwam.modeHint(
    mode,
    buildTarget()?.kind === "existing" ? "current" : "new",
    language,
  );
  hint.replaceChildren(main);
  if (busy) {
    const lock = document.createElement("span");
    lock.className = "mode-hint-busy";
    lock.textContent = window.miganTeksAwam.modeBusyHint(language);
    hint.append(lock);
  }
}
// Live preview (ARS-004 §13, K05): the guest view is placed over #livePreview by the main process.
let livePreviewToken = null;
async function livePreviewLayout() {
  if (!livePreviewToken) return;
  const r = $("livePreview").getBoundingClientRect();
  await api.openPreview({
    token: livePreviewToken,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
    visible:
      tab === "files" &&
      !$("inspector").hidden &&
      !$("filePreview").hidden &&
      r.width > 0 &&
      r.height > 0,
  });
}
async function showLivePreview(p) {
  await hideLivePreview();
  $("fileText").textContent = "";
  $("fileText").hidden = true;
  $("livePreview").hidden = false;
  livePreviewToken = (await api.previewArtifact(p)).token;
  await livePreviewLayout();
}
async function hideLivePreview() {
  const token = livePreviewToken;
  livePreviewToken = null;
  $("livePreview").hidden = true;
  $("fileText").hidden = false;
  if (token) await api.closePreview(token);
}
new ResizeObserver(() => livePreviewLayout().catch(() => {})).observe(
  $("livePreview"),
);
const number = (n) =>
  Number(n || 0).toLocaleString(language === "en" ? "en-US" : "id-ID");
// Otomatis records why it chose the model; shown as a note in the conversation.
function showModelChoice(e) {
  const content = addMessage("note", "Model dipilih otomatis: " + e.model + " (" + e.profileId + ") — " + e.alasan);
  content.parentElement.querySelector(".message-label").textContent = "CATATAN MODEL / MODEL NOTE";
}
function showModelNote(text) {
  const content = addMessage("note", text);
  content.parentElement.querySelector(".message-label").textContent = "CATATAN MODEL / MODEL NOTE";
}
function showModelFallback(e) {
  const content = addMessage("note", window.miganModelChoice.fallbackText(e));
  content.parentElement.querySelector(".message-label").textContent = "MODEL CADANGAN / FALLBACK";
}
// U5: one plain cost sentence; token counts, byte budgets and technical notes sit behind "Rincian".
let lastUsage = null;
let lastFinishUsage = null;
let usageRunning = false;
let runProvider = "";
let runHadTeam = false;
function renderUsage(u, running = usageRunning) {
  const line = $("usageLine");
  const en = language === "en";
  if (!u) return;
  lastUsage = u;
  usageRunning = running;
  const sentence = document.createElement("span");
  sentence.className = "usage-sentence";
  sentence.textContent = window.miganTeksAwam.usageText(
    {
      state: window.miganTeksAwam.usageState(u, runProvider),
      usd: u.cost,
      running,
      teamExcluded: runHadTeam,
    },
    language,
  );
  const parts = [
    (en ? "Tokens: " : "Token: ") +
      number(u.inputTokens) +
      (en ? " in · " : " masuk · ") +
      number(u.outputTokens) +
      (en ? " out" : " keluar"),
    (en ? "estimated input ≈" : "perkiraan masukan ≈") +
      number(u.estimatedInputTokens) +
      (en ? " tokens" : " token") +
      ` (${number(u.inputBytes)}/${number(u.inputBudget)} byte)`,
    (en ? "per-request limit " : "batas per permintaan ") +
      number(u.requestLimit) +
      " byte",
  ];
  if (u.limitNote) parts.push(u.limitNote);
  parts.push(u.costNote || (u.cost === null ? "" : String(u.cost)));
  if (lastFinishUsage) parts.push(lastFinishUsage);
  const details = document.createElement("details");
  details.className = "usage-detail";
  const summary = document.createElement("summary");
  summary.textContent = en ? "Details" : "Rincian";
  const body = document.createElement("p");
  body.textContent = parts.filter(Boolean).join(" · ");
  details.append(summary, body);
  line.replaceChildren(sentence, details);
  line.hidden = false;
}
// Run ended: the same sentence turns from "so far" to the task total; finish counters join Rincian.
function finishUsage(usage) {
  lastFinishUsage =
    usage.available === false
      ? "usage unavailable"
      : `input ${usage.input} / output ${usage.output} / cache read ${usage.cached} / cache write ${usage.cacheCreated || 0} tokens`;
  if (lastUsage) renderUsage(lastUsage, false);
}
async function browserLayout() {
  const surface = $("browserSurface");
  const r = surface.getBoundingClientRect();
  await api.browserLayout(
    { x: r.x, y: r.y, width: r.width, height: r.height },
    tab === "browser" &&
      !$("inspector").hidden &&
      r.width > 0 &&
      r.height > 0 &&
      !$("settingsDialog").open &&
      !$("whatsNewDialog").open &&
      !$("approvalDialog").open,
  );
}
async function switchTab(next) {
  // Beranda is where the HOLD banner lives: recompute it every time Beranda opens.
  if (next === "home") void refreshHoldBanner();
  await workspaceTabs?.select("chat");
  if (
    ![
      "files",
      "browser",
      "activity",
      "computer",
      "research",
      "recovery",
      "skills",
      "memory",
    ].includes(next)
  )
    return;
  tab = next;
  for (const name of [
    "files",
    "browser",
    "activity",
    "computer",
    "research",
    "recovery",
    "skills",
    "memory",
  ])
    $(name + "Pane").hidden = name !== next;
  galaxy?.selectView(next);
  await browserLayout();
  await livePreviewLayout();
  if (next === "research") await refreshResearch();
  if (next === "recovery") await refreshRecovery();
  if (next === "skills") await refreshSkills();
  if (next === "memory") await refreshMemory();
}
async function refreshMemory() {
  const revision = ++memoryRevision;
  const result = await api.memory($("memoryQuery").value);
  if (revision !== memoryRevision) return;
  $("memoryList").replaceChildren();
  for (const note of result.records) {
    const card = document.createElement("article");
    card.className = "memory-note";
    const content = document.createElement("p");
    content.textContent = note.content;
    const provenance = document.createElement("small");
    provenance.textContent =
      (note.kind === "user-note"
        ? language === "id"
          ? "Catatan Anda"
          : "Your note"
        : language === "id"
          ? "Ringkasan sesi"
          : "Session summary") +
      " · " +
      note.source +
      " · " +
      new Date(note.created).toLocaleDateString();
    card.append(content, provenance);
    $("memoryList").append(card);
  }
  if (!result.records.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      language === "id"
        ? "Belum ada catatan yang cocok di folder ini."
        : "No matching notes in this folder.";
    $("memoryList").append(empty);
  }
}
$("memorySearchForm").onsubmit = safe(async (event) => {
  event.preventDefault();
  await refreshMemory();
});
$("memoryNoteForm").onsubmit = safe(async (event) => {
  event.preventDefault();
  if (busy) return;
  const content = $("memoryNote").value.trim();
  if (!content) return;
  const workspace = settings.workspace;
  $("memorySave").disabled = true;
  $("pickFolder").disabled = true;
  $("memoryNote").readOnly = true;
  try {
    await api.memoryNote(content);
    if (settings.workspace !== workspace) return;
    $("memoryNote").value = "";
    $("memoryQuery").value = "";
    $("notesStatus").textContent =
      language === "id"
        ? "Catatan tersimpan untuk folder ini."
        : "Note saved for this folder.";
    await refreshMemory();
  } finally {
    $("memorySave").disabled = busy;
    $("pickFolder").disabled = busy;
    $("memoryNote").readOnly = false;
  }
});
async function recoveryAction(fn) {
  setBusy(true);
  try {
    return await fn();
  } finally {
    setBusy(false);
    await refreshRecovery();
  }
}
function actionButton(label, fn) {
  const button = document.createElement("button");
  button.textContent = label;
  button.onclick = safe(fn);
  return button;
}
// focusId: the HOLD the Home banner named; that card (or the only one) opens, so the note field
// and the confirm button are visible without hunting for a closed <details>.
async function refreshRecovery(focusId) {
  const jobs = await api.recoveryList();
  $("recoveryList").replaceChildren();
  for (const job of jobs) {
    const card = document.createElement("details");
    card.className = "recovery-card";
    card.dataset.id = job.id;
    card.open = jobs.length === 1 || job.id === focusId;
    // 06xc: plain-language summary from periksaHold; missing data fails closed to "periksa dulu".
    const kartu = window.miganKartuHold.describe(job.periksa);
    const title = document.createElement("summary");
    title.textContent =
      "HOLD · " + (job.periksa ? kartu.judul : job.kind + " · " + job.id.slice(0, 8));
    const plain = document.createElement("div");
    plain.className = "recovery-plain";
    const line = (label, value) => {
      const p = document.createElement("p");
      const b = document.createElement("strong");
      b.textContent = label + ": ";
      p.append(b, value);
      return p;
    };
    const files = document.createElement("ul");
    files.className = "recovery-files";
    for (const f of kartu.berkas) {
      const li = document.createElement("li");
      li.textContent = f;
      files.append(li);
    }
    const advice = document.createElement("p");
    advice.className = kartu.aman ? "recovery-advice safe" : "recovery-advice check";
    advice.setAttribute("role", "status");
    advice.textContent = kartu.rekomendasiTeks;
    plain.append(
      line("Tugas", kartu.judul),
      line("Tujuan", kartu.tujuan),
      line("Langkah terakhir", kartu.langkah),
      line("Alat terputus", kartu.alat),
      line("Berkas", kartu.berkasTeks),
      files,
      line("Proses", kartu.proses),
      advice,
    );
    // Raw JSON stays available, but only in a closed detail.
    const raw = document.createElement("details");
    raw.open = false;
    const rawTitle = document.createElement("summary");
    rawTitle.textContent = "Detail teknis";
    const info = document.createElement("pre");
    info.textContent = JSON.stringify(
      { reason: job.reason, pid: job.pid, observation: job.observation, periksa: job.periksa },
      null,
      2,
    );
    raw.append(rawTitle, info);
    const note = document.createElement("textarea");
    note.placeholder =
      "Hasil pemeriksaan efek sebelumnya (minimal 10 karakter)";
    note.setAttribute("aria-label", "Catatan rekonsiliasi");
    // Prefilled from the automatic inspection; the owner still has to click confirm.
    note.value = kartu.catatan;
    const terminate = actionButton("Hentikan proses milik tugas", () =>
      recoveryAction(() => api.recoveryTerminate(job.id)),
    );
    const confirm = actionButton("Konfirmasi efek sudah diperiksa", () =>
      recoveryAction(() => api.recoveryResolve(job.id, note.value)),
    );
    card.append(
      title,
      plain,
      raw,
      actionButton("Periksa proses", async () => {
        raw.open = true;
        info.textContent = JSON.stringify(
          await api.recoveryInspect(job.id),
          null,
          2,
        );
      }),
      terminate,
      note,
      confirm,
    );
    // The app refuses both while a run is active; say so instead of a silent refusal.
    if (busy) {
      terminate.disabled = true;
      confirm.disabled = true;
      const why = document.createElement("p");
      why.className = "hint";
      why.textContent =
        "Hentikan pekerjaan yang sedang berjalan dulu, lalu tombol ini bisa dipakai.";
      card.append(why);
    }
    $("recoveryList").append(card);
  }
  if (!jobs.length)
    $("recoveryList").textContent =
      "Tidak ada efek terputus yang menunggu pemeriksaan.";
  const candidates = await api.improvementList();
  $("improvementList").replaceChildren();
  for (const c of candidates) {
    const card = document.createElement("details");
    card.className = "reference-card";
    const title = document.createElement("summary");
    title.textContent = c.status + " · " + c.goal;
    const info = document.createElement("pre");
    info.textContent = JSON.stringify(
      {
        id: c.id,
        attempts: c.attempts,
        candidateHash: c.candidateHash,
        base: c.baseVerdict?.status,
        verdict: c.verdict,
        error: c.error,
        diff: c.diff,
        directory: c.directory,
      },
      null,
      2,
    );
    card.append(title, info);
    if (c.status === "created")
      card.append(
        actionButton("Perbaiki dengan Opus 5.5", () =>
          recoveryAction(async () => {
            const result = await api.improvementRepair(c.id);
            $("improvementStatus").textContent =
              result.status +
              (result.error
                ? " · " + result.error
                : " · base FAIL → candidate PASS");
          }),
        ),
      );
    if (c.status === "validated")
      card.append(
        actionButton("Aktifkan versi teruji", () =>
          recoveryAction(() =>
            api.improvementActivate(c.id, c.candidateHash, c.verdict.id),
          ),
        ),
      );
    if (c.status === "active") {
      card.append(
        actionButton("Uji versi aktif", () =>
          recoveryAction(async () => {
            $("improvementStatus").textContent = (
              await api.improvementTest(c.id)
            ).status;
          }),
        ),
      );
      const invocation = document.createElement("textarea");
      invocation.placeholder =
        '{"module":"src/example.mjs","exportName":"run","args":[]}';
      invocation.setAttribute("aria-label", "Panggilan versi aktif (JSON)");
      card.append(
        invocation,
        actionButton("Jalankan versi aktif", () =>
          recoveryAction(async () => {
            $("improvementStatus").textContent = JSON.stringify(
              await api.improvementExecute(
                c.id,
                c.candidateHash,
                JSON.parse(invocation.value),
              ),
            );
          }),
        ),
      );
    }
    $("improvementList").append(card);
  }
}
$("refreshRecovery").onclick = safe(refreshRecovery);
$("improvementForm").onsubmit = safe(async (event) => {
  event.preventDefault();
  const lines = (id) =>
    $(id)
      .value.split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  await api.improvementCreate({
    goal: $("improvementGoal").value,
    files: lines("improvementFiles"),
    editable: lines("improvementEditable"),
    tests: lines("improvementTests"),
  });
  await refreshRecovery();
});
async function refreshResearch() {
  const rows = await api.researchList($("researchQuery").value);
  $("researchList").replaceChildren();
  for (const r of rows) {
    const card = document.createElement("details");
    card.className = "reference-card";
    const summary = document.createElement("summary");
    summary.textContent = r.title + " · " + r.stage;
    const link = document.createElement("p");
    link.textContent = r.url;
    const title = document.createElement("input");
    title.value = r.title;
    title.setAttribute("aria-label", "Judul referensi");
    const note = document.createElement("textarea");
    note.value = r.note;
    note.placeholder = "Bukti sumber primer, batas, dan alasan adopsi";
    note.setAttribute("aria-label", "Catatan referensi");
    const stage = document.createElement("select");
    stage.setAttribute("aria-label", "Status referensi");
    for (const s of [
      "queued",
      "source-read",
      "primary-checked",
      "adopted",
      "deferred",
      "inaccessible",
    ])
      stage.append(new Option(s, s));
    stage.value = r.stage;
    const save = document.createElement("button");
    save.textContent = "Simpan catatan";
    save.onclick = safe(async () => {
      await api.researchAnnotate({
        id: r.id,
        title: title.value,
        note: note.value,
        stage: stage.value,
      });
      await refreshResearch();
    });
    const use = document.createElement("button");
    use.textContent = "Susun brief riset";
    use.onclick = () => {
      $("prompt").value =
        "Riset referensi " +
        r.url +
        " . Tujuan: pahami mekanisme, cari sumber primer dan lisensi, bandingkan dengan tool milik saya, usulkan adopsi yang ringan dan tes penerimaan. Catatan pemilik (belum diverifikasi): " +
        note.value +
        " . Jangan memasang atau menjalankan kode dari halaman. Laporkan yang belum terjangkau.";
      document.querySelector('[data-mode="work"]').click();
      $("prompt").focus();
    };
    card.append(summary, link, title, note, stage, save, use);
    $("researchList").append(card);
  }
  $("researchStatus").textContent =
    rows.length +
    " referensi ditampilkan (maks. 100) · status/catatan dari pemilik";
}
$("researchImportForm").onsubmit = safe(async (e) => {
  e.preventDefault();
  const result = await api.researchImport($("researchURLs").value);
  $("researchURLs").value = "";
  await refreshResearch();
  toast(result.added + " referensi disimpan · tidak ada panggilan model");
});
$("researchQuery").oninput = safe(refreshResearch);
$("researchCatalog").onclick = safe(async () => {
  $("researchURLs").value = (await api.researchCatalog()).join("\n");
  toast(
    "Katalog siap ditinjau. Simpan untuk memasukkan metadata; halaman tidak diambil otomatis.",
  );
});
$("researchExport").onclick = safe(async () => {
  const r = await api.researchExport();
  $("researchStatus").textContent =
    "Artifact: " + r.path + " · SHA256 " + r.sha256;
});
async function openSettings(target) {
  if (busy)
    throw Error("Hentikan pekerjaan aktif dahulu / Stop active work first");
  showSettingsData();
  $("settingsError").textContent = "";
  $("settingsDialog").showModal();
  if (typeof target === "string") {
    const section = $(target);
    if (section?.tagName === "DETAILS") section.open = true;
    section?.scrollIntoView({ block: "start" });
  }
  await browserLayout();
}
async function newTask() {
  if (!busy) await workspaceTabs?.select("chat");
  if (busy)
    throw Error("Hentikan pekerjaan aktif dahulu / Stop active work first");
  previousId = null;
  memorySources.reset();
  $("conversationScroll").scrollTop = 0;
  $("messages").replaceChildren();
  $("activity").replaceChildren();
  $("usageLine").hidden = true;
  $("usageLine").textContent = "";
  lastUsage = lastFinishUsage = null;
  usageRunning = false;
  $("welcome").hidden = false;
  $("runStatus").textContent = "";
  $("prompt").value = "";
  $("prompt").focus();
  document
    .querySelectorAll("#history [aria-current]")
    .forEach((button) => button.setAttribute("aria-current", "false"));
  galaxy?.reset();
  updateBadge();
  galaxy?.selectView("home");
}
$("testConnection").onclick = safe(async () => {
  const b = $("testConnection");
  b.disabled = true;
  $("connectionResult").textContent =
    "Menguji koneksi yang sudah disimpan… / Testing saved connection…";
  try {
    settings = await api.saveSettings(collectSettings());
    showSettingsData();
    const r = await api.testConnection();
    $("connectionResult").textContent =
      r.provider + " / " + r.model + " · " + r.latencyMs + " ms · " + r.text;
  } catch (error) {
    // Shown next to the button, so a workspace or key problem is caught before any task runs.
    $("connectionResult").textContent = error.message;
    throw error;
  } finally {
    b.disabled = false;
  }
});
function renderWhatsNew(model) {
  const content = $("whatsNewContent");
  content.replaceChildren();
  const title = document.createElement("h3");
  title.id = "whatsNewVersion";
  title.textContent = model.judul;
  content.append(title);
  for (const group of model.bagian) {
    const section = document.createElement("section");
    section.className = "whats-new-group";
    const heading = document.createElement("h4");
    heading.textContent = group.judul;
    section.append(heading);
    if (group.butir.length) {
      const list = document.createElement("ul");
      for (const text of group.butir) {
        const item = document.createElement("li");
        item.textContent = text;
        list.append(item);
      }
      section.append(list);
    } else {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "Tidak ada catatan pada bagian ini.";
      section.append(empty);
    }
    content.append(section);
  }
}
async function openWhatsNew() {
  const content = $("whatsNewContent");
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Membuka catatan versi…";
  content.replaceChildren(loading);
  $("whatsNewDialog").showModal();
  try {
    await browserLayout();
    const data = await api.whatsNew();
    renderWhatsNew(window.miganApaYangBaru.buatModel(data));
  } catch (error) {
    const message = document.createElement("p");
    message.className = "warning";
    message.setAttribute("role", "alert");
    message.textContent = "Catatan versi belum bisa dibuka. Coba lagi. " + error.message;
    content.replaceChildren(message);
  }
}
$("whatsNewBtn").onclick = safe(openWhatsNew);
$("closeWhatsNew").onclick = () => $("whatsNewDialog").close();
$("whatsNewDialog").addEventListener("close", () => {
  void browserLayout().catch((error) => toast(error.message));
});
$("newTask").onclick = safe(newTask);
$("settingsBtn").onclick = safe(openSettings);
// C1 Agen panel (D-006): read-only cards from agentCatalog, live labels from agen.status.
const agentStatusLabels = new Map();
let teamCards = [];
let teamReadOnly = false;
function syncTeamFlags() {
  if ($("taskTeamSummary"))
    $("taskTeamSummary").textContent =
      $("taskTeam").selectedOptions[0]?.textContent ||
      (language === "en" ? "Migan only" : "Migan saja");
  $("taskTeamQuick").textContent =
    (language === "en" ? "Team: " : "Tim: ") + $("taskTeamSummary").textContent;
  $("taskTeamQuick").title =
    (language === "en" ? "View and change team: " : "Lihat dan ubah tim: ") +
    $("taskTeamSummary").textContent;
  for (const id of ["teamTemporary", "teamLearn"]) {
    $(id).disabled = busy || !$("taskTeam").value;
    if (!$("taskTeam").value) $(id).checked = false;
  }
}
function profileConfigured(profile) {
  return (
    profile.provider === "ollama" ||
    (settings.credentialInfo || []).some(
      (c) =>
        c.id === (profile.credentialId || profile.provider) && c.configured,
    )
  );
}
function syncTeamControls() {
  $("saveTeamMember").disabled =
    busy || teamReadOnly || !$("teamMemberModel").options.length;
  for (const button of document.querySelectorAll(
    "#agentsList .agent-remove, #agentsList .agent-use",
  ))
    button.disabled =
      busy ||
      teamReadOnly ||
      (button.classList.contains("agent-use") &&
        !Array.from($("taskTeam").options).some(
          (o) => o.value === "agent:" + button.dataset.agentId && !o.disabled,
        ));
}
function syncTeamAccess() {
  const profile = (settings.modelRegistry || []).find(
    (p) => p.id === $("teamMemberModel").value,
  );
  for (const option of $("teamMemberAccess").options)
    option.disabled =
      option.value !== "none" && !profile?.capabilities?.includes("tools");
  if ($("teamMemberAccess").selectedOptions[0]?.disabled)
    $("teamMemberAccess").value = "none";
}
function refreshTeamChoices(cards = teamCards) {
  teamCards = cards;
  const select = $("taskTeam"),
    previous = select.value;
  select.replaceChildren(
    new Option(language === "en" ? "Migan only" : "Migan saja", ""),
  );
  const members = cards.filter(
    (c) =>
      c.id !== "migan" &&
      c.jenis === "tetap" &&
      (settings.modelRegistry || []).some(
        (p) => p.id === c.profilModel && p.enabled !== false,
      ),
  );
  for (const card of members)
    select.append(new Option("Migan + " + card.nama, "agent:" + card.id));
  for (const count of [2, 3])
    if (members.length >= count)
      select.append(
        new Option(
          (language === "en" ? "Team · " : "Tim · ") +
            members
              .slice(0, count)
              .map((c) => c.nama)
              .join(" + "),
          "council:" +
            members
              .slice(0, count)
              .map((c) => c.id)
              .join(","),
        ),
      );
  if ([...select.options].some((o) => o.value === previous))
    select.value = previous;
  syncTeamFlags();
}
function selectedDelegation() {
  const value = $("taskTeam").value;
  if (!value) return undefined;
  const eligible = teamCards.filter(
    (c) =>
      c.id !== "migan" &&
      c.jenis === "tetap" &&
      (settings.modelRegistry || []).some(
        (p) => p.id === c.profilModel && p.enabled !== false,
      ),
  );
  const ids = value.slice(value.indexOf(":") + 1).split(",");
  if (
    !ids.every((id) => eligible.some((c) => c.id === id)) ||
    new Set(ids).size !== ids.length ||
    (value.startsWith("agent:")
      ? ids.length !== 1
      : !value.startsWith("council:") || ![2, 3].includes(ids.length))
  )
    throw Error(
      language === "en"
        ? "Team changed; select its members again"
        : "Tim berubah; pilih kembali anggota",
    );
  return {
    jalur: value.startsWith("agent:") ? "panggil" : "majelis",
    agen: ids,
    ...($("teamTemporary").checked ? { temporary: true } : {}),
  };
}
let employeeTemplates = [],
  selectedEmployeeCard = "migan";
function renderAgents(view) {
  teamReadOnly = !!view.warning;
  refreshTeamChoices(view.cards);
  const list = $("agentsList");
  list.replaceChildren();
  $("agentsWarning").hidden = !view.warning;
  $("agentsWarning").textContent = view.warning || "";
  for (const card of view.cards) {
    const item = document.createElement("li");
    item.className = "agent-card";
    item.dataset.agentId = card.id;
    const face = document.createElement("span");
    face.className = "agent-face";
    face.textContent = (card.nama || "?").slice(0, 1).toUpperCase();
    face.style.setProperty("--agent-color", card.warna || "var(--accent)");
    if (card.id === "migan") {
      face.textContent = "";
      const logo = document.createElement("img");
      logo.src = "assets/migancore-logo.svg";
      logo.alt = "";
      logo.width = 33;
      logo.height = 23;
      face.append(logo);
    }
    const body = document.createElement("div");
    body.className = "agent-card-body";
    const name = document.createElement("strong");
    name.textContent = card.nama;
    const meta = document.createElement("span");
    meta.className = "agent-meta";
    meta.textContent = [
      card.jenis === "bayangan"
        ? language === "en"
          ? "shadow"
          : "bayangan"
        : language === "en"
          ? "permanent"
          : "tetap",
      card.lencana,
      (settings.modelRegistry || []).find((p) => p.id === card.profilModel)
        ?.label || card.profilModel,
    ]
      .filter(Boolean)
      .join(" · ");
    const status = document.createElement("span");
    status.className = "agent-status";
    status.textContent =
      agentStatusLabels.get(card.id) ||
      (language === "en" ? "Ready to help" : "Siap membantu");
    const role = document.createElement("span");
    role.className = "agent-role";
    role.textContent =
      card.id === "migan"
        ? language === "en"
          ? "Main assistant · cross-domain"
          : "Pendamping utama · lintas bidang"
        : card.employeeProfile?.role ||
          (language === "en" ? "Team member" : "Anggota tim");
    body.append(name, role, meta, status);
    item.append(face, body);
    if (card.dapatDihapus && card.jenis === "tetap") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "agent-remove";
      remove.textContent = language === "en" ? "Remove" : "Hapus";
      remove.disabled = busy || !!view.warning;
      remove.onclick = safe(async () => {
        const updated = await api.teamMemberRemove(card.id);
        ++teamViewRevision;
        renderAgents(updated);
        $("teamConfigMessage").textContent =
          language === "en"
            ? "Agent removed. Work files remain saved."
            : "Agen dihapus dari tim. Berkas kerja tetap tersimpan.";
      });
      item.append(remove);
    }
    if (card.id !== "migan") {
      const profileButton = document.createElement("button");
      profileButton.type = "button";
      profileButton.textContent =
        language === "en" ? "View profile" : "Lihat profil";
      profileButton.onclick = () => {
        selectedEmployeeCard = card.id;
        renderEmployeeDetail(card);
      };
      item.append(profileButton);
    }
    if (card.id !== "migan") {
      const use = document.createElement("button");
      use.type = "button";
      use.className = "agent-use";
      use.dataset.agentId = card.id;
      use.textContent =
        language === "en" ? "Use for this task" : "Gunakan untuk tugas ini";
      use.disabled =
        busy ||
        !Array.from($("taskTeam").options).some(
          (o) => o.value === "agent:" + card.id,
        );
      use.onclick = safe(async () => {
        if (busy) throw Error("Hentikan tugas aktif sebelum mengganti tim.");
        if (
          !Array.from($("taskTeam").options).some(
            (o) => o.value === "agent:" + card.id && !o.disabled,
          )
        )
          throw Error("Hubungkan profil model karyawan ini terlebih dahulu.");
        $("taskTeam").value = "agent:" + card.id;
        syncTeamFlags();
        await workspaceTabs.select("chat");
        await galaxy.showInspector();
        $("taskTeamSettings").open = true;
        $("prompt").focus();
        toast(
          card.nama +
            (language === "en"
              ? " selected; press Start when ready."
              : " dipilih. Tekan Mulai saat siap."),
        );
      });
      item.append(use);
    }
    list.append(item);
  }
  $("teamStats").textContent =
    (language === "en" ? "Team members: " : "Anggota tim: ") +
    view.cards.length;
  renderEmployeeDetail(
    view.cards.find((c) => c.id === selectedEmployeeCard) || view.cards[0],
  );
}
function renderEmployeeDetail(card) {
  const box = $("employeeDetail");
  box.replaceChildren();
  if (!card) return;
  const make = (tag, text) => {
      const e = document.createElement(tag);
      e.textContent = text;
      return e;
    },
    p = card.employeeProfile;
  box.append(
    make(
      "span",
      card.id === "migan"
        ? language === "en"
          ? "MAIN ASSISTANT"
          : "PENDAMPING UTAMA"
        : language === "en"
          ? "EMPLOYEE PROFILE"
          : "PROFIL KARYAWAN",
    ),
    make("h3", card.nama),
    make(
      "p",
      p?.role ||
        (card.id === "migan"
          ? "Generalis lintas bidang. Menyusun langkah dan menggabungkan hasil tim."
          : "Membantu sesuai profil dan batas akses pilihan pemilik."),
    ),
  );
  if (p?.style)
    box.append(make("p", (language === "en" ? "Style: " : "Gaya: ") + p.style));
  if (p?.bio) box.append(make("p", p.bio));
  const tags = make("div", "");
  tags.className = "employee-tags";
  for (const s of p?.specialties || []) tags.append(make("span", s));
  box.append(tags);
  const details = make("details", "");
  details.append(
    make(
      "summary",
      language === "en" ? "Model and profile source" : "Model dan asal profil",
    ),
  );
  const model = (settings.modelRegistry || []).find(
    (m) => m.id === card.profilModel,
  );
  details.append(
    make(
      "p",
      model
        ? model.label || model.model
        : language === "en"
          ? "Follows Migan's selected connection"
          : "Mengikuti koneksi yang dipilih Migan",
    ),
  );
  if (p?.source)
    details.append(make("p", p.source.project + " · " + p.source.employeeId));
  details.append(
    make(
      "p",
      language === "en"
        ? "Personality does not grant tool permissions."
        : "Personality tidak menambah izin alat.",
    ),
  );
  box.append(details);
}
let teamViewRevision = 0;
async function openAgents() {
  const ticket = ++teamViewRevision;
  const oldModel = $("teamMemberModel").value;
  const [view, statuses, templates] = await Promise.all([
    api.agentCatalog(),
    api.agentStatus(),
    api.employeeProfiles().catch(() => ({
      profiles: [],
      warning: "Profil contoh belum dapat dimuat.",
    })),
  ]);
  if (ticket !== teamViewRevision) return;
  employeeTemplates = templates.profiles || [];
  const oldTemplate = $("employeeTemplate").value;
  $("employeeTemplate").replaceChildren(
    new Option(language === "en" ? "Custom member" : "Anggota sendiri", ""),
    ...employeeTemplates.map((p) => new Option(p.name + " · " + p.role, p.id)),
  );
  if (employeeTemplates.some((p) => p.id === oldTemplate))
    $("employeeTemplate").value = oldTemplate;
  if (view.cards.length === 1) $("teamRecruit").open = true;
  for (const s of statuses)
    if (s.label) agentStatusLabels.set(s.agentId, s.label);
  renderAgents(view);
  $("teamMemberModel").replaceChildren(
    ...(settings.modelRegistry || [])
      .filter((p) => p.enabled !== false && p.capabilities?.includes("text"))
      .map(
        (p) =>
          new Option(
            (p.label || p.model) +
              (profileConfigured(p)
                ? ""
                : language === "en"
                  ? " · key not configured"
                  : " · belum ada kunci"),
            p.id,
          ),
      ),
  );
  if (
    Array.from($("teamMemberModel").options).some((o) => o.value === oldModel)
  )
    $("teamMemberModel").value = oldModel;
  syncTeamAccess();
  syncTeamControls();
  $("teamConfigMessage").textContent =
    view.warning ||
    (!$("teamMemberModel").options.length
      ? language === "en"
        ? "Add a model profile in Connections & settings first."
        : "Tambahkan profil model di Koneksi & pengaturan terlebih dahulu."
      : language === "en"
        ? "File changes still require approval. Profiles contain no keys."
        : "Setiap perubahan berkas tetap meminta izin. Profil tidak memuat kunci.");
  if (templates.warning) $("teamConfigMessage").textContent = templates.warning;
}
$("addTeamMember").onsubmit = safe(async (event) => {
  event?.preventDefault();
  if (busy) throw Error("Hentikan pekerjaan sebelum mengubah tim");
  const view = await api.teamMemberAdd({
    name: $("teamMemberName").value,
    profileId: $("teamMemberModel").value,
    access: $("teamMemberAccess").value,
    ...($("employeeTemplate").value
      ? { employeeProfileId: $("employeeTemplate").value }
      : {}),
  });
  ++teamViewRevision;
  $("teamMemberName").value = "";
  $("employeeTemplate").value = "";
  $("teamMemberAccess").value = "none";
  $("templateDescription").textContent = "";
  renderAgents(view);
  $("teamConfigMessage").textContent =
    language === "en"
      ? "Choose this agent in Team for this task."
      : "Agen siap dipilih pada Tim untuk tugas ini.";
});
$("teamMemberModel").onchange = syncTeamAccess;
$("taskTeam").onchange = syncTeamFlags;
$("taskTeamQuick").onclick = safe(async () => {
  await galaxy.showInspector();
  $("taskTeamSettings").open = true;
  $("taskTeam").focus();
});
api.onAgentStatus((event) => {
  agentStatusLabels.set(event.agentId, event.label);
  const status = document.querySelector(
    `#agentsList .agent-card[data-agent-id="${CSS.escape(event.agentId)}"] .agent-status`,
  );
  if (status) status.textContent = event.label;
});
$("employeeTemplate").onchange = () => {
  const p = employeeTemplates.find((p) => p.id === $("employeeTemplate").value);
  $("templateDescription").textContent = p ? p.role + " · " + p.style : "";
  $("teamMemberName").value = p?.name || "";
  $("teamMemberAccess").value = "none";
};
$("openRecruit").onclick = () => {
  $("teamRecruit").open = true;
  $("employeeTemplate").focus();
};
$("closeAgents").onclick = () => void workspaceTabs.select("chat");
$("connectFirst").onclick = safe(openSettings);
$("folderFirst").onclick = safe(async () => {
  $("pickFolder").click();
});
$("exampleFirst").onclick = () => {
  $("prompt").value =
    "Jelaskan struktur folder ini dan sarankan pekerjaan pertama. Jangan mengubah berkas.";
  $("prompt").focus();
};
$("pickFolder").onclick = safe(async () => {
  const previousWorkspace = settings.workspace;
  settings = await api.pickWorkspace();
  await workspaceChanged(previousWorkspace);
});
async function workspaceChanged(previousWorkspace) {
  if (settings.workspace !== previousWorkspace) {
    $("teamLearn").checked = false;
    $("teamTemporary").checked = false;
    memoryRevision++;
    $("memoryList").replaceChildren();
    $("memoryQuery").value = "";
    $("memoryNote").value = "";
    $("notesStatus").textContent = "";
    await newTask();
    await hideLivePreview();
    $("filePreview").hidden = true;
    $("fileText").textContent = "";
  }
  showSettingsData();
  await Promise.all([
    refreshFiles(),
    refreshSkills(),
    refreshResearch(),
    refreshMemory(),
  ]);
  void refreshHoldBanner();
}
// K06 (ARS-004 §12): build mode writes only into a project folder, or into the open folder when the
// owner explicitly chooses it. The runtime enforces the same rule with checkBuildTarget.
let buildProject = null; // { root, activeRoot, fresh }
let confirmedFolder = null;
async function createNewProject() {
  const name = $("projectName").value.trim();
  $("projectError").textContent = "";
  const previousWorkspace = settings.workspace;
  try {
    const created = await api.createProject({ name });
    buildProject = {
      root: created.root,
      activeRoot: created.activeRoot,
      fresh: true,
    };
  } catch (e) {
    $("projectError").textContent = e.message;
    return false;
  }
  settings = await api.settings();
  await workspaceChanged(previousWorkspace);
  return true;
}
function buildTarget() {
  if (buildProject && settings.workspace === buildProject.root)
    return {
      kind: buildProject.fresh ? "new" : "existing",
      root: buildProject.root,
      activeRoot: buildProject.activeRoot,
      confirmedByOwner: false,
    };
  if (confirmedFolder && settings.workspace === confirmedFolder)
    return {
      kind: "existing",
      root: confirmedFolder,
      activeRoot: confirmedFolder,
      confirmedByOwner: true,
    };
  return null;
}
function askProject() {
  $("projectName").value = "";
  $("projectError").textContent = "";
  $("projectDialog").showModal();
  return new Promise((resolve) => {
    $("cancelProject").onclick = () => {
      $("projectDialog").close();
      resolve(false);
    };
    $("useCurrentFolder").onclick = () => {
      confirmedFolder = settings.workspace;
      renderModeHint();
      $("projectDialog").close();
      resolve(true);
    };
    $("createProjectBtn").onclick = safe(async () => {
      if (await createNewProject()) {
        $("projectDialog").close();
        resolve(true);
      }
    });
  });
}
$("newProject").onclick = safe(async () => {
  $("projectName").value = "";
  $("projectError").textContent = "";
  $("projectDialog").showModal();
  $("cancelProject").onclick = () => $("projectDialog").close();
  $("useCurrentFolder").onclick = () => $("projectDialog").close();
  $("createProjectBtn").onclick = safe(async () => {
    if (await createNewProject()) $("projectDialog").close();
  });
});
$("connectBrain").onclick = safe(async () => {
  settings = await api.connectBrain();
  showSettingsData();
  toast("Otak eksternal terdaftar. Proses hanya berjalan setelah persetujuan tugas.");
});
$("closeSettings").onclick = safe(async () => {
  $("settingsDialog").close();
  await browserLayout();
});
$("settingsDialog").addEventListener("close", () => void browserLayout());
// Slot RunPod: kunci lewat jalur kunci penyedia (keys.runpod); endpointId, model dan
// timeoutSeconds hidup di profil modelRegistry. Kunci tersimpan tidak pernah ditampilkan ulang.
function showRunpodSlot() {
  const p = (settings.modelRegistry || []).find((x) => x.provider === "runpod");
  // The connection renderer owns visibility so a stale hidden state cannot conceal RunPod.
  $("runpodSettings").hidden = false;
  $("runpodKey").value = "";
  $("runpodEndpointId").value = p?.endpointId || "";
  $("runpodModel").value = p?.model || "";
  $("runpodTimeout").value = p?.timeoutSeconds || "";
  $("runpodError").textContent = "";
  const saved = !!settings.configured?.runpod;
  $("runpodConfigured").textContent = saved
    ? language === "en"
      ? "Key saved (\"tersimpan\"); it is never shown again."
      : "Kunci \"tersimpan\"; tidak pernah ditampilkan ulang."
    : language === "en"
      ? "Empty: no key saved yet."
      : "Kosong: belum ada kunci tersimpan.";
}
// Gemini slot: the key field is never refilled; model names come only from models.list via IPC.
async function showGeminiSlot() {
  $("geminiKey").value = "";
  $("geminiError").textContent = "";
  const saved = !!settings.configured?.gemini;
  $("geminiConfigured").textContent = saved
    ? "Kunci \"tersimpan\"; tidak pernah ditampilkan ulang."
    : "Kosong: belum ada kunci tersimpan.";
  const select = $("geminiModels");
  select.disabled = true;
  $("geminiAddModel").disabled = true;
  if (!saved) return;
  const r = await api.geminiModels();
  if (r.error) {
    $("geminiError").textContent = r.error;
    return;
  }
  select.replaceChildren(
    ...r.models.map((m) => {
      const o = document.createElement("option");
      o.value = m.name;
      o.textContent = m.displayName + " (" + m.name + ")";
      o.dataset.input = m.inputTokenLimit || "";
      return o;
    }),
  );
  select.disabled = !r.models.length;
  $("geminiAddModel").disabled = !r.models.length;
  if (!r.models.length) $("geminiError").textContent = "API tidak mengembalikan model generateContent.";
}
$("geminiAddModel").onclick = safe(() => {
  const o = $("geminiModels").selectedOptions[0];
  if (!o?.value) return;
  const registry = window.miganGeminiRegistry.withSelected(
    JSON.parse($("modelRegistry").value || "[]"),
    o,
  );
  $("modelRegistry").value = JSON.stringify(registry, null, 2);
  toast("Model Gemini ditambahkan ke profil. Simpan koneksi untuk memakainya.");
});
function devRootsFromForm() {
  const parsed = window.miganDevRoots.parse($("devRoots").value);
  $("devRootsError").textContent = parsed.error || "";
  if (parsed.error) throw Error(parsed.error);
  return parsed.roots;
}
// Read-only explanation of shell tiers A/B/C/X and the auto-A owner setting (default off).
function renderTerminalTiers() {
  const box = $("terminalTiers");
  if (!box) return;
  try {
    const t = window.miganTerminalTiers;
    box.replaceChildren(
      ...t.tiers.map((tier) => {
        const row = document.createElement("div");
        row.className = "terminal-tier";
        const title = document.createElement("strong");
        title.textContent = tier.title;
        const meaning = document.createElement("p");
        meaning.textContent = tier.meaning + " " + tier.permission;
        row.append(title, meaning);
        return row;
      }),
    );
    const status = t.autoStatus(settings);
    $("terminalAutoA").textContent = status.label + ". " + status.note;
  } catch {
    box.textContent = "Penjelasan tingkat perintah tidak bisa dimuat.";
    $("terminalAutoA").textContent = "";
  }
}
function buildRunpodProfile(existing) {
  const endpointId = $("runpodEndpointId").value.trim();
  const model = $("runpodModel").value.trim();
  const timeout = $("runpodTimeout").value.trim();
  const fail = (id, en) => {
    const message = language === "en" ? en : id;
    $("runpodError").textContent = message;
    throw Error(message);
  };
  $("runpodError").textContent = "";
  if (!endpointId) return null;
  if (!/^[a-z0-9]{8,40}$/.test(endpointId))
    fail(
      "ID endpoint RunPod harus huruf kecil dan angka saja.",
      "RunPod endpoint ID must be lowercase letters and digits only.",
    );
  if (!model) fail("Model ID RunPod wajib diisi.", "RunPod model ID is required.");
  const profile = {
    capabilities: ["text"],
    ...existing,
    id: "runpod",
    label: "RunPod",
    provider: "runpod",
    credentialId: "runpod",
    model,
    endpointId,
  };
  delete profile.timeoutSeconds;
  if (timeout) {
    const seconds = Number(timeout);
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 1800)
      fail(
        "Batas waktu RunPod: bilangan bulat 30–1800 detik.",
        "RunPod timeout: a whole number of 30–1800 seconds.",
      );
    profile.timeoutSeconds = seconds;
  }
  return profile;
}
function registryWithRunpod(registry) {
  const old = registry.find((p) => p.provider === "runpod");
  const profile = buildRunpodProfile(old);
  const rest = registry.filter((p) => p.provider !== "runpod");
  return profile ? [...rest, profile] : rest;
}
function collectSettings() {
  return {
    modelRegistry: registryWithRunpod(
      window.miganGeminiRegistry.withSelected(
        JSON.parse($("modelRegistry").value || "[]"),
        $("geminiModels").selectedOptions[0],
      ),
    ),
    routeMap: JSON.parse($("routeMap").value || "{}"),
    internalMemory: settings.internalMemory !== false,
    autoRouting: settings.autoRouting === true,
    credentials: $("credentialId").value.trim()
      ? [
          {
            id: $("credentialId").value.trim(),
            provider: $("credentialProvider").value,
            key: $("credentialKey").value,
          },
        ]
      : [],
    active: $("activeProvider").value,
    profiles: Object.fromEntries(
      ["openai", "anthropic", "kimi", "ollama"].map((p) => [
        p,
        {
          model: $(p + "Model").value,
          ...(p === "ollama"
            ? {
                baseURL: $("ollamaURL").value,
                alamatCadangan: $("ollamaCadangan").value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean),
              }
            : {}),
          ...(p === "anthropic" ? { workspaceId: $("anthropicWorkspace").value.trim() } : {}),
        },
      ]),
    ),
    keys: {
      openai: $("openaiKey").value,
      anthropic: $("anthropicKey").value,
      kimi: $("kimiKey").value,
      gemini: $("geminiKey").value,
      runpod: $("runpodKey").value,
    },
    routes: { light: $("lightRoute").value, coding: $("codingRoute").value },
    maxTurns: Number($("maxTurns").value),
    devRoots: devRootsFromForm(),
    memoryEnabled: $("memoryEnabled").checked,
    brainKonteks: {
      aktif: $("brainAktif").checked,
      penyedia: { anthropic: $("brainAnthropic").checked, openai: $("brainOpenai").checked },
    },
    modelPrices: collectPrices(),
    mcp: JSON.parse($("mcpConfig").value || "[]"),
  };
}
$("settingsForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const input = collectSettings();
    settings = await api.saveSettings(input);
    showSettingsData();
    $("settingsDialog").close();
    await browserLayout();
    toast(
      language === "id"
        ? "Koneksi tersimpan. Mulai tugas untuk memanggil model."
        : "Connections saved. Start a task to call the model.",
    );
  } catch (error) {
    $("settingsError").textContent = error.message;
  }
};
document.querySelectorAll("[data-mode]").forEach(
  (b) =>
    (b.onclick = () => {
      if (busy) return;
      mode = b.dataset.mode;
      document
        .querySelectorAll("[data-mode]")
        .forEach((x) => x.classList.toggle("active", x === b));
      updateBadge();
    }),
);
document.querySelectorAll("[data-prompt]").forEach(
  (b) =>
    (b.onclick = () => {
      $("prompt").value = b.dataset.prompt;
      if (b.dataset.prompt.startsWith("Buat landing"))
        document.querySelector('[data-mode="build"]').click();
      $("prompt").focus();
    }),
);
document.querySelectorAll(".galaxy-nav [data-nav]").forEach((button) => {
  const pane = $(button.dataset.nav + "Pane");
  if (!pane) return;
  button.id = "nav-" + button.dataset.nav;
  button.setAttribute("aria-controls", pane.id);
  pane.setAttribute("role", "region");
  pane.setAttribute("aria-labelledby", button.id);
});
$("send").onclick = safe(async () => {
  const prompt = $("prompt").value.trim();
  if (prompt.length < 2) return;
  if (busy) return;
  await workspaceTabs.select("chat");
  const delegation = selectedDelegation();
  runHadTeam = !!delegation;
  const learnTeam =
    delegation && $("teamLearn").checked
      ? { workspace: settings.workspace, enabled: true }
      : undefined;
  let target;
  if (mode === "build") {
    target = buildTarget();
    if (!target) {
      if (!(await askProject())) return;
      target = buildTarget();
    }
  }
  $("welcome").hidden = true;
  addMessage("user", prompt);
  $("prompt").value = "";
  $("teamLearn").checked = false;
  $("teamTemporary").checked = false;
  setBusy(true);
  $("runStatus").textContent = "Menghubungkan model… / Connecting model…";
  const owner = previousId;
  try {
    const kirim = tugasUi.catat({
      prompt,
      mode,
      skill: $("skill").value || undefined,
      previousId,
      modelId: !["", "auto"].includes($("taskModel").value)
        ? $("taskModel").value
        : undefined,
      routingMode: $("taskModel").value === "auto" ? "auto" : "manual",
      target,
      delegation,
      learnTeam,
    });
    await api.run(kirim);
    if (target?.kind === "new" && buildProject) buildProject.fresh = false;
  } catch (e) {
    if (previousId !== owner) return toast(e.message);
    setBusy(false);
    addMessage("error", e.message);
  }
});
$("stop").onclick = safe(async () => {
  await api.stop();
  $("runStatus").textContent = "Menghentikan… / Stopping…";
});
$("taskModel").onchange = updateBadge;
async function ownerTool(name, args) {
  if (busy) throw Error("Hentikan pekerjaan aktif dahulu");
  setBusy(true);
  galaxy?.event({ type: "manual-start" });
  try {
    const result = await api.ownerTool(name, args);
    galaxy?.event({ type: "manual-finish" });
    return result;
  } catch (error) {
    galaxy?.event({ type: "manual-finish", error: true });
    throw error;
  } finally {
    setBusy(false);
  }
}
$("refreshWindows").onclick = safe(async () => {
  const r = await ownerTool("desktop_windows", {});
  $("windowList").replaceChildren();
  for (const w of r.windows) {
    const button = document.createElement("button");
    button.className = "window-entry";
    button.textContent = w.title + " · PID " + w.pid;
    button.onclick = safe(async () => {
      const result = await ownerTool("desktop_focus", {
        handle: w.handle,
        pid: w.pid,
      });
      toast(
        result.focused
          ? "Jendela aktif: " + w.title
          : "Windows tidak mengizinkan perpindahan fokus.",
      );
    });
    $("windowList").append(button);
  }
});
$("terminalForm").onsubmit = safe(async (e) => {
  e.preventDefault();
  const command = $("terminalCommand").value.trim();
  if (!command) return;
  $("terminalOutput").textContent = "Menunggu persetujuan…";
  try {
    const r = await ownerTool("shell", { command });
    $("terminalOutput").textContent = "Exit " + r.code + "\n" + r.output;
  } catch (error) {
    $("terminalOutput").textContent = error.message;
    throw error;
  }
});
$("deny").onclick = safe(() => resolveApproval(false));
$("approvalStop").onclick = () => $("stop").click();
$("allow").onclick = safe(() => resolveApproval(true));
$("approvalDialog").addEventListener("cancel", (e) => {
  e.preventDefault();
  void resolveApproval(false);
});
async function resolveApproval(yes) {
  if (!approvalId) return;
  const id = approvalId;
  approvalId = null;
  await api.approve(id, yes);
  $("approvalDialog").close();
  await browserLayout();
}
// Banner HOLD Pemulihan di Beranda. Galat IPC = banner "tidak terbaca" dengan Muat ulang, tidak
// pernah disembunyikan diam-diam (banner ini satu-satunya jalan pemilik melepas HOLD).
function showHoldBanner(view) {
  $("holdBannerText").textContent = view.text;
  $("holdBannerAction").textContent = view.button;
  $("holdBannerAction").dataset.id = view.id;
  $("holdBannerAction").dataset.move = view.needsSwitch ? "1" : "";
  $("holdBannerAction").dataset.reload = view.reload ? "1" : "";
  $("holdBanner").hidden = false;
}
async function refreshHoldBanner() {
  const box = $("holdBanner");
  if (!box) return;
  let holds;
  try {
    holds = await api.recoveryHoldsAll();
  } catch {
    showHoldBanner(window.miganHoldBanner.describeError());
    return;
  }
  const view = window.miganHoldBanner.describe(holds, settings?.workspace);
  if (!view) {
    box.hidden = true;
    return;
  }
  showHoldBanner(view);
}
if ($("holdBannerAction"))
  $("holdBannerAction").onclick = safe(async () => {
    const button = $("holdBannerAction");
    if (button.dataset.reload) {
      await refreshHoldBanner();
      return;
    }
    if (button.dataset.move) {
      const previousWorkspace = settings.workspace;
      await api.recoveryHoldSwitch(button.dataset.id);
      settings = await api.settings();
      await workspaceChanged(previousWorkspace);
    }
    await switchTab("recovery");
    // With Pemulihan already open switchTab changes nothing; open and show the named card.
    await refreshRecovery(button.dataset.id);
    const card =
      $("recoveryList").querySelector(`details[data-id="${CSS.escape(button.dataset.id || "")}"]`) ||
      $("recoveryList").querySelector("details[open]");
    if (card) {
      card.open = true;
      card.scrollIntoView({ block: "start", behavior: "smooth" });
      card.querySelector("textarea")?.focus();
    }
    await refreshHoldBanner();
  });
$("refreshFiles").onclick = safe(refreshFiles);
$("closePreview").onclick = safe(async () => {
  await hideLivePreview();
  $("filePreview").hidden = true;
});
$("taskTeamSettings").addEventListener("toggle", () => {
  void browserLayout();
  void livePreviewLayout();
});
$("openArtifactsFolder").onclick = safe(() => api.openArtifacts());
$("addressForm").onsubmit = safe(async (e) => {
  e.preventDefault();
  const result = await api.browserNavigate($("address").value);
  $("address").value = result.url;
});
$("langBtn").onclick = () => {
  language = language === "id" ? "en" : "id";
  document.documentElement.lang = language;
  for (const [element, text] of idText) {
    if (language === "en")
      element.textContent = en[element.dataset.i18n] || element.textContent;
    else element.innerHTML = text;
  }
  $("prompt").placeholder =
    language === "en"
      ? "For example: build a simple inventory app for my shop…"
      : "Misalnya: buat aplikasi pencatatan sederhana untuk toko saya…";
  updateBadge();
  renderModeHint();
  if (lastUsage) renderUsage(lastUsage);
  void refreshSkills();
  void refreshHistory();
  refreshTeamChoices();
  galaxy?.language(language);
  memorySources.render();
  if (workspaceTabs?.current() === "team") void safe(openAgents)();
  if (workspaceTabs?.current() === "results") void safe(renderResults)();
};
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "Enter") {
    e.preventDefault();
    if (!$("settingsDialog").open && !$("approvalDialog").open)
      $("send").click();
  }
  if (e.ctrlKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    void safe(newTask)();
  }
});
let resultsRevision = 0;
async function renderResults() {
  const ticket = ++resultsRevision;
  const list = $("resultsList"),
    owner = previousId,
    workspace = settings.workspace;
  list.replaceChildren();
  const make = (tag, text) => {
    const e = document.createElement(tag);
    e.textContent = text;
    return e;
  };
  const empty = () => {
    const p = make(
      "p",
      language === "en"
        ? "No files have been recorded for this task yet. Continue the conversation or inspect your project files."
        : "Belum ada berkas hasil yang dicatat untuk pekerjaan ini. Lanjutkan percakapan atau periksa berkas proyekmu.",
    );
    p.className = "result-empty";
    list.append(p);
  };
  if (!owner) {
    empty();
    return;
  }
  const run = await api.loadRun(owner);
  if (
    ticket !== resultsRevision ||
    previousId !== owner ||
    settings.workspace !== workspace
  )
    return;
  if (
    String(run.workspace).replaceAll("\\", "/").toLowerCase() !==
    String(workspace).replaceAll("\\", "/").toLowerCase()
  ) {
    list.append(
      make(
        "p",
        "Hasil ini berasal dari proyek lain. Pilih kembali proyek sumber untuk memeriksanya.",
      ),
    );
    return;
  }
  const receipts = new Map(
    (run.artifactReceipts || []).map((r) => [r.path, r]),
  );
  for (const p of run.artifacts || [])
    if (!receipts.has(p)) receipts.set(p, { path: p });
  if (!receipts.size) {
    empty();
    return;
  }
  for (const r of receipts.values()) {
    if (typeof r.path !== "string") continue;
    const card = make("article", "");
    card.className = "result-card";
    card.append(
      make("strong", r.path),
      make(
        "p",
        language === "en"
          ? "Recorded output · still needs review"
          : "Hasil tercatat · masih perlu diperiksa",
      ),
    );
    const proof = make("details", "");
    proof.append(
      make("summary", language === "en" ? "Evidence details" : "Rincian bukti"),
      make("p", r.sha256 ? "SHA256: " + r.sha256 : "Hash belum dicatat"),
    );
    card.append(proof);
    const open = make(
      "button",
      language === "en" ? "Inspect file" : "Periksa berkas",
    );
    open.onclick = safe(async () => {
      if (settings.workspace !== workspace)
        throw Error("Proyek sudah berubah; buka kembali hasilnya.");
      await workspaceTabs.select("chat");
      await switchTab("files");
      $("fileName").textContent = r.path;
      $("filePreview").hidden = false;
      if (/\.(html?|svg|md)$/i.test(r.path)) await showLivePreview(r.path);
      else {
        await hideLivePreview();
        const data = await api.readFile(r.path);
        $("fileText").textContent =
          data.text + (data.truncated ? "\n[TRUNCATED]" : "");
      }
    });
    card.append(open);
    list.append(card);
  }
}
workspaceTabs = window.createWorkspaceTabs({
  loadTeam: openAgents,
  loadResults: renderResults,
  layout: async () => {
    await browserLayout();
    await livePreviewLayout();
  },
  reportError: toast,
});
galaxy = window.createGalaxyShell({
  navigate: switchTab,
  openSettings: safe(openSettings),
  example: () => $("exampleFirst").click(),
  layout: browserLayout,
});
api.onEvent((event) => {
  // A late event must never leak into the thread selected by a newer run.
  if (event.type !== "start" && event.runId && event.runId !== previousId)
    return;
  galaxy.event(event);
  if (event.type === "start") {
    previousId = event.id;
    runProvider = event.profile?.provider || "";
    lastUsage = lastFinishUsage = null;
    usageRunning = true;
    memorySources.reset();
    if (workspaceTabs.current() === "results") void safe(renderResults)();
    $("welcome").hidden = true;
    $("messages").replaceChildren();
    $("activity").replaceChildren();
    setBusy(true);
    // Bridge starts bypass the composer handler. Load their persisted prompt
    // into this fixed node without clearing replies that arrive while it loads.
    const promptNode = addMessage(
      "user",
      language === "en" ? "Loading instructions…" : "Memuat instruksi…",
    );
    void api
      .loadRun(event.id)
      .then((run) => {
        if (previousId === event.id && promptNode.isConnected)
          promptNode.textContent = run.prompt;
      })
      .catch(() => {
        if (previousId === event.id && promptNode.isConnected)
          promptNode.textContent =
            language === "en"
              ? "Instructions unavailable."
              : "Instruksi belum dapat dimuat.";
      });
    $("runStatus").textContent =
      event.profile.provider +
      " / " +
      event.profile.model +
      (event.routingPlan
        ? " · " + event.agent.nama + " · " + event.routingPlan.level
        : "");
    void refreshHistory();
  } else if (event.type === "thinking")
    $("runStatus").textContent =
      `Giliran / Turn ${event.turn}/${event.limit}`;
  // K01: Migan's human status (incl. "terpotong, melanjutkan 1/3") and visible per-run usage.
  else if (event.type === "agen.status" && event.agentId === "migan") {
    if (busy && event.runId) $("runStatus").textContent = event.label;
  } else if (event.type === "agen.pemakaian") renderUsage(event);
  else if (event.type === "model.dipilih") showModelChoice(event);
  else if (event.type === "model.cadangan") showModelFallback(event);
  else if (event.type === "model.saldo") showModelNote(window.miganModelChoice.saldoText(event));
  else if (event.type === "model.alamat") showModelNote(window.miganModelChoice.alamatText(event));
  else if (event.type === "assistant") addMessage("assistant", event.text);
  else if (event.type === "memory" || event.type === "memory-unavailable")
    memorySources.event(event);
  else if (
    event.type.startsWith("tool-") ||
    [
      "team-decision",
      "team-merge",
      "delegation-result",
      "team-learning",
      "team-learning-unavailable",
    ].includes(event.type)
  )
    addActivity(event);
  else if (event.type === "approval") {
    approvalId = event.id;
    $("approvalTool").textContent =
      event.tool + (event.actor ? " · " + event.actor.agentId : "");
    $("approvalTool").title = event.actor ? JSON.stringify(event.actor) : "";
    $("approvalArgs").textContent = JSON.stringify(event.args, null, 2);
    $("approvalWarning").textContent = [
      "shell",
      "ssh",
      "mcp_call",
      "mcp_list",
    ].includes(event.tool)
      ? "Akses tepercaya tanpa sandbox OS. Dapat memengaruhi komputer atau layanan eksternal. / Trusted, unsandboxed access; may affect the computer or external services."
      : "";
    $("approvalDialog").showModal();
    void browserLayout();
  } else if (event.type === "approval-closed") {
    if (event.id === approvalId) {
      approvalId = null;
      $("approvalDialog").close();
      void browserLayout();
    }
  } else if (event.type === "finish") {
    setBusy(false);
    $("runStatus").textContent = event.status;
    finishUsage(event.usage);
    if (event.validation)
      $("runStatus").textContent += " · acceptance: " + event.validation.status;
    if (event.error) addErrorMessage(event.error, event.errorCode);
    void refreshFiles();
    void refreshHistory();
    if (workspaceTabs.current() === "results") void safe(renderResults)();
  } else if (event.type === "error") {
    setBusy(false);
    // GATE D3 C1: a stop before any run (D3) carries its code and the task box's taskId.
    addErrorMessage(event.text, event.code, event.taskId);
    $("runStatus").textContent = "Perlu diperiksa / Needs review";
  } else if (event.type === "browser-url") $("address").value = event.url;
});
new ResizeObserver(() => void browserLayout().catch(() => {})).observe(
  $("browserSurface"),
);
window.addEventListener("resize", () => void browserLayout().catch(() => {}));
// The owner may come back after a HOLD changed elsewhere (another session, a released HOLD).
window.addEventListener("focus", () => void refreshHoldBanner());
safe(async () => {
  settings = await api.settings();
  showSettingsData();
  if (!settings.configured[settings.active]) await openSettings();
  await Promise.all([refreshFiles(), refreshSkills(), refreshHistory()]);
  void refreshHoldBanner();
  // A second look once startup has settled: one early read must not decide the banner for the session.
  setTimeout(() => void refreshHoldBanner(), 4000);
  refreshTeamChoices((await api.agentCatalog()).cards);
  if (settings.openLastRun) {
    const recent = (await api.history()).filter((r) => !r.parentRunId);
    if (recent[0]) await showRun(recent[0].id);
  }
})();
