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

// =============================================================================
// TEMPORARY: export timing instrumentation
// =============================================================================

/**
 * Diagnostic timing for the export walk. Every line is prefixed with
 * {@link PERF_TAG} so it can be filtered out of the console in one search.
 *
 * Deliberately NOT gated behind `import.meta.env.DEV`: the report is needed
 * from a packaged desktop build, where that flag is false. Remove this block
 * and its call sites once the dominant cost is known.
 */
const PERF_TAG = "[TASFER-EXPORT-PERF]";

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

class ExportPerf {
  private readonly startedAt = nowMs();
  private readonly totals = new Map<string, { ms: number; calls: number }>();
  private readonly samples: Array<{ seq: number; line: string; ms: number }> =
    [];
  private seq = 0;

  /** Time one awaited step, logging it and folding it into the totals. */
  async step<T>(
    label: string,
    detail: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const seq = ++this.seq;
    const t0 = nowMs();
    try {
      return await run();
    } finally {
      const ms = nowMs() - t0;
      const bucket = this.totals.get(label) ?? { ms: 0, calls: 0 };
      bucket.ms += ms;
      bucket.calls += 1;
      this.totals.set(label, bucket);

      // The sequence number is the point: if the walk really does slow down
      // toward the end, these climb with it.
      const line = `#${seq} ${label} ${ms.toFixed(1)}ms ${detail}`;
      this.samples.push({ seq, line, ms });
      console.log(`${PERF_TAG} ${line}`);
    }
  }

  /** Summary: where the wall clock went, and the worst offenders. */
  report(pageCount: number, assetCount: number): void {
    const wall = nowMs() - this.startedAt;
    console.log(
      `${PERF_TAG} SUMMARY ${wall.toFixed(0)}ms total — ` +
        `${pageCount} pages, ${assetCount} assets`,
    );
    const byCost = [...this.totals.entries()].sort((a, b) => b[1].ms - a[1].ms);
    for (const [label, { ms, calls }] of byCost) {
      const share = wall > 0 ? ((ms / wall) * 100).toFixed(0) : "0";
      const avg = calls > 0 ? (ms / calls).toFixed(1) : "0";
      console.log(
        `${PERF_TAG} SUMMARY ${label}: ${ms.toFixed(0)}ms (${share}% of total) ` +
          `over ${calls} calls, ${avg}ms avg`,
      );
    }

    // First vs. last quarter of the walk — the direct answer to "are the last
    // pages slower?" without reading every line.
    const ordered = [...this.samples].sort((a, b) => a.seq - b.seq);
    const quarter = Math.floor(ordered.length / 4);
    if (quarter > 0) {
      const mean = (xs: typeof ordered) =>
        xs.reduce((sum, s) => sum + s.ms, 0) / xs.length;
      const head = mean(ordered.slice(0, quarter));
      const tail = mean(ordered.slice(-quarter));
      console.log(
        `${PERF_TAG} SUMMARY drift: first ${quarter} steps ${head.toFixed(1)}ms avg, ` +
          `last ${quarter} ${tail.toFixed(1)}ms avg ` +
          `(${head > 0 ? (tail / head).toFixed(2) : "?"}x)`,
      );
    }

    for (const s of [...this.samples].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
      console.log(`${PERF_TAG} SUMMARY slowest ${s.line}`);
    }
  }
}

/**
 * How many asset fetches may be in flight at once.
 *
 * Small on purpose. The win being bought is overlapping the fixed wait a
 * missing asset costs, and a handful of workers collapses that for any
 * realistic number of missing images; raising it further would only widen how
 * much real transfer traffic an export can put on the peer connection at once.
 */
export const ASSET_FETCH_CONCURRENCY = 6;

/**
 * `items.map(fn)` with at most `limit` calls outstanding. Results stay in input
 * order regardless of completion order, and the first rejection propagates.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
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

  const perf = new ExportPerf(); // TEMPORARY — see ExportPerf

  // Root pages first, so the progress total starts at something real and grows
  // as the walk discovers children rather than counting the tree twice.
  const trees: Array<{ space: ExportSpace; pages: PageListItem[] }> = [];
  for (const space of spaces) {
    stop();
    const pages = await perf.step("listPages", `space=${space.id} root`, () =>
      source.listPages(space.id, null),
    );
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
      const page = await perf.step(
        "getPage",
        `id=${listPage.id} depth=${parentPath.split("/").length - 1} "${listPage.title}"`,
        () => source.getPage(listPage.id),
      );
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
        const children = await perf.step(
          "listPages",
          `parent=${listPage.id}`,
          () => source.listPages(spaceId, listPage.id),
        );
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

  // Resolved together rather than one after another. A ref no one can supply
  // costs a fixed wait — the replicator has to give up on peers before it can
  // answer "gone" — and serially that wait is paid once per missing image. It
  // is dead time, not work, so overlapping it collapses the whole set into a
  // single wait. The bound keeps real transfers from flooding the peer
  // connection all at once (compare AssetPrefetcher, which stays strictly
  // sequential precisely to protect op replication in the background).
  const refs = [...assetRefs];
  const fetched = await mapWithConcurrency(
    refs,
    ASSET_FETCH_CONCURRENCY,
    async (ref) => {
      stop();
      const asset = await perf.step(
        "fetchAsset",
        `ref=${ref.slice(0, 16)}`,
        () => source.fetchAsset(ref),
      );
      done++;
      report();
      return asset;
    },
  );

  // Names are assigned in ref order, not completion order, so the bundle is
  // identical whatever sequence the fetches happen to finish in.
  let imageIndex = 0;
  for (const [i, ref] of refs.entries()) {
    const asset = fetched[i];
    if (!asset) continue;
    // An asset hash doubles as a stable filename; anything else (an external
    // url, say) gets an indexed one.
    const fileName = /^[\w-]+$/.test(ref)
      ? `${ref}.${extFromMime(asset.mime)}`
      : `image_${imageIndex++}.${extFromMime(asset.mime)}`;
    refToFileName.set(ref, fileName);
    entries.push({ path: `images/${fileName}`, data: asset.data });
  }

  stop();

  // Synchronous, so it is timed as one block rather than per page.
  await perf.step("serialize", `${pending.length} pages`, async () => {
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
  });

  perf.report(pending.length, assetRefs.size); // TEMPORARY — see ExportPerf
  return entries;
}
