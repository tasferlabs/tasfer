/**
 * Build the export bundle for one or more spaces.
 *
 * The counterpart to {@link ./spaceImport}, and pure for the same reason: the
 * app zips this into a download, `tasfer export` writes it to a file on a box
 * with no browser, and the layout the importer reconstructs has to be the one
 * either of them produced. Callers supply the reads (page tree, page content,
 * asset bytes) and drive progress; nothing here touches the DOM, a Blob, or a
 * platform singleton.
 *
 * The layout is a directory per space, a `.md` per page, and one flat
 * `images/` folder:
 *
 *   My space/Note.md
 *   My space/Parent/Parent.md      a page that has children is its own folder
 *   My space/Parent/Child.md
 *   My space 2/...             a second space of the same name is numbered
 *   images/<hash>.png
 */

import {
  collectAssetRefs,
  serializeToMarkdown,
  type Block,
  type PageMetadata,
} from "@tasfer/editor";
// Types only: `@/platform`'s barrel reaches for a SharedWorker at import
// time, and this module has to load in a plain Node process too.
import type { PageFull, PageListItem } from "@/platform/types";
import { appDataSchema } from "@/appDataSchema";

/** A space to export, by id and display name. */
export interface ExportSpace {
  id: string;
  name: string;
}

/** One file in the bundle: a path relative to the archive root, and its bytes. */
export interface ExportEntry {
  path: string;
  data: string | Uint8Array;
}

/** Raw bytes behind an asset reference, with the mime type they were stored as. */
export interface ExportAsset {
  data: Uint8Array;
  mime: string;
}

export interface ExportProgress {
  done: number;
  total: number;
}

/**
 * The reads an export needs, so the same walk serves a browser tab and a
 * headless host. Both back onto the same engine; only the way an asset turns
 * into bytes differs.
 */
export interface ExportSource {
  /** Live pages under a parent (or the space root), tasks included. */
  listPages(spaceId: string, parentId: string | null): Promise<PageListItem[]>;
  /** A page with its content blocks. */
  getPage(id: string): Promise<PageFull>;
  /** Asset bytes for a reference, or null when it cannot be resolved. */
  fetchAsset(ref: string): Promise<ExportAsset | null>;
}

export interface ExportSpacesOptions {
  spaces: ExportSpace[];
  source: ExportSource;
  /** Called as work completes so a host can render a progress bar. */
  onProgress?: (progress: ExportProgress) => void;
  /** Polled between units of work; return true to stop early. */
  isAborted?: () => boolean;
}

/** Thrown when the abort signal fires mid-walk. */
export class ExportAbortedError extends Error {
  constructor() {
    super("Export aborted");
    this.name = "ExportAbortedError";
  }
}

/** Guess a file extension from a mime type. */
export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return map[mime] || "bin";
}

/** Sanitize a string for use as a filesystem name. */
export function sanitizeName(name: string): string {
  return (
    (name || "Untitled").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim() ||
    "Untitled"
  );
}

/** Relative prefix from a file up to the archive root ("A/B.md" → "../"). */
function relativeRootPrefix(entryPath: string): string {
  return "../".repeat(entryPath.split("/").length - 1);
}

function extractPageMetadata(page: PageFull): PageMetadata | undefined {
  const meta: PageMetadata = {};
  if (page.task) meta.task = true;
  if (page.scheduledAt) meta.scheduledAt = page.scheduledAt;
  if (page.duration != null) meta.duration = page.duration;
  if (page.allDay != null) meta.allDay = page.allDay;
  if (page.color) meta.color = page.color;
  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** Deduplicate a name within the set already used in the same directory. */
function deduplicateName(name: string, usedNames: Set<string>): string {
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  let i = 2;
  while (usedNames.has(`${name} ${i}`)) i++;
  const unique = `${name} ${i}`;
  usedNames.add(unique);
  return unique;
}

/**
 * Walk the spaces and return every file the archive should hold.
 *
 * Pages are serialized last, after the images are in hand: an asset reference
 * only becomes a relative path once it is known which refs actually resolved,
 * and one that did not keeps its original url rather than pointing at a file
 * the archive does not carry.
 */
export async function buildSpaceExport({
  spaces,
  source,
  onProgress,
  isAborted,
}: ExportSpacesOptions): Promise<ExportEntry[]> {
  const stop = () => {
    if (isAborted?.()) throw new ExportAbortedError();
  };

  const entries: ExportEntry[] = [];
  const assetRefs = new Set<string>();
  const pending: Array<{
    path: string;
    blocks: Block[];
    metadata?: PageMetadata;
  }> = [];

  let done = 0;
  let total = 0;
  const report = () => onProgress?.({ done, total });

  // Root pages first, so the progress total starts at something real and grows
  // as the walk discovers children rather than counting the tree twice.
  const trees: Array<{ space: ExportSpace; pages: PageListItem[] }> = [];
  for (const space of spaces) {
    stop();
    const pages = await source.listPages(space.id, null);
    trees.push({ space, pages });
    total += pages.length;
  }
  report();

  /**
   * `reserved` is the parent's own self-named file (`Foo` inside `Foo/`), held
   * back so a child page called Foo cannot overwrite its own parent.
   */
  async function walk(
    spaceId: string,
    pages: PageListItem[],
    parentPath: string,
    reserved?: string,
  ): Promise<void> {
    const usedNames = new Set<string>();
    if (reserved) usedNames.add(reserved);

    for (const listPage of pages) {
      stop();

      const pageName = deduplicateName(sanitizeName(listPage.title), usedNames);
      const page = await source.getPage(listPage.id);
      const blocks = page.blocks || [];

      for (const ref of collectAssetRefs(blocks, appDataSchema)) {
        assetRefs.add(ref);
      }

      pending.push({
        path: listPage.hasChildren
          ? `${parentPath}${pageName}/${pageName}.md`
          : `${parentPath}${pageName}.md`,
        blocks,
        metadata: extractPageMetadata(page),
      });

      if (listPage.hasChildren) {
        const children = await source.listPages(spaceId, listPage.id);
        total += children.length;
        await walk(spaceId, children, `${parentPath}${pageName}/`, pageName);
      }

      done++;
      report();
    }
  }

  // Two spaces can share a name; each still gets its own directory.
  const usedSpaceNames = new Set<string>();
  for (const { space, pages } of trees) {
    stop();
    const spaceName = deduplicateName(sanitizeName(space.name), usedSpaceNames);
    await walk(space.id, pages, `${spaceName}/`);
  }

  // Images, and the ref → bundled filename map the serializer needs.
  const refToFileName = new Map<string, string>();
  if (assetRefs.size > 0) {
    total += assetRefs.size;
    report();
  }

  let imageIndex = 0;
  for (const ref of assetRefs) {
    stop();
    const asset = await source.fetchAsset(ref);
    if (asset) {
      // An asset hash doubles as a stable filename; anything else (an external
      // url, say) gets an indexed one.
      const fileName = /^[\w-]+$/.test(ref)
        ? `${ref}.${extFromMime(asset.mime)}`
        : `image_${imageIndex++}.${extFromMime(asset.mime)}`;
      refToFileName.set(ref, fileName);
      entries.push({ path: `images/${fileName}`, data: asset.data });
    }
    done++;
    report();
  }

  stop();

  for (const { path, blocks, metadata } of pending) {
    const toRoot = relativeRootPrefix(path);
    entries.push({
      path,
      data: serializeToMarkdown(blocks, metadata, {
        schema: appDataSchema,
        mapAssetUrl: (url) => {
          const fileName = refToFileName.get(url);
          return fileName ? `${toRoot}images/${fileName}` : url;
        },
      }),
    });
  }

  return entries;
}
