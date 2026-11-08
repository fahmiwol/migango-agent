import { WebContentsView, session } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { safeBrowserURL } from "../tools/workspace.mjs";
export class ControlledBrowser {
  constructor(window, store, emit) {
    this.window = window;
    this.store = store;
    this.emit = emit;
    this.view = null;
    this.visible = false;
    this.rect = { x: 0, y: 0, width: 0, height: 0 };
  }
  ensure() {
    if (this.view) return this.view;
    const isolated = session.fromPartition(
      "workbench-isolated-" + randomUUID(),
    );
    isolated.setPermissionRequestHandler((wc, permission, cb) => cb(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.on("will-download", (e, item) => {
      e.preventDefault();
      item.cancel();
    });
    isolated.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        let permitted = false;
        try {
          permitted = ["http:", "https:", "data:", "blob:"].includes(
            new URL(details.url).protocol,
          );
        } catch {}
        callback({ cancel: !permitted });
      },
    );
    this.view = new WebContentsView({
      webPreferences: {
        session: isolated,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    const check = (event, url) => {
      try {
        safeBrowserURL(url);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", check);
    wc.on("will-redirect", check);
    wc.on("did-navigate", (_, url) => this.emit({ type: "browser-url", url }));
    wc.on("will-attach-webview", (e) => e.preventDefault());
    this.window.contentView.addChildView(this.view);
    this.update();
    return this.view;
  }
  update() {
    if (!this.view) return;
    const bounds = this.window.getContentBounds();
    const r = this.rect;
    const x = Math.max(0, Math.min(Math.round(r.x), bounds.width));
    const y = Math.max(0, Math.min(Math.round(r.y), bounds.height));
    const width = Math.max(0, Math.min(Math.round(r.width), bounds.width - x));
    const height = Math.max(
      0,
      Math.min(Math.round(r.height), bounds.height - y),
    );
    if (width > 0 && height > 0) this.view.setBounds({ x, y, width, height });
    this.view.setVisible(this.visible);
  }
  layout(rect, visible) {
    if (
      !rect ||
      ["x", "y", "width", "height"].some((k) => !Number.isFinite(rect[k]))
    )
      throw new Error("Invalid browser bounds");
    this.rect = rect;
    this.visible = visible === true;
    if (this.visible) this.ensure();
    this.update();
  }
  async navigate(url, signal) {
    signal?.throwIfAborted();
    const target = safeBrowserURL(url);
    const wc = this.ensure().webContents;
    const abort = () => wc.stop();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => wc.stop(), 30000);
    try {
      await wc.loadURL(target);
      signal?.throwIfAborted();
      return { url: wc.getURL(), title: wc.getTitle() };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  async evaluate(code, signal) {
    signal?.throwIfAborted();
    const wc = this.ensure().webContents;
    let timer;
    const wrapped = `(()=>{try{return {ok:true,value:(${code})};}catch(error){return {ok:false,error:String(error.message).slice(0,500)};}})()`;
    const result = await Promise.race([
      wc.executeJavaScriptInIsolatedWorld(999, [{ code: wrapped }]),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Browser operation timed out")),
          10000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    signal?.throwIfAborted();
    if (!result?.ok)
      throw new Error(result?.error || "Browser operation failed");
    return result.value;
  }
  async snapshot(signal) {
    const id = randomUUID();
    return this.evaluate(
      `(()=>{const candidates=Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&e.type!=='password'}).slice(0,100);const formState=e=>e.form?Array.from(e.form.elements).map(f=>({name:f.name,type:f.type,value:['password','file'].includes(f.type)?'[SENSITIVE]':f.value,checked:f.checked,disabled:f.disabled})):[];const fingerprint=e=>JSON.stringify({html:e.outerHTML,href:e.href||'',form:e.form?.action||'',method:e.form?.method||'',formState:formState(e),type:e.type||'',value:e.value||'',disabled:e.disabled||false,readOnly:e.readOnly||false});globalThis.__workbench={id:${JSON.stringify(id)},url:location.href,elements:candidates,fingerprint,formState,fingerprints:candidates.map(fingerprint)};return {snapshotId:${JSON.stringify(id)},url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,10000),targets:candidates.map((e,target)=>({target,tag:e.tagName,label:(e.getAttribute('aria-label')||e.innerText||e.getAttribute('placeholder')||e.name||'').slice(0,160),href:e.href||'',formAction:e.form?.action||''})),scope:'Top document only; no frame, shadow DOM, file upload or CAPTCHA automation'};})()`,
      signal,
    );
  }
  async prepare(type, args, signal) {
    return this.evaluate(
      `(()=>{const s=globalThis.__workbench;if(!s||s.id!==${JSON.stringify(args.snapshotId)}||s.url!==location.href)throw Error('Stale browser snapshot');const e=s.elements[${Number(args.target)}];if(!e?.isConnected||s.fingerprint(e)!==s.fingerprints[${Number(args.target)}])throw Error('Browser target changed; take a new snapshot');const formValues=s.formState(e);if(formValues.some(f=>f.type==='password'||f.type==='file'))throw Error('Forms containing password/file fields require manual use');return {pageURL:location.href,tag:e.tagName,label:(e.getAttribute('aria-label')||e.innerText||e.placeholder||e.name||'').slice(0,300),href:e.href||'',formAction:e.form?.action||'',formMethod:e.form?.method||'',formValues,fieldType:e.type||'',action:${JSON.stringify(type)}};})()`,
      signal,
    );
  }
  async action(type, args, signal) {
    const result = await this.evaluate(
      `(()=>{const s=globalThis.__workbench;if(!s||s.id!==${JSON.stringify(args.snapshotId)}||s.url!==location.href)throw Error('Stale browser snapshot');const e=s.elements[${Number(args.target)}];if(!e?.isConnected)throw Error('Target detached');if(s.fingerprint(e)!==s.fingerprints[${Number(args.target)}])throw Error('Browser target changed after observation/approval');if(e.type==='password'||e.type==='file')throw Error('Sensitive field blocked');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const top=document.elementFromPoint(x,y);if(!top||!(top===e||e.contains(top)))throw Error('Target obscured');${type === "fill" ? `if(!['INPUT','TEXTAREA'].includes(e.tagName))throw Error('Only text inputs supported');if(e.disabled||e.readOnly)throw Error('Field is not editable');const setter=Object.getOwnPropertyDescriptor(e.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set;setter.call(e,${JSON.stringify(args.text)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));` : ""}globalThis.__workbench=null;return {x,y};})()`,
      signal,
    );
    if (type === "click") {
      const wc = this.view.webContents;
      wc.sendInputEvent({
        type: "mouseDown",
        x: Math.round(result.x),
        y: Math.round(result.y),
        button: "left",
        clickCount: 1,
      });
      wc.sendInputEvent({
        type: "mouseUp",
        x: Math.round(result.x),
        y: Math.round(result.y),
        button: "left",
        clickCount: 1,
      });
    }
    return { action: type, requiresFreshSnapshot: true };
  }
  async screenshot(signal) {
    signal?.throwIfAborted();
    const captured = await this.ensure().webContents.capturePage();
    const name = "browser-" + Date.now() + ".png";
    await fs.mkdir(path.join(this.store.root, "artifacts"), {
      recursive: true,
    });
    const png = captured.toPNG();
    await fs.writeFile(path.join(this.store.root, "artifacts", name), png);
    return {
      artifact: name,
      hash: createHash("sha256").update(png).digest("hex"),
      bytes: png.length,
      location: "Private application artifacts folder",
    };
  }
  close() {
    this.view?.webContents.close();
    this.view = null;
  }
}
