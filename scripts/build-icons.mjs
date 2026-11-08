// Run with the pinned Electron binary. Render the existing vector, never redraw the logo.
import {app,BrowserWindow} from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'..'),base=path.join(root,'ui/assets');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
app.setName('miganGO-icon-builder');
app.setPath('userData',path.join(os.tmpdir(),'migango-icon-builder'));
app.disableHardwareAcceleration();
let win;
app.whenReady().then(async()=>{try{
 const svg=await fs.readFile(path.join(base,'migancore-logo.svg'));
 if(/<script|<foreignObject|href=["']https?:/i.test(svg.toString()))throw Error('Unexpected active/external SVG content');
 win=new BrowserWindow({show:false,width:300,height:300,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
 await win.loadURL('data:text/html,<html><body></body></html>');
 const sizes=[16,24,32,48,64,128,256],images=[];
 for(const size of sizes){
  const data=await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>{const c=document.createElement('canvas');c.width=c.height=${size};const x=c.getContext('2d');const w=${size}*.90,h=w*24/39;x.drawImage(image,(${size}-w)/2,(${size}-h)/2,w,h);resolve(c.toDataURL('image/png').split(',')[1]);};image.onerror=()=>reject(Error('SVG render failed'));image.src=${JSON.stringify('data:image/svg+xml;base64,'+svg.toString('base64'))};})`);
  images.push(Buffer.from(data,'base64'));
 }
 const header=Buffer.alloc(6+16*sizes.length);header.writeUInt16LE(1,2);header.writeUInt16LE(sizes.length,4);
 let offset=header.length;
 for(let i=0;i<sizes.length;i++){
  const at=6+i*16;header[at]=header[at+1]=sizes[i]===256?0:sizes[i];
  header.writeUInt16LE(1,at+4);header.writeUInt16LE(32,at+6);
  header.writeUInt32LE(images[i].length,at+8);header.writeUInt32LE(offset,at+12);offset+=images[i].length;
 }
 const png=images.at(-1),ico=Buffer.concat([header,...images]);
 await fs.writeFile(path.join(base,'migango.png'),png);await fs.writeFile(path.join(base,'migango.ico'),ico);
 await fs.writeFile(path.join(base,'migango-icons.json'),JSON.stringify({source:'migancore-logo.svg',sourceSha256:sha(svg),pngSha256:sha(png),icoSha256:sha(ico),sizes,method:'Pinned Electron SVG render; unchanged geometry and colors; transparent square canvas'},null,2)+'\n');
 console.log(JSON.stringify({sizes,sourceSha256:sha(svg),pngBytes:png.length,icoBytes:ico.length}));
}catch(error){console.error(error.message);process.exitCode=1;}finally{win?.destroy();app.quit();}});
