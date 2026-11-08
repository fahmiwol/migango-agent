// Keep Gemini's Add button and Settings save on one pure registry update path.
window.miganGeminiRegistry = (() => {
  function withSelected(registry, selected) {
    if (!selected?.value) return registry;
    const model = selected.value;
    const id = ("gemini-" + model.replace(/^models\//, "").replace(/[^a-zA-Z0-9_-]/g, "-")).slice(0, 60);
    const profile = {
      id,
      label: String(selected.textContent || model).slice(0, 100),
      provider: "gemini",
      model,
      credentialId: "gemini",
      capabilities: ["text", "tools", "code"],
      enabled: true,
      priority: 50,
    };
    const input = Number(selected.dataset?.input);
    if (Number.isSafeInteger(input) && input > 0) profile.contextWindowTokens = input;
    return [...registry.filter((p) => p.id !== id), profile];
  }
  return { withSelected };
})();
