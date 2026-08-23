/**
 * Filesystem driver — node:fs rooted at the host's data directory.
 *
 * Paths reaching this driver are not all locally authored: an asset filename
 * is derived from bytes a remote peer sent. `path.join` collapses `..`, so it
 * alone would happily resolve outside the data directory — every operation
 * funnels through {@link resolve}, which is where containment is enforced.
 */

import fs from "node:fs";
import path from "node:path";
import type { FsDriver } from "@/platform/driver";

export class NodeFsDriver implements FsDriver {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private resolve(relativePath: string): string {
    const abs = path.join(this.root, relativePath);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(
        `Refusing path outside the data directory: ${relativePath}`,
      );
    }
    return abs;
  }

  async read(filePath: string): Promise<Uint8Array | null> {
    const abs = this.resolve(filePath);
    try {
      return new Uint8Array(fs.readFileSync(abs));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async write(filePath: string, data: Uint8Array): Promise<void> {
    const abs = this.resolve(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }

  async delete(filePath: string): Promise<void> {
    try {
      fs.unlinkSync(this.resolve(filePath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  async list(dirPath: string): Promise<string[]> {
    try {
      return fs.readdirSync(this.resolve(dirPath));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return fs.existsSync(this.resolve(filePath));
  }
}
