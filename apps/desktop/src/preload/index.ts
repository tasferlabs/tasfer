/**
 * Preload script — runs in renderer context with Node.js access.
 * Exposes `window.cypher` bridge for the ElectronPlatform adapter.
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
};

contextBridge.exposeInMainWorld("cypher", bridge);
