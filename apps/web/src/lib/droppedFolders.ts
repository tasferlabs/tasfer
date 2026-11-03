import type { FolderFile, ImportSelection } from "@/lib/spaceImport";

/**
 * Read what a drop carried, walking into dropped folders. When the drop holds
 * at least one folder the result is a folder selection — every file inside
 * the folders, plus any loose files dropped alongside them, each with its
 * path. Otherwise it is the plain file list.
 *
 * Call it synchronously inside the drop handler: the browser only hands out
 * the drop's entries during the event. The walk itself finishes afterwards.
 */
export function readDroppedFiles(dt: DataTransfer): Promise<ImportSelection> {
  const files = Array.from(dt.files);
  const entries = Array.from(dt.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null)
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (!entries.some((entry) => entry.isDirectory)) {
    return Promise.resolve({ kind: "files", files });
  }

  return (async () => {
    const found: FolderFile[] = [];
    for (const entry of entries) await walk(entry, entry.name, found);
    return { kind: "folder", files: found };
  })();
}

/** Collect the files under `entry`, skipping hidden ones (`.git`, …). */
async function walk(
  entry: FileSystemEntry,
  path: string,
  found: FolderFile[],
): Promise<void> {
  if (entry.name.startsWith(".")) return;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    found.push({ path, file });
    return;
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries hands children out in batches (100 at a time in Chromium);
    // an empty batch means the directory is exhausted.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject),
      );
      if (batch.length === 0) break;
      for (const child of batch) {
        await walk(child, `${path}/${child.name}`, found);
      }
    }
  }
}
