import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { validateRegistry, ROUTES } from "./model-registry.mjs";
import { validatePolicy } from "./adaptive-routing.mjs";
import { validateWorkspaceId } from "./anthropic-workspace.mjs";
import { modelChoices } from "./task-model.mjs";
import { DEFAULT_CAPS, DEFAULT_LOCAL_RUN_MINUTES, builtinPriceInfo, mergeCaps, validatePrices } from "./cost-meter.mjs";
import { validateDevRoots } from "./folder-kerja.mjs";
import { redaksiPola } from "./redaksi.mjs";
import { validateBrainKonteks } from "../memory/brain-konteks.mjs";
// Owner ceilings for long runs (27 Oct 2026); defaults stay small and dollars stay capped by the meter.
export const INPUT_BUDGET_MAX = 8_000_000;
export const TEAM_INPUT_BUDGET_MAX = 2_000_000;
export const MAX_TURNS_LIMIT = 60;

/** Ollama fallback origins: at most 3 http(s) URLs, trimmed, deduplicated, the main one excluded. */
export function validateAlamatCadangan(list, utama = "") {
  if (!Array.isArray(list)) throw new Error("Alamat cadangan Ollama harus berupa daftar");
  const out = [];
  for (const raw of list) {
    const u = String(raw ?? "").trim();
    if (!u) continue;
    let url;
    try {
      url = new URL(u);
    } catch {
      throw new Error("Alamat cadangan Ollama bukan URL: " + u.slice(0, 80));
    }
    if (!["http:", "https:"].includes(url.protocol) || u.length > 300)
      throw new Error("Alamat cadangan Ollama harus http(s): " + u.slice(0, 80));
    if (u !== utama && !out.includes(u)) out.push(u);
  }
  if (out.length > 3) throw new Error("Alamat cadangan Ollama paling banyak 3");
  return out;
}
// Providers whose API key lives in the OS vault under the provider's own ID. RunPod is not a legacy
// active provider: it is reached only through a modelRegistry profile.
const KEY_PROVIDERS = ["openai", "anthropic", "kimi", "gemini", "runpod"];
// Owner-set cumulative input budgets per mode; same range the runtime enforces (10 KB - max).
function validateInputBudgets(value, key = "inputBudgets", max = INPUT_BUDGET_MAX) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${key}`);
  const out = {};
  for (const [mode, bytes] of Object.entries(value)) {
    if (
      !["ask", "work", "build"].includes(mode) ||
      !Number.isSafeInteger(bytes) ||
      bytes < 10000 ||
      bytes > max
    )
      throw new Error(`Invalid ${key}.${String(mode).slice(0, 20)}: 10000-${max} byte`);
    out[mode] = bytes;
  }
  return out;
}
// Owner skill folders for the skill router (PRD-017): absolute paths only, none by default.
function validateSkillDirs(value) {
  if (
    !Array.isArray(value) ||
    value.length > 10 ||
    value.some(
      (p) => typeof p !== "string" || !p || p.length > 400 || /[\u0000-\u001f]/.test(p) || !path.isAbsolute(p),
    )
  )
    throw new Error("Invalid skillDirs: at most 10 absolute folder paths");
  return [...new Set(value)];
}
function validateLocalRunMinutes(value) {
  if (value === undefined) return DEFAULT_LOCAL_RUN_MINUTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > 480)
    throw new Error("Invalid localRunMinutes: 1-480 minutes");
  return value;
}
function validateSkillRouter(value, saved) {
  if (value === undefined) return saved !== false;
  if (typeof value !== "boolean") throw new Error("Invalid skillRouter: true or false");
  return value;
}
export class Store {
  constructor(root, safeStorage) {
    this.root = root;
    this.crypto = safeStorage;
    this.keys = {};
    this.queue = Promise.resolve();
    this.persistenceWarning = null;
    this.settings = {
      active: "anthropic",
      profiles: {
        openai: { model: "" },
        anthropic: { model: "claude-sonnet-5-5" },
        kimi: { model: "kimi-k2.6" },
        ollama: { model: "", baseURL: "http://127.0.0.1:11434" },
      },
      routes: {},
      mcp: [],
      maxTurns: 12,
      internalMemory: true,
      skillRouter: true,
      skillDirs: [],
      // 000b2: dev roots for the bridge workspace switch; empty = switching is off.
      devRoots: [],
      // PRD-019: owner price table (empty), daily caps, local run duration.
      modelPrices: {},
      dailyCaps: structuredClone(DEFAULT_CAPS),
      localRunMinutes: DEFAULT_LOCAL_RUN_MINUTES,
      modelRegistry: [],
      routeMap: {},
      autoRouting: false,
      credentialInfo: [],
    };
  }
  async init() {
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.join(this.root, "runs"), { recursive: true });
    await fs.mkdir(path.join(this.root, "workspace"), { recursive: true });
    const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
    let stateRaw = null;
    try {
      stateRaw = await fs.readFile(path.join(this.root, "state.json"), "utf8");
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error("State file is unreadable; preserve it for recovery");
    }
    let saved = {};
    let sealed = {};
    if (stateRaw !== null) {
      let state = null;
      try {
        state = JSON.parse(stateRaw);
      } catch {}
      if (
        !isObj(state) ||
        state.version !== 1 ||
        !isObj(state.settings) ||
        !isObj(state.vault) ||
        Object.values(state.vault).some((v) => typeof v !== "string")
      )
        throw new Error(
          "State file is unreadable or invalid; preserve it for recovery",
        );
      saved = state.settings;
      sealed = state.vault;
    } else {
      try {
        saved = JSON.parse(
          await fs.readFile(path.join(this.root, "settings.json"), "utf8"),
        );
        if (!isObj(saved)) throw Error();
      } catch (e) {
        if (e.code !== "ENOENT")
          throw new Error(
            "Settings file is unreadable; preserve it for recovery",
          );
        saved = {};
      }
      try {
        sealed = JSON.parse(
          await fs.readFile(path.join(this.root, "vault.json"), "utf8"),
        );
        if (!isObj(sealed)) throw Error();
      } catch (e) {
        if (e.code !== "ENOENT")
          throw new Error(
            "OS key vault cannot be decrypted for this Windows account",
          );
        sealed = {};
      }
    }
    this.settings = {
      ...this.settings,
      ...saved,
      profiles: { ...this.settings.profiles, ...saved.profiles },
    };
    try {
      if (Object.keys(sealed).length && !this.crypto.isEncryptionAvailable())
        throw Error();
      for (const [provider, cipher] of Object.entries(sealed))
        this.keys[provider] = this.crypto.decryptString(
          Buffer.from(cipher, "base64"),
        );
    } catch (e) {
      if (e.code !== "ENOENT")
        throw new Error(
          "OS key vault cannot be decrypted for this Windows account",
        );
    }
    this.settings.workspace =
      this.settings.workspace || path.join(this.root, "workspace");
    for (const run of await this.history(Infinity)) {
      if (["running", "waiting"].includes(run.status)) {
        const r = await this.loadRun(run.id);
        r.status = "interrupted";
        r.error = "App closed during a task. Actions were not replayed.";
        await this.saveRun(r);
      }
    }
  }
  publicSettings() {
    return {
      ...this.settings,
      configured: Object.fromEntries(
        ["openai", "anthropic", "kimi", "gemini", "ollama", "runpod"].map((k) => [
          k,
          k === "ollama" || !!this.keys[k],
        ]),
      ),
      encrypted: this.crypto.isEncryptionAvailable(),
      // Shown in Settings › Harga model; never saved back as owner prices.
      builtinPrices: builtinPriceInfo(this.settings.modelPrices),
      // Task box picker: registered profiles with whether they can be chosen and why not.
      taskModels: modelChoices(this.settings),
      ...(this.persistenceWarning
        ? { persistenceWarning: this.persistenceWarning }
        : {}),
      credentialInfo: [
        ...new Set([
          ...Object.keys(this.keys),
          ...(this.settings.credentialInfo || []).map((c) => c.id),
        ]),
      ].map((id) => ({
        id,
        provider:
          (this.settings.credentialInfo || []).find((c) => c.id === id)
            ?.provider || id,
        label:
          (this.settings.credentialInfo || []).find((c) => c.id === id)
            ?.label || id,
        configured: !!this.keys[id],
      })),
    };
  }
  async atomic(name, data) {
    const p = path.join(this.root, name);
    const temp = p + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      for (let attempt = 0; ; attempt++) {
        try {
          await fs.rename(temp, p);
          break;
        } catch (e) {
          if (!["EPERM", "EBUSY"].includes(e.code) || attempt >= 4) throw e;
          await delay(20 * (attempt + 1));
        }
      }
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }
  saveSettings(input) {
    let cloned;
    try {
      cloned = structuredClone(input);
    } catch {
      return Promise.reject(new Error("Invalid settings"));
    }
    return this.enqueue(() => this.saveSettingsNow(cloned));
  }
  async saveSettingsNow(input) {
    if (!input || typeof input !== "object")
      throw new Error("Invalid settings");
    if (!["openai", "anthropic", "kimi", "ollama"].includes(input.active))
      throw new Error("Invalid provider");
    const profiles = {};
    for (const name of ["openai", "anthropic", "kimi", "ollama"]) {
      const p =
        input.profiles?.[name] ||
        (name === "kimi" ? this.settings.profiles.kimi : undefined);
      if (typeof p?.model !== "string" || p.model.length > 160)
        throw new Error("Invalid model");
      profiles[name] = { model: p.model.trim() };
      if (name === "anthropic") {
        const workspaceId = validateWorkspaceId(typeof p.workspaceId === "string" ? p.workspaceId.trim() : p.workspaceId);
        if (workspaceId) profiles[name].workspaceId = workspaceId;
      }
      if (name === "ollama") {
        profiles[name].baseURL = String(p.baseURL || "").slice(0, 300);
        // Ordered fallback origins (Home server over a VPN, 9 Nov 2026); a form without the field keeps them.
        profiles[name].alamatCadangan = validateAlamatCadangan(
          p.alamatCadangan ?? this.settings.profiles?.ollama?.alamatCadangan ?? [],
          profiles[name].baseURL,
        );
      }
    }
    const mcp = input.mcp || [];
    if (!Array.isArray(mcp) || mcp.length > 8)
      throw new Error("At most 8 MCP server registrations");
    for (const m of mcp) {
      if (
        !/^[a-zA-Z0-9_-]{1,50}$/.test(m.id) ||
        typeof m.command !== "string" ||
        m.command.length > 500 ||
        !Array.isArray(m.args) ||
        m.args.length > 40 ||
        m.args.some((a) => typeof a !== "string" || a.length > 1000) ||
        !Array.isArray(m.allowTools) ||
        m.allowTools.length > 60 ||
        m.allowTools.some((a) => !/^\w[\w.-]{0,100}$/.test(a))
      )
        throw new Error(
          "Invalid MCP entry: id, command, args[], allowTools[] required. No env/credentials in configuration.",
        );
    }
    if (new Set(mcp.map((m) => m.id)).size !== mcp.length)
      throw new Error("MCP server IDs must be unique");
    const routes = {};
    for (const k of ["light", "coding"])
      if (input.routes?.[k]) {
        if (!profiles[input.routes[k]]) throw new Error("Invalid model route");
        routes[k] = input.routes[k];
      }
    const nextKeys = { ...this.keys };
    const credentials = input.credentials || [];
    if (!Array.isArray(credentials) || credentials.length > 30)
      throw new Error("At most 30 vault credentials");
    const credentialInfo = [...(this.settings.credentialInfo || [])];
    for (const c of credentials) {
      if (
        !/^[a-zA-Z0-9_-]{1,60}$/.test(c.id) ||
        !KEY_PROVIDERS.includes(c.provider) ||
        typeof c.key !== "string" ||
        c.key.length > 1000
      )
        throw new Error("Invalid named credential");
      if (KEY_PROVIDERS.includes(c.id) && c.id !== c.provider)
        throw new Error("Reserved credential ID must match its provider");
      const namedKey = c.key.trim();
      if (namedKey) nextKeys[c.id] = namedKey;
      const index = credentialInfo.findIndex((x) => x.id === c.id);
      const meta = {
        id: c.id,
        provider: c.provider,
        label: String(c.label || c.id).slice(0, 100),
      };
      if (index < 0) credentialInfo.push(meta);
      else credentialInfo[index] = meta;
    }
    const modelRegistry = validateRegistry(
      input.modelRegistry ?? this.settings.modelRegistry ?? [],
      this.settings.modelRegistry || [],
    );
    const routeMap = input.routeMap ?? this.settings.routeMap ?? {};
    if (
      !routeMap ||
      Array.isArray(routeMap) ||
      typeof routeMap !== "object" ||
      Object.entries(routeMap).some(
        ([route, id]) =>
          !ROUTES[route] ||
          typeof id !== "string" ||
          !modelRegistry.some((p) => p.id === id),
      )
    )
      throw new Error("Route map contains an unknown route/model profile");
    for (const model of modelRegistry)
      if (model.provider !== "ollama") {
        const meta = credentialInfo.find((c) => c.id === model.credentialId);
        const boundProvider =
          meta?.provider ||
          (KEY_PROVIDERS.includes(model.credentialId)
            ? model.credentialId
            : undefined);
        if (boundProvider && boundProvider !== model.provider)
          throw new Error("Credential provider does not match model profile");
      }
    for (const p of KEY_PROVIDERS)
      if (input.keys?.[p]) {
        if (typeof input.keys[p] !== "string" || input.keys[p].length > 1000)
          throw new Error("Invalid API key");
        const legacyKey = input.keys[p].trim();
        if (legacyKey) nextKeys[p] = legacyKey;
      }
    if (Object.keys(nextKeys).length && !this.crypto.isEncryptionAvailable())
      throw new Error("OS encryption unavailable; key storage refused");
    const nextSettings = {
      ...this.settings,
      active: input.active,
      profiles,
      routes,
      mcp,
      memoryEnabled: input.memoryEnabled === true,
      internalMemory: input.internalMemory !== false,
      // GATE S2 P1: Brain is opt-in, per provider; the gerbang command never comes from the UI.
      brainKonteks: validateBrainKonteks(input.brainKonteks ?? this.settings.brainKonteks, this.settings.brainKonteks),
      // Omitted keeps the saved value, like inputBudgets.
      skillRouter: validateSkillRouter(input.skillRouter, this.settings.skillRouter),
      skillDirs: validateSkillDirs(input.skillDirs ?? this.settings.skillDirs ?? []),
      devRoots: validateDevRoots(input.devRoots ?? this.settings.devRoots),
      modelPrices: validatePrices(input.modelPrices ?? this.settings.modelPrices ?? {}),
      // Per provider and per field onto the saved caps; Kimi and Anthropic always keep a dollar cap.
      dailyCaps: mergeCaps(this.settings.dailyCaps, input.dailyCaps),
      localRunMinutes: validateLocalRunMinutes(input.localRunMinutes ?? this.settings.localRunMinutes),
      modelRegistry,
      routeMap,
      autoRouting: input.autoRouting === true,
      adaptiveRouting: validatePolicy(
        input.adaptiveRouting ?? this.settings.adaptiveRouting,
        modelRegistry,
      ),
      credentialInfo,
      maxTurns: Math.max(1, Math.min(MAX_TURNS_LIMIT, Number(input.maxTurns) || 12)),
      inputBudgets: validateInputBudgets(
        input.inputBudgets ?? this.settings.inputBudgets,
      ),
      // Team fan-out cap is separate so raising the parent budget never raises it implicitly.
      teamInputBudgets: validateInputBudgets(
        input.teamInputBudgets ?? this.settings.teamInputBudgets,
        "teamInputBudgets",
        TEAM_INPUT_BUDGET_MAX,
      ),
    };
    await this.commit(nextSettings, nextKeys);
    return this.publicSettings();
  }
  async commit(settings, keys) {
    if (Object.keys(keys).length && !this.crypto.isEncryptionAvailable())
      throw new Error("OS encryption unavailable; key storage refused");
    const sealed = Object.fromEntries(
      Object.entries(keys).map(([p, k]) => [
        p,
        this.crypto.encryptString(k).toString("base64"),
      ]),
    );
    await this.atomic("state.json", { version: 1, settings, vault: sealed });
    this.settings = settings;
    this.keys = keys;
    try {
      await this.atomic("settings.json", settings);
      await this.atomic("vault.json", sealed);
      this.persistenceWarning = null;
    } catch {
      this.persistenceWarning =
        "Settings were saved, but legacy mirror backup files could not be updated.";
    }
  }
  setWorkspace(root) {
    return this.enqueue(() =>
      this.commit({ ...this.settings, workspace: root }, this.keys),
    );
  }
  redact(text) {
    let value = String(text);
    for (const key of Object.values(this.keys))
      if (key) value = value.split(key).join("[REDACTED]");
    // Stored keys first (exact), then secret shapes (GATE S2 P2, redaksi.mjs).
    return redaksiPola(value);
  }
  async saveRun(run) {
    await this.atomic(
      "runs/" + run.id + ".json",
      JSON.parse(this.redact(JSON.stringify(run))),
    );
  }
  async loadRun(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid task ID");
    return JSON.parse(
      await fs.readFile(path.join(this.root, "runs", id + ".json"), "utf8"),
    );
  }
  async history(limit = 100) {
    const files = await fs.readdir(path.join(this.root, "runs"));
    const out = [];
    for (const name of files.filter((f) => /^[a-f0-9-]{36}\.json$/.test(f))) {
      try {
        const r = await this.loadRun(name.slice(0, -5));
        out.push({
          id: r.id,
          title: r.title,
          status: r.status,
          created: r.created,
          // Runs started by the bridge carry origin "bridge". Queue runs from before that field existed
          // (27 Oct 2026) are recognised by the queue runner's fixed opening line.
          ...(r.origin === "bridge" || String(r.prompt || "").startsWith("ATURAN TETAP (berlaku untuk tugas ini)")
            ? { origin: "bridge" }
            : {}),
          ...(r.parentRunId
            ? { parentRunId: r.parentRunId, agentId: r.agentId }
            : {}),
        });
      } catch {}
    }
    return out
      .sort((a, b) => b.created.localeCompare(a.created))
      .slice(0, limit === Infinity ? out.length : limit);
  }
}
