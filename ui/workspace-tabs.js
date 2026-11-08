/* Presentation only. The persistent composer and host retain authority, run state and cancellation. */
window.createWorkspaceTabs = ({
  loadTeam,
  loadResults,
  layout,
  reportError,
}) => {
  const buttons = [...document.querySelectorAll("[data-workspace-tab]")];
  const panels = {
    chat: document.getElementById("chatWorkspace"),
    team: document.getElementById("teamWorkspace"),
    results: document.getElementById("resultsWorkspace"),
  };
  let current = "chat",
    revision = 0;
  async function select(view, { focus = false } = {}) {
    if (!Object.hasOwn(panels, view)) return;
    const ticket = ++revision;
    current = view;
    document.body.dataset.workspaceView = view;
    for (const [name, panel] of Object.entries(panels))
      panel.hidden = name !== view;
    for (const button of buttons) {
      const active = button.dataset.workspaceTab === view;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
    }
    const dialog = document.getElementById("agentsDialog");
    if (view !== "team" && dialog.open) dialog.close();
    try {
      if (view === "team") {
        if (!dialog.open) dialog.show();
        await loadTeam();
      }
      if (view === "results") await loadResults();
      if (ticket !== revision) return;
      await layout();
      if (focus) buttons.find((b) => b.dataset.workspaceTab === view)?.focus();
    } catch (error) {
      if (ticket === revision) reportError(error.message);
    }
  }
  for (const b of buttons)
    b.addEventListener("click", () => void select(b.dataset.workspaceTab));
  document
    .getElementById("workspaceTabs")
    .addEventListener("keydown", (event) => {
      const index = buttons.indexOf(document.activeElement);
      if (
        index < 0 ||
        !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
      )
        return;
      event.preventDefault();
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? buttons.length - 1
            : (index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
              buttons.length;
      void select(buttons[next].dataset.workspaceTab, { focus: true });
    });
  document.body.dataset.workspaceView = "chat";
  return { select, current: () => current };
};
