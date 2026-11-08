const {app,safeStorage}=require('electron');const fs=require('node:fs/promises');const path=require('node:path');
app.setPath('userData',path.join(process.env.APPDATA,'migan-workbench'));
app.whenReady().then(async()=>{try{const data=JSON.parse(await fs.readFile(process.argv[2],'utf8'));const result=await require('./opus-main.cjs')({app,safeStorage},data);await fs.writeFile(data.output,JSON.stringify(result));app.exit(0);}catch(e){console.error('Opus isolated engineering failed:',e.message);app.exit(1);}});
