// PRD-008: one global navigation; real renderer, guest/session and draft preservation.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {_electron} from 'playwright-core';
const root=path.resolve(import.meta.dirname,'../..');
test('real Electron: one navigation keeps every workspace tool, guest parent and draft', {timeout:60000}, async t=>{
 const data=await fs.mkdtemp(path.join(os.tmpdir(),'migan-nav-'));
 const env={...process.env,WORKBENCH_TEST_DATA:data};delete env.ELECTRON_RUN_AS_NODE;
 const desktop=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root],env,timeout:30000});
 t.after(async()=>{await desktop.close();await fs.rm(data,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 const page=await desktop.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.waitForLoadState('domcontentloaded');
 await page.waitForFunction(()=>document.getElementById('settingsDialog')?.open);
 await page.locator('#closeSettings').click();
 assert.equal(await page.locator('[data-tab]').count(),0,'right panel must not repeat global navigation');
 assert.equal(await page.locator('.galaxy-nav [data-nav]').count(),9);
 assert.equal((await page.locator('[data-nav="activity"]').innerText()).trim(),'Jejak kerja');
 assert.equal((await page.locator('#agentsBtn').innerText()).trim(),'Tim AI');
 await page.locator('#prompt').fill('Draf saya harus tetap utuh: café 🌱');
 const targets=['files','browser','activity','computer','research','recovery','skills','memory'];
 for(const target of targets){
  await page.locator(`[data-nav="${target}"]`).click();
  await page.waitForFunction(n=>!document.getElementById(n+'Pane').hidden,target);
  assert.equal(await page.locator('.galaxy-nav [aria-current="page"]').count(),1);
  assert.equal(await page.locator(`[data-nav="${target}"]`).getAttribute('aria-current'),'page');
  assert.equal(await page.locator('#workspacePanelTitle').innerText(),await page.locator(`[data-nav="${target}"]`).innerText());
  assert.equal(await page.locator('#prompt').inputValue(),'Draf saya harus tetap utuh: café 🌱');
 }
 await page.locator('[data-nav="files"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-nav="files"]').getAttribute('aria-current')==='page');
 await page.locator('[data-nav="files"]').focus();
 await page.keyboard.press('ArrowDown');
 assert.equal(await page.locator('[data-nav="files"]').getAttribute('aria-current'),'page','arrow keys only move focus');
 await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('[data-nav="browser"]').getAttribute('aria-current')==='page');
 assert.equal(await page.locator('[data-nav="browser"]').getAttribute('aria-current'),'page');
 await page.evaluate(async()=>{
  const button=document.querySelector('[data-nav="files"]');
  const route=button.dataset.nav;button.dataset.nav='constructor';
  await button.onclick();button.dataset.nav=route;
 });
 assert.equal(await page.locator('[data-nav="browser"]').getAttribute('aria-current'),'page','unknown route must not change the selected view');
 for(let i=0;i<10;i++)await page.evaluate(async()=>{
  await Promise.all([document.querySelector('[data-nav="browser"]').onclick(),document.querySelector('[data-nav="files"]').onclick()]);
 });
 assert.equal(await page.locator('[data-nav="files"]').getAttribute('aria-current'),'page','latest rapid navigation wins');
 assert.equal(await page.locator('#workspacePanelTitle').innerText(),'Berkas');
 assert.equal(await page.locator('#filesPane').isVisible(),true);
 await page.locator('[data-nav="activity"]').focus();await page.keyboard.press('ArrowUp');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.nav),'home','arrow traversal stays in navigation');
 assert.equal(await page.locator('[data-nav="files"]').getAttribute('aria-current'),'page','focus on Home must not activate it');
 await page.keyboard.press('End');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.nav),'recovery');
 await page.evaluate(()=>{document.querySelector('[data-nav="memory"]').disabled=true;});
 await page.locator('[data-nav="computer"]').focus();await page.keyboard.press('ArrowDown');
 assert.equal(await page.evaluate(()=>document.activeElement.dataset.nav),'skills','disabled destinations are skipped');
 await page.evaluate(()=>{document.querySelector('[data-nav="memory"]').disabled=false;});
 await page.locator('[data-nav="browser"]').click();
 const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Navigation fixture</title><label>Draft <input id="guestDraft"></label>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const url=`http://127.0.0.1:${server.address().port}/`;
 await page.locator('#address').fill(url);await page.locator('#addressForm button').click();
 await page.waitForFunction(async()=>{const s=await window.workbench.browserSnapshot();return s.title==='Navigation fixture';});
 const remote=desktop.windows().find(w=>w.url()===url);assert.ok(remote,'controlled guest must load the local fixture');
 await remote.locator('#guestDraft').fill('Guest state stays here');
 const guest=await desktop.evaluate(({webContents},url)=>{
  const child=webContents.getAllWebContents().find(w=>w.getURL()===url);
  return {id:child.id,url:child.getURL()};
 },url);
 await page.evaluate(()=>{
  const container=document.getElementById('browserSurface');
  window.__navContainer=container;window.__navParent=container.parentNode;window.__navMoves=0;
  window.__navObserver=new MutationObserver(()=>{if(container.parentNode!==window.__navParent)window.__navMoves++;});
  window.__navObserver.observe(document.body,{childList:true,subtree:true});
 });
 for(let i=0;i<10;i++){await page.locator('[data-nav="files"]').click();await page.locator('[data-nav="browser"]').click();}
 assert.deepEqual(await page.evaluate(()=>({same:document.getElementById('browserSurface')===window.__navContainer,moves:window.__navMoves})),{same:true,moves:0});
 const after=await desktop.evaluate(({webContents},url)=>{
  const child=webContents.getAllWebContents().find(w=>w.getURL()===url);
  return {id:child.id,url:child.getURL()};
 },url);
 assert.deepEqual(after,guest);
 assert.equal(await remote.locator('#guestDraft').inputValue(),'Guest state stays here','navigation must not reload the guest');
 await desktop.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:'));w.setContentSize(1280,720);});
 await page.waitForFunction(()=>window.innerWidth===1280&&window.innerHeight===720);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'1280px layout must not overflow horizontally');
 assert.equal(await page.locator('#prompt').inputValue(),'Draf saya harus tetap utuh: café 🌱');
 if(process.env.MIGANGO_UI_EVIDENCE_DIR){
  await page.locator('[data-nav="files"]').click();
  await page.waitForFunction(()=>!document.getElementById('filesPane').hidden);
  await page.screenshot({path:path.join(process.env.MIGANGO_UI_EVIDENCE_DIR,'navigation-alpha3.png')});
 }
 await page.locator('[data-nav="home"]').click();await page.waitForFunction(()=>document.activeElement.id==='prompt');
 assert.deepEqual(errors,[]);
});
