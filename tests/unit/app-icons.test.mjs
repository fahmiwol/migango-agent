import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('one logo master supplies a valid multi-size Windows ICO and matching favicon PNG',async()=>{
 const base=new URL('../../ui/assets/',import.meta.url);
 const meta=JSON.parse(await fs.readFile(new URL('migango-icons.json',base),'utf8'));
 assert.equal(sha(await fs.readFile(new URL(meta.source,base))),meta.sourceSha256);
 const png=await fs.readFile(new URL('migango.png',base)),ico=await fs.readFile(new URL('migango.ico',base));
 assert.equal(sha(png),meta.pngSha256);assert.equal(sha(ico),meta.icoSha256);
 assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),7);
 for(let i=0;i<7;i++){
  const at=6+i*16,size=ico[at]||256,len=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
  assert(offset>=118&&offset+len<=ico.length);const image=ico.subarray(offset,offset+len);
  assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16),size);assert.equal(image.readUInt32BE(20),size);
  if(size===256)assert.equal(sha(image),sha(png));
 }
});
