// Settings › Harga model (PRD-019, markas 26 Oct 2026): built-in rows with their source, the
// owner's own prices, and validation before saving. Pure logic; app.js draws the table.
window.miganPriceTable = (() => {
  const FIELDS = [
    ["input", "input", true],
    ["output", "output", true],
    ["cached", "baca cache", false],
    ["cacheCreated", "tulis cache", false],
  ];
  const MODEL = /^(openai|anthropic|kimi)\/\S{1,160}$/;

  /** Rows for display: built-in models (owner value when overridden) plus the owner's other models. */
  function rowsFor(builtin, owner) {
    const own = owner || {};
    const rows = (builtin || []).map((b) => {
      const mine = own[b.model];
      const values = mine || b;
      const note =
        (mine ? "Harga Anda (menimpa bawaan). " : "Bawaan. ") +
        `Sumber: ${b.sumber} (${b.tanggal}).` +
        (b.kedaluwarsa ? " Harga bawaan lebih dari 90 hari; periksa sumbernya." : "");
      return {
        model: b.model,
        input: values.input,
        output: values.output,
        cached: values.cached,
        cacheCreated: values.cacheCreated,
        asal: mine ? "milik" : "bawaan",
        catatan: note,
        bawaan: b,
      };
    });
    for (const [model, p] of Object.entries(own))
      if (!rows.some((r) => r.model === model))
        rows.push({ model, ...p, asal: "milik", catatan: "Harga Anda.", bawaan: null });
    return rows.sort((a, b) => a.model.localeCompare(b.model));
  }

  function number(model, label, text, required) {
    const raw = String(text ?? "").trim();
    if (!raw) {
      if (required) throw new Error(`Harga ${model}: ${label} wajib diisi (USD per 1 juta token).`);
      return undefined;
    }
    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 1000)
      throw new Error(`Harga ${model}: ${label} harus angka 0 sampai 1000 (USD per 1 juta token).`);
    return value;
  }

  /**
   * Owner prices to save from the edited rows (text fields). A built-in row left at its numbers is
   * not saved, so the built-in stays in force; a blank cache field means "use the input price".
   */
  function collect(rows, builtin) {
    const out = {};
    for (const row of rows) {
      const model = String(row.model || "").trim();
      const blank = !model && FIELDS.every(([k]) => !String(row[k] ?? "").trim());
      if (blank) continue;
      if (!MODEL.test(model))
        throw new Error(`Harga ${model || "(tanpa nama)"}: nama model harus berbentuk penyedia/model, dengan penyedia openai, anthropic, atau kimi.`);
      const entry = {};
      for (const [key, label, required] of FIELDS) {
        const v = number(model, label, row[key], required);
        // Paid models need input and output above 0, or the dollar cap would not apply (H11).
        if (required && v === 0) throw new Error(`Harga ${model}: ${label} harus lebih dari 0 agar pagu biaya tetap berlaku.`);
        if (v !== undefined) entry[key] = v;
      }
      const b = (builtin || []).find((x) => x.model === model);
      const same =
        b &&
        entry.input === b.input &&
        entry.output === b.output &&
        (entry.cached === undefined || entry.cached === b.cached) &&
        (entry.cacheCreated === undefined || entry.cacheCreated === b.cacheCreated);
      if (!same) out[model] = entry;
    }
    return out;
  }

  /** The step offered next to a refused run, or null when there is none. */
  function errorAction(code) {
    if (code === "ERR_COST_PRICE") return { label: "Buka Pengaturan › Harga model", target: "priceSettings" };
    if (code === "ERR_ANTHROPIC_WORKSPACE") return { label: "Buka Pengaturan › Anthropic", target: "anthropicWorkspace" };
    return null;
  }

  return { rowsFor, collect, errorAction };
})();
