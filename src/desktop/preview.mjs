// Canvas-like artifact preview (ARS-004 §13, K05). Pure Node: main.mjs wires it to Electron. The guest is
// isolated (own partition, no preload, no node), reads the workspace read-only within the artifact's
// folder, and cannot reach the network, navigate away, open popups, ask for permissions or download.
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { allowedName } from "../tools/workspace.mjs";

export const PREVIEW_SCHEME = "mgpreview";
export const PREVIEW_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
const MAX_BYTES = 8 * 1024 * 1024;
const MIME = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
});
const ENTRY = new Set([".html", ".htm", ".svg", ".md", ".txt", ".json"]);
const reply = (status, body = "", mimeType = "text/plain; charset=utf-8") => ({
  status,
  mimeType,
  headers: { "Content-Security-Policy": PREVIEW_CSP, "X-Content-Type-Options": "nosniff" },
  data: Buffer.from(body),
});
const posix = (p) => p.replaceAll("\\", "/");

export class PreviewRegistry {
  constructor() {
    this.previews = new Map();
    this.pendingWrites = new Map();
  }
  async open({ workspace, path: file }) {
    if (typeof file !== "string" || !ENTRY.has(path.extname(file).toLowerCase()))
      throw new Error("Only HTML, SVG, Markdown, text or JSON files can be previewed");
    const full = await workspace.resolve(file); // D-002 guard: traversal, absolute, hidden, 8.3
    if (!(await fs.stat(full)).isFile()) throw new Error("Preview target is not a file");
    const rel = posix(file);
    const scope = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    const token = randomBytes(16).toString("hex");
    this.previews.set(token, { workspace, scope, entry: path.posix.basename(rel) });
    return { token, url: `${PREVIEW_SCHEME}://${token}/${path.posix.basename(rel)}`, path: rel };
  }
  has(token) {
    return this.previews.has(token);
  }
  urlOf(token) {
    const p = this.previews.get(token);
    return p ? `${PREVIEW_SCHEME}://${token}/${p.entry}` : null;
  }
  close(token) {
    this.previews.delete(token);
  }
  closeAll() {
    this.previews.clear();
  }
  // Parses the raw URL itself: encoded traversal and backslashes are refused, not normalized away.
  async respond(url) {
    const match = /^mgpreview:\/\/([a-f0-9]{32})\/([^?#]*)/.exec(String(url));
    if (!match) return reply(403, "Forbidden");
    const preview = this.previews.get(match[1]);
    if (!preview) return reply(404, "Not found");
    let rest;
    try {
      rest = decodeURIComponent(match[2] || preview.entry);
    } catch {
      return reply(403, "Forbidden");
    }
    const parts = rest.split(/[\\/]/);
    if (parts.some((p) => !p || p === "." || p === ".." || !allowedName(p) || /[:\x00-\x1f]/.test(p)))
      return reply(403, "Forbidden");
    const rel = [preview.scope, ...parts].filter(Boolean).join("/");
    let full;
    try {
      full = await preview.workspace.resolve(rel);
    } catch (e) {
      return reply(e.code === "ENOENT" ? 404 : 403, e.code === "ENOENT" ? "Not found" : "Forbidden");
    }
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      return reply(404, "Not found");
    }
    if (!stat.isFile()) return reply(404, "Not found");
    if (stat.size > MAX_BYTES) return reply(413, "Too large");
    const mimeType = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    return { ...reply(200, "", mimeType), data: await fs.readFile(full) };
  }
  // A finished write_file/edit_file inside an open preview's scope invalidates that preview.
  observe(event) {
    if (event?.type === "tool-start" && ["write_file", "edit_file"].includes(event.name) && typeof event.args?.path === "string") {
      this.pendingWrites.set(event.id, posix(event.args.path));
      return [];
    }
    if (event?.type !== "tool-result" || !this.pendingWrites.has(event.id)) return [];
    const written = this.pendingWrites.get(event.id);
    this.pendingWrites.delete(event.id);
    const out = [];
    for (const [token, p] of this.previews)
      if (!p.scope || written === p.scope || written.startsWith(p.scope + "/"))
        out.push({ type: "preview.invalidated", token, path: written });
    return out;
  }
}

export function guestWebPreferences(session) {
  return {
    session,
    preload: undefined,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
  };
}

export function hardenPreviewSession(session, token) {
  const own = `${PREVIEW_SCHEME}://${token}/`;
  session.setPermissionRequestHandler((wc, permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.on("will-download", (event, item) => {
    event.preventDefault();
    item.cancel();
  });
  session.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    const url = String(details.url);
    callback({ cancel: !(url.startsWith(own) || url.startsWith("data:") || url.startsWith("blob:")) });
  });
}

export function hardenPreviewContents(webContents, token) {
  const own = `${PREVIEW_SCHEME}://${token}/`;
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const stay = (event, url) => {
    if (!String(url).startsWith(own)) event.preventDefault();
  };
  webContents.on("will-navigate", stay);
  webContents.on("will-redirect", stay);
  webContents.on("will-attach-webview", (event) => event.preventDefault());
}
