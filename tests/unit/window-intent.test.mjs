import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWindowIntent} from '../../src/desktop/window-intent.mjs';
test('explicit shortcut intent wins over inherited background args, background probes never focus',()=>{
 let calls=[];let win;const state=createWindowIntent(()=>win);
 state.request(['--background'],{intent:'show'});
 win={isDestroyed:()=>false,isMinimized:()=>true,restore:()=>calls.push('restore'),show:()=>calls.push('show'),focus:()=>calls.push('focus')};
 state.ready(true);assert.deepEqual(calls,['restore','show','focus']);
 calls=[];state.request([],{intent:'background'});assert.deepEqual(calls,[]);
 state.request(['--background'],{intent:'show'});assert.deepEqual(calls,['restore','show','focus']);
});
