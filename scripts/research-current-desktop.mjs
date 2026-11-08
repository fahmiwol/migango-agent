import fs from 'node:fs/promises';
import path from 'node:path';
import {_electron} from 'playwright-core';
const root=path.resolve(import.meta.dirname,'..');
const sources=['docs/01-riset/RISET-003-peta-kapabilitas-dan-perjalanan-pengguna-agent-des/README.md','docs/01-riset/RISET-004-backbone-reutilisasi-estate-dan-model-per-tujuan/README.md'];
const urls=new Map();
for(const file of sources){
 const text=await fs.readFile(path.join(root,file),'utf8');
 for(const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g))urls.set(match[2],match[1].slice(0,200));
}
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const desktop=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:[root,'--open-last-run'],env,timeout:30000});
try{
 const page=await desktop.firstWindow();
 await page.waitForFunction(()=>document.querySelector('#workspacePath')?.textContent.length>0);
 const result=await page.evaluate(async rows=>{
  const settings=await window.workbench.settings();
  if(!settings.configured.anthropic||!settings.encrypted)throw Error('Expected persisted encrypted Anthropic vault');
  const imports=[];
  for(let start=0;start<rows.length;start+=100)imports.push(await window.workbench.researchImport(rows.slice(start,start+100).map(([url])=>url).join('\n')));
  let annotated=0;
  for(const [url,title] of rows){
   const found=(await window.workbench.researchList(url)).find(row=>row.url===url);
   if(found&&!found.note){
    await window.workbench.researchAnnotate({id:found.id,title,stage:'source-read',note:'Audit sumber primer oleh jalur riset agen atas permintaan pemilik, 22 Oktober2026. Rincian putusan, batas bukti, lisensi dan eksperimen: RISET-003/004 pada docs/01-riset. Ini catatan riset, bukan verifikasi runtime upstream atau benchmark.'});annotated++;
   }
  }
  return {configured:settings.configured.anthropic,encrypted:settings.encrypted,active:settings.active,model:settings.profiles.anthropic.model,imports,annotated,listed:(await window.workbench.researchList('')).length,listLimit:100};
 },[...urls]);
 await page.locator('[data-tab="research"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.reference-card').length>0);
 await page.screenshot({path:path.join(root,'evidence/miganGO-research-current.png')});
 await fs.writeFile(path.join(root,'evidence/research-desktop-current.json'),JSON.stringify({kind:'actual-userdata-no-model-call',at:new Date().toISOString(),sourceURLs:urls.size,...result},null,2));
 console.log(JSON.stringify({sourceURLs:urls.size,...result}));
}finally{await desktop.close();}
