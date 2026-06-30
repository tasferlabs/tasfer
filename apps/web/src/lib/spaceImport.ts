/**
 * Import markdown / text / ZIP files into a space as pages.
 *
 * The shared import engine behind both the "Import all" dialog and the editor
 * drag-and-drop drop target. Keeping the ZIP page-tree reconstruction and the
 * markdown→blocks pipeline here (instead of inline in a dialog) means the two
 * entry points stay byte-for-byte consistent and there is one place to fix.
 *
 * Pure (no React): callers drive progress through {@link ImportToSpaceOptions}
 * and translate {@link NoImportablePagesError} for display.
 */

import JSZip from "jszip";
import { getPlatform } from "@/platform";
import { tokenizePage, parsePage, parseFrontmatter } from "@cypherkit/editor";
import { extractTitleFromBlocks } from "@cypherkit/editor/internal";
import { createPage, updatePage } from "@/app/api/pages.api";
import { uploadImage } from "@/app/api/images.api";

/** A page reconstructed from the ZIP folder layout. */
interface PageNode {
  name: string;
  zipPath: string;
  children: PageNode[];
}

export interface ImportProgress {
  done: number;
  total: number;
}

export interface ImportToSpaceOptions {
  /** Called as work completes so a host can render a progress bar. */
  onProgress?: (progress: ImportProgress) => void;
  /** Polled between units of work; return true to stop early. */
  isAborted?: () => boolean;
}

export interface ImportToSpaceResult {
  pagesCreated: number;
  imagesUploaded: number;
  /** The first page created, so a host can navigate to it. */
  firstPageId: string | null;
  errors: string[];
}

/** Thrown when a ZIP contains no markdown files to import. */
export class NoImportablePagesError extends Error {
  constructor() {
    super("No importable pages found");
    this.name = "NoImportablePagesError";
  }
}

const DOC_EXTENSIONS = [".md", ".txt"];

/** Whether a file is one this importer accepts (markdown, text, or ZIP). */
export function isImportableSpaceFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || DOC_EXTENSIONS.some((e) => name.endsWith(e));
}

/** Guess MIME type from file extension. */
function guessMimeType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    bmp: "image/bmp",
  };
  return map[ext || ""] || "application/octet-stream";
}

/** Replace ./images/{filename} with the uploaded asset id in markdown. */
function rewriteImageUrls(
  markdown: string,
  imageUrlMap: Map<string, string>,
): string {
  return markdown.replace(
    /\.\/images\/([^)"/?#\s]+)/g,
    (_match, fileName) => imageUrlMap.get(fileName) || `./images/${fileName}`,
  );
}

/**
 * Build a page tree from ZIP entries.
 * The export format uses space-level folders as the first segment.
 * We strip those and merge everything into the target space.
 */
function buildPageTree(zip: JSZip): {
  imageEntries: Array<{ path: string; entry: JSZip.JSZipObject }>;
  roots: PageNode[];
} {
  const imageEntries: Array<{ path: string; entry: JSZip.JSZipObject }> = [];
  const mdFiles: Array<{ stripped: string; fullPath: string }> = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;

    if (relativePath.startsWith("images/")) {
      imageEntries.push({ path: relativePath, entry });
      return;
    }

    if (!relativePath.endsWith(".md")) return;

    // Strip the first directory segment (space folder)
    const parts = relativePath.split("/");
    if (parts.length >= 2) {
      mdFiles.push({
        stripped: parts.slice(1).join("/"),
        fullPath: relativePath,
      });
    } else {
      // No space folder — treat as root-level
      mdFiles.push({ stripped: relativePath, fullPath: relativePath });
    }
  });

  // Build a map from stripped path to full ZIP path
  const pathMap = new Map<string, string>();
  for (const f of mdFiles) {
    pathMap.set(f.stripped, f.fullPath);
  }

  function buildLevelWithPrefix(paths: string[], prefix: string): PageNode[] {
    const nodes: PageNode[] = [];
    const directFiles: string[] = [];
    const subdirs = new Map<string, string[]>();

    for (const p of paths) {
      const parts = p.split("/");
      if (parts.length === 1) {
        directFiles.push(p);
      } else {
        const dir = parts[0];
        const rest = parts.slice(1).join("/");
        if (!subdirs.has(dir)) subdirs.set(dir, []);
        subdirs.get(dir)!.push(rest);
      }
    }

    for (const file of directFiles) {
      const name = file.replace(/\.md$/, "");
      const stripped = `${prefix}${file}`;
      nodes.push({
        name,
        zipPath: pathMap.get(stripped) || stripped,
        children: [],
      });
    }

    for (const [dir, contents] of subdirs) {
      const selfFile = `${dir}.md`;
      const hasSelfFile = contents.includes(selfFile);
      const childPaths = contents.filter((c) => c !== selfFile);

      if (hasSelfFile) {
        const fullChildren = buildLevelWithPrefix(
          childPaths,
          `${prefix}${dir}/`,
        );
        const selfStripped = `${prefix}${dir}/${selfFile}`;
        nodes.push({
          name: dir,
          zipPath: pathMap.get(selfStripped) || selfStripped,
          children: fullChildren,
        });
      } else {
        const innerNodes = buildLevelWithPrefix(contents, `${prefix}${dir}/`);
        nodes.push(...innerNodes);
      }
    }

    return nodes;
  }

  const strippedPaths = mdFiles.map((f) => f.stripped);
  const roots = buildLevelWithPrefix(strippedPaths, "");
  return { imageEntries, roots };
}

/** Count total nodes in the tree. */
function countNodes(nodes: PageNode[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1 + countNodes(node.children);
  }
  return count;
}

async function importZip(
  file: File,
  spaceId: string,
  result: ImportToSpaceResult,
  opts: ImportToSpaceOptions,
): Promise<void> {
  const aborted = () => opts.isAborted?.() ?? false;

  const zipData = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(zipData);

  const { imageEntries, roots } = buildPageTree(zip);

  if (roots.length === 0) {
    throw new NoImportablePagesError();
  }

  const total = countNodes(roots) + imageEntries.length;
  let done = 0;
  opts.onProgress?.({ done, total });

  // Step 1: Upload images and build a fileName → asset-id map.
  const imageUrlMap = new Map<string, string>();
  for (const { path, entry } of imageEntries) {
    if (aborted()) return;
    const fileName = path.split("/").pop()!;
    try {
      const blob = await entry.async("blob");
      const imageFile = new File([blob], fileName, {
        type: guessMimeType(fileName),
      });
      const uploaded = await uploadImage(imageFile);
      imageUrlMap.set(fileName, uploaded.id);
      result.imagesUploaded++;
    } catch {
      result.errors.push(`Failed to upload image: ${fileName}`);
    }
    done++;
    opts.onProgress?.({ done, total });
  }

  // Step 2: Create pages top-down.
  const platform = getPlatform();
  async function createPages(
    nodes: PageNode[],
    parentId: string | null,
  ): Promise<void> {
    for (const node of nodes) {
      if (aborted()) return;
      try {
        const zipEntry = zip.file(node.zipPath);
        if (!zipEntry) {
          result.errors.push(`File not found in ZIP: ${node.zipPath}`);
          done++;
          opts.onProgress?.({ done, total });
          continue;
        }

        const mdContent = await zipEntry.async("string");
        const rewritten = rewriteImageUrls(mdContent, imageUrlMap);
        const { content: body, metadata } = parseFrontmatter(rewritten);
        const tokens = tokenizePage(body);
        const page = parsePage(tokens);
        const title = extractTitleFromBlocks(page.blocks) || node.name;

        const createdPage = await createPage({
          title,
          parentId,
          spaceId,
          ...(metadata?.task && { task: true }),
          ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
          ...(metadata?.duration != null && { duration: metadata.duration }),
          ...(metadata?.allDay != null && { allDay: metadata.allDay }),
        });
        await platform.ops.writeBlocks(createdPage.id, page.blocks);
        if (metadata?.color) {
          await updatePage({ id: createdPage.id, color: metadata.color });
        }

        result.pagesCreated++;
        if (!result.firstPageId) result.firstPageId = createdPage.id;
        done++;
        opts.onProgress?.({ done, total });

        if (node.children.length > 0) {
          await createPages(node.children, createdPage.id);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        result.errors.push(`Failed to import page "${node.name}": ${msg}`);
        done++;
        opts.onProgress?.({ done, total });
      }
    }
  }

  await createPages(roots, null);
}

async function importMarkdownFiles(
  mdFiles: File[],
  spaceId: string,
  result: ImportToSpaceResult,
  opts: ImportToSpaceOptions,
): Promise<void> {
  const aborted = () => opts.isAborted?.() ?? false;
  const platform = getPlatform();

  const total = mdFiles.length;
  let done = 0;
  opts.onProgress?.({ done, total });

  for (const file of mdFiles) {
    if (aborted()) return;
    try {
      const rawContent = await file.text();
      const { content: body, metadata } = parseFrontmatter(rawContent);
      const tokens = tokenizePage(body);
      const page = parsePage(tokens);
      const nameWithoutExt = file.name.replace(/\.(md|txt)$/i, "");
      const title = extractTitleFromBlocks(page.blocks) || nameWithoutExt;

      const createdPage = await createPage({
        title,
        parentId: null,
        spaceId,
        ...(metadata?.task && { task: true }),
        ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
        ...(metadata?.duration != null && { duration: metadata.duration }),
        ...(metadata?.allDay != null && { allDay: metadata.allDay }),
      });
      await platform.ops.writeBlocks(createdPage.id, page.blocks);
      if (metadata?.color) {
        await updatePage({ id: createdPage.id, color: metadata.color });
      }

      result.pagesCreated++;
      if (!result.firstPageId) result.firstPageId = createdPage.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      result.errors.push(`Failed to import "${file.name}": ${msg}`);
    }
    done++;
    opts.onProgress?.({ done, total });
  }
}

/**
 * Import a set of files into `spaceId` as pages. A single ZIP is expanded into
 * its page tree (rebuilding parent/child structure and uploading bundled
 * images); markdown/text files each become a top-level page. Throws
 * {@link NoImportablePagesError} when a ZIP has no markdown inside.
 */
export async function importFilesToSpace(
  files: File[],
  spaceId: string,
  opts: ImportToSpaceOptions = {},
): Promise<ImportToSpaceResult> {
  const result: ImportToSpaceResult = {
    pagesCreated: 0,
    imagesUploaded: 0,
    firstPageId: null,
    errors: [],
  };

  if (files.length === 1 && files[0].name.toLowerCase().endsWith(".zip")) {
    await importZip(files[0], spaceId, result, opts);
  } else {
    const mdFiles = files.filter((f) =>
      DOC_EXTENSIONS.some((e) => f.name.toLowerCase().endsWith(e)),
    );
    await importMarkdownFiles(mdFiles, spaceId, result, opts);
  }

  return result;
}
