/**
 * Asset filenames are assembled from values a remote peer controls: a binary
 * asset frame carries both the content hash and the file extension. The name is
 * then joined onto the assets directory, so anything that escapes it is a
 * remote file-write primitive. `assetFileName` is the single choke point.
 */

import { describe, expect, it } from "vitest";
import { assetFileName } from "./engine";

const HASH = "a".repeat(64);

describe("assetFileName", () => {
  it("accepts a well-formed hash and extension", () => {
    expect(assetFileName(HASH, "png")).toBe(`${HASH}.png`);
  });

  it("lowercases the extension so lookup by prefix stays consistent", () => {
    expect(assetFileName(HASH, "PNG")).toBe(`${HASH}.png`);
  });

  it.each([
    ["path traversal", "bin/../../../../evil"],
    ["absolute escape", "/etc/cron.d/evil"],
    ["separator", "png/evil"],
    ["parent segment", ".."],
    ["dotfile", ".bashrc"],
    ["nul byte", "png\u0000.sh"],
    ["embedded space", "png .sh"],
    ["overlong", "a".repeat(64)],
    ["empty", ""],
  ])("degrades a hostile extension (%s) to bin", (_label, ext) => {
    const name = assetFileName(HASH, ext);
    expect(name).toBe(`${HASH}.bin`);
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });

  it.each([
    ["too short", "abc"],
    ["non-hex", "z".repeat(64)],
    ["path traversal", "../".repeat(21) + "a"],
    ["empty", ""],
  ])("rejects a hostile hash (%s)", (_label, hash) => {
    expect(() => assetFileName(hash, "png")).toThrow(/Invalid asset hash/);
  });
});
