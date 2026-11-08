// Separate explicit user launch intent from flags inherited by a second Electron instance.
export function createWindowIntent(getWindow) {
  let pending=false, isReady=false;
  const show=()=>{
    const window=getWindow();
    if(!isReady||!window||window.isDestroyed())return;
    if(window.isMinimized())window.restore();
    window.show();window.focus();pending=false;
  };
  return {
    request(args=[],data={}) {
      if(data.intent==='background'||(!data.intent&&args.includes('--background')))return;
      pending=true;show();
    },
    ready(background){isReady=true;if(pending||!background){pending=true;show();}},
  };
}
