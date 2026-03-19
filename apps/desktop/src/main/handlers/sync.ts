/**
 * Sync handlers — P2P sync via hyperswarm (stub).
 *
 * TODO: Implement full P2P sync with hyperswarm.
 * For now, all operations work locally. The CRDT engine still
 * functions — it just doesn't have remote peers to sync with yet.
 */

import { ipcMain } from "electron";

export function registerSyncHandlers() {
  ipcMain.handle(
    "sync:joinRoom",
    (_event, _roomId: string, _peerId: string, _user?: any) => {
      // Stub — no remote peers yet
    },
  );

  ipcMain.handle("sync:leaveRoom", (_event, _roomId: string) => {
    // Stub
  });

  ipcMain.handle(
    "sync:sendOperations",
    (_event, _roomId: string, _ops: any[]) => {
      // Stub — operations are saved locally by the CRDT engine
    },
  );

  ipcMain.handle(
    "sync:sendSyncRequest",
    (_event, _roomId: string, _vv: any, _clock?: any) => {
      // Stub
    },
  );

  ipcMain.handle(
    "sync:sendSyncResponse",
    (_event, _roomId: string, _ops: any[], _vv: any, _target?: string) => {
      // Stub
    },
  );

  ipcMain.handle(
    "sync:sendAwareness",
    (_event, _roomId: string, _state: any) => {
      // Stub
    },
  );
}
