/* Presentation only: authority and model/tool execution remain in the host. */
window.createGalaxyShell = ({ navigate, openSettings, example, layout }) => {
  const el = (id) => document.getElementById(id);
  let language = "id",
    context,
    next = {},
    runModel = "",
    modelRunning = false,
    lastEvent,
    phase = "idle",
    toolView = "files",
    navigationTicket = 0;
  const text = (id, en) => (language === "id" ? id : en);
  const navLabels = {
    home: ["Beranda", "Home"],
    activity: ["Jejak kerja", "Activity"],
    files: ["Berkas", "Files"],
    browser: ["Browser", "Browser"],
    computer: ["Komputer & terminal", "Computer & terminal"],
    memory: ["Memori", "Memory"],
    skills: ["Skill & MCP", "Skills & MCP"],
    research: ["Riset", "Research"],
    recovery: ["Pemulihan", "Recovery"],
  };
  const panelHints = {
    files: ["Isi folder proyek yang sedang dipilih.", "Files in the selected project folder."],
    browser: ["Browser terpisah untuk pekerjaan ini.", "An isolated browser for this work."],
    activity: ["Langkah, panggilan alat, dan bukti tugas ini.", "Steps, tool calls, and evidence for this task."],
    computer: ["Perangkat dan terminal dengan tindakan berizin.", "Computer and terminal with approved actions."],
    memory: ["Sumber dan catatan untuk proyek ini.", "Sources and notes for this project."],
    skills: ["Kemampuan dan koneksi yang tersedia.", "Available capabilities and connections."],
    research: ["Sumber dan hasil riset yang bisa diperiksa.", "Research sources and results you can inspect."],
    recovery: ["Periksa pekerjaan terputus sebelum melanjutkan.", "Review interrupted work before continuing."],
  };
  function panelHeading() {
    const index = language === "id" ? 0 : 1;
    const title = el("workspacePanelTitle"), hint = el("workspacePanelHint");
    if (title) title.textContent = navLabels[toolView][index];
    if (hint) hint.textContent = panelHints[toolView][index];
  }
  function selectView(view) {
    if (!Object.hasOwn(navLabels, view)) return;
    if (view !== "home") toolView = view;
    document.querySelectorAll("[data-nav]").forEach((button) => {
      if (button.dataset.nav === view)
        button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    panelHeading();
  }
  async function inspector(visible) {
    el("inspector").hidden = !visible;
    document.body.classList.toggle("inspector-closed", !visible);
    el("inspectorToggle").setAttribute("aria-expanded", String(visible));
    await layout();
  }
  document.querySelectorAll("[data-nav]").forEach(
    (button) =>
      (button.onclick = async () => {
        try {
          const view = button.dataset.nav;
          if (!Object.hasOwn(navLabels, view)) return;
          const ticket = ++navigationTicket;
          if (view === "home") {
            await navigate("home");
            if (ticket !== navigationTicket) return;
            el("prompt").focus();
            selectView(view);
          }
          else {
            await inspector(true);
            if (ticket !== navigationTicket) return;
            await navigate(view);
          }
        } catch (error) {
          el("toast").textContent = error.message;
          el("toast").hidden = false;
        }
      }),
  );
  // Arrows move focus; Enter/Space activate the native button without async navigation races.
  document.querySelector(".galaxy-nav")?.addEventListener("keydown", (event) => {
    const buttons = [...document.querySelectorAll(".galaxy-nav [data-nav]")].filter(b => !b.disabled);
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  });
  document
    .querySelectorAll("[data-nav]")
    .forEach((button) => (button.title = button.getAttribute("aria-label")));
  el("inspectorToggle").onclick = () => void inspector(el("inspector").hidden);
  el("modelSettings").onclick = () => void openSettings();
  el("mcpSettings").onclick = () => void openSettings("advancedSettings");
  el("memoryConnection").onclick = () => void openSettings("memorySettings");
  el("guideExample").onclick = example;
  function stages(state) {
    for (const stage of document.querySelectorAll("[data-stage]")) {
      const name = stage.dataset.stage;
      stage.dataset.state = state[name] || "pending";
      if (stage.dataset.state === "active")
        stage.setAttribute("aria-current", "step");
      else stage.removeAttribute("aria-current");
    }
  }
  function render() {
    const labels = {
      idle: text("Siap", "Ready"),
      working: text("Berjalan", "Running"),
      approval: text("Menunggu izin", "Awaiting approval"),
      review: text("Perlu ditinjau", "Needs review"),
      responded: text("Jawaban siap", "Response ready"),
      error: text("Perlu diperiksa", "Needs attention"),
      stopped: text("Dihentikan", "Stopped"),
      tool: text("Alat selesai", "Tool finished"),
    };
    el("taskState").textContent = labels[phase];
    el("taskState").dataset.state = phase;
    const state =
      phase === "idle"
        ? { plan: "active" }
        : ["working", "approval"].includes(phase)
          ? {
              plan: "complete",
              work: phase === "approval" ? "waiting" : "active",
            }
          : ["review", "responded", "tool"].includes(phase)
            ? {
                plan: "complete",
                work: "complete",
                test: "pending",
                review: "waiting",
              }
            : { plan: "complete", work: "attention" };
    stages(state);
    el("testStageHint").textContent = window.miganTeksAwam.validationText(validationEvent, language);
    const usage = lastEvent?.usage;
    el("usageSummary").textContent =
      usage?.available === false
        ? text("Tidak tersedia", "Unavailable")
        : usage
          ? Number(usage.input || 0).toLocaleString() +
            " / " +
            Number(usage.output || 0).toLocaleString()
          : text("Belum ada", "No usage yet");
    if (!context) return;
    const workspace = context.workspace || "";
    el("workspaceSummary").textContent =
      workspace.split(/[/\\]/).filter(Boolean).pop() ||
      text("Belum dipilih", "Not selected");
    el("workspaceSummary").title = workspace;
    // U1: while a run is active the control names that run's model; afterwards the next model again.
    const modelText = window.miganTeksAwam.modelLabel(
      { slot: "control", ...next, active: runModel, running: modelRunning },
      language,
    );
    el("modelSummary").textContent = modelText;
    el("modelSummary").title = modelText;
    el("turnSummary").textContent = String(context.maxTurns);
    el("systemSummary").textContent = context.configured[context.active]
      ? text("Model diatur · data lokal", "Model configured · local data")
      : text("Sambungkan model untuk mulai", "Connect a model to begin");
  }
  let activeRunId = null,
    validationEvent = null;
  return {
    selectView,
    showInspector: () => inspector(true),
    setContext(settings, nextModel) {
      context = settings;
      next = nextModel || {};
      render();
    },
    setBusy(busy) {
      document.body.dataset.busy = String(busy);
      document
        .querySelectorAll(
          '[data-nav="memory"], #modelSettings, #mcpSettings, #skill, [data-mode]',
        )
        .forEach((button) => (button.disabled = busy));
      // Modes stay readable while locked and say why (owner screenshot, 27 Oct 2026).
      const reason = "Sedang menjalankan pekerjaan. Mode bisa diganti sesudah selesai atau dihentikan.";
      document.querySelectorAll("[data-mode]").forEach((button) => {
        if (busy) button.title = reason;
        else button.removeAttribute("title");
      });
      const note = document.getElementById("modeBusyNote");
      if (note) note.hidden = !busy;
    },
    reset() {
      phase = "idle";
      lastEvent = null;
      runModel = "";
      modelRunning = false;
      activeRunId = null;
      validationEvent = null;
      render();
    },
    language(next) {
      language = next;
      document.querySelectorAll("[data-nav]").forEach((button) => {
        const label = navLabels[button.dataset.nav][next === "id" ? 0 : 1];
        button.setAttribute("aria-label", label);
        button.title = label;
      });
      panelHeading();
      render();
    },
    event(event) {
      const runId = typeof event.runId === "string" && event.runId ? event.runId : "";
      if (["start", "manual-start"].includes(event.type)) {
        activeRunId = runId || null;
        validationEvent = null;
      } else if (["verify-start", "verify-result"].includes(event.type)) {
        // Ignore missing, unrelated and late run IDs; never borrow another run's validation.
        if (runId && runId === activeRunId) validationEvent = event;
      } else if (
        event.type === "finish" &&
        event.status === "interrupted" &&
        runId &&
        runId === activeRunId &&
        validationEvent?.type === "verify-start"
      ) {
        validationEvent = event;
      }
      // Only a model run names its model; manual-start (a tool without a model) leaves the label alone.
      if (
        event.type === "start" &&
        typeof event.profile?.provider === "string" &&
        typeof event.profile?.model === "string"
      ) {
        runModel = event.profile.provider + " / " + event.profile.model;
        modelRunning = true;
      } else if (["finish", "error"].includes(event.type)) modelRunning = false;
      if (["start", "manual-start"].includes(event.type)) {
        phase = "working";
        lastEvent = null;
      } else if (event.type === "manual-finish")
        phase = event.error ? "error" : "tool";
      else if (event.type === "approval") phase = "approval";
      else if (
        ["approval-closed", "tool-start", "thinking"].includes(event.type)
      )
        phase = "working";
      else if (event.type === "finish") {
        lastEvent = event;
        phase = ["cancelled", "interrupted"].includes(event.status)
          ? "stopped"
          : event.error || ["failed", "hold", "HOLD"].includes(event.status)
            ? "error"
            : event.status === "responded"
              ? "responded"
              : "review";
      } else if (event.type === "error") phase = "error";
      render();
    },
  };
};
