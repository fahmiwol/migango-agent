// ARS-014 §4: builds the app's ScreenOcr (screen_capture + ocr_read) on the Windows OS layer.
// Artifacts live in the app data folder, never in the workspace. hideSelf/showSelf use the main
// BrowserWindow so a full-screen capture never contains the app itself. Input control mode is
// NOT wired here.
import path from "node:path";
import { ScreenOcr, WindowsScreenOs } from "../tools/screen-ocr.mjs";

// Time for the compositor to redraw after hiding the window (value not measured on hardware).
const SETTLE_MS = 250;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createAppScreen({ getWindow, dataRoot, desktop, wait = () => delay(SETTLE_MS), run, platform }) {
  if (typeof getWindow !== "function") throw Error("createAppScreen needs getWindow");
  if (typeof dataRoot !== "string" || !path.isAbsolute(dataRoot))
    throw Error("createAppScreen needs an absolute app data folder");
  let restore = false;
  const live = () => {
    const w = getWindow();
    return w && !w.isDestroyed() ? w : null;
  };
  const hideSelf = async () => {
    const w = live();
    if (!w) return false;
    restore = w.isVisible();
    if (restore) w.hide();
    if (w.isVisible()) return false;
    await wait();
    return true;
  };
  const showSelf = async () => {
    const w = live();
    const again = restore;
    restore = false;
    if (w && again) w.show();
  };
  const os = new WindowsScreenOs({
    desktop,
    stagingDir: path.join(dataRoot, "artifacts", "screen-staging"),
    hideSelf,
    showSelf,
    ...(run ? { run } : {}),
    ...(platform ? { platform } : {}),
  });
  return new ScreenOcr({ os, artifactDir: path.join(dataRoot, "artifacts", "screen") });
}
