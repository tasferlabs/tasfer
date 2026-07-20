/**
 * Preload script — runs in renderer context with Node.js access.
 * Exposes `window.tasfer` bridge for the ElectronPlatform adapter.
 */

import { contextBridge, ipcRenderer } from "electron";

const bridge = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return ipcRenderer.invoke(channel, ...args);
  },

  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  platform: process.platform,

  // Whether the in-app developer tools should be shown, read synchronously from
  // the main process's persisted "Show Developer Tools" menu setting before any
  // renderer script runs. Mirrors `platform` as a static launch-time value the
  // web app reads (see `@/lib/devTools`); runtime changes arrive via the
  // `devtools:set` event the main process pushes when the menu item is toggled.
  devToolsEnabled: ipcRenderer.sendSync("devtools:get-sync") as boolean,

  // Whether the host is running a tiling window manager (i3, sway, …), read
  // synchronously at launch like `platform`. The custom window controls hide the
  // minimize/maximize buttons when true — those actions don't apply there.
  tilingWm: ipcRenderer.sendSync("wm:tiling-sync") as boolean,
};

contextBridge.exposeInMainWorld("tasfer", bridge);
