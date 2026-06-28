/**
 * OPFS filesystem driver.
 *
 * Backs `FsDriver` with the Origin Private File System. Works in both a window
 * and a worker context (`navigator.storage` is available in workers), so it is
 * shared by the tab adapter (`web.ts`) and the SharedWorker engine host.
 */

import type { FsDriver } from "../driver";

export class OpfsFsDriver implements FsDriver {
  private root: FileSystemDirectoryHandle | null = null;

  private async getRoot(): Promise<FileSystemDirectoryHandle> {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
    return this.root;
  }

  private async getDir(
    path: string,
    create = false,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split("/").filter(Boolean);
    const name = parts.pop()!;
    let dir = await this.getRoot();
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return { dir, name };
  }

  async read(path: string): Promise<Uint8Array | null> {
    try {
      const { dir, name } = await this.getDir(path);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      return null;
    }
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    const { dir, name } = await this.getDir(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(data as ArrayBufferView<ArrayBuffer>);
    await writable.close();
  }

  async delete(path: string): Promise<void> {
    try {
      const { dir, name } = await this.getDir(path);
      await dir.removeEntry(name);
    } catch {
      // File doesn't exist — no-op
    }
  }

  async list(dirPath: string): Promise<string[]> {
    try {
      const parts = dirPath.split("/").filter(Boolean);
      let dir = await this.getRoot();
      for (const part of parts) {
        dir = await dir.getDirectoryHandle(part);
      }
      const names: string[] = [];
      for await (const key of (dir as any).keys()) {
        names.push(key);
      }
      return names;
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.getDir(path);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }
}
