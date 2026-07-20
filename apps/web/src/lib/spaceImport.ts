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
import type { Block } from "@tasfer/editor/serlization/loadPage";
import { getPlatform } from "@/platform";
import { tokenizePage, parsePage, parseFrontmatter } from "@tasfer/editor";
import { deriveTitles, hasHeadingTitle } from "@/lib/pageTitle";
import { createPage, updatePage } from "@/app/api/pages.api";
import { uploadImage } from "@/app/api/images.api";
import { appDataSchema } from "@/appDataSchema";

/** A page reconstructed from the ZIP folder layout. */
interface PageNode {
  name: string;
  /**
   * The ZIP entry backing this page's content, or `""` for a folder that has
   * no self-named markdown file (imported from a plain directory of notes) —
   * such a node becomes an empty parent page.
   */
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
  /**
   * Parent page to import the top-level pages under. Defaults to null — the top
   * level of the space. (Nested pages inside a ZIP keep their own hierarchy
   * beneath this parent.)
   */
  parentId?: string | null;
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
 * Sidecar entries that archive tools bundle but which are never real pages:
 * macOS's `__MACOSX/` resource-fork tree, AppleDouble `._name` companions
 * (note these end in `.md` for markdown files, so an extension check alone
 * lets them through), and `.DS_Store`. Dropped before reconstructing the tree.
 */
function isArchiveArtifact(path: string): boolean {
  return path
    .split("/")
    .some(
      (segment) =>
        segment === "__MACOSX" ||
        segment === ".DS_Store" ||
        segment.startsWith("._"),
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
    if (isArchiveArtifact(relativePath)) return;

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
        // No self-named file (e.g. a plain directory of notes). Keep the
        // folder as an empty parent page so its structure is preserved,
        // rather than flattening its children up to this level.
        const innerNodes = buildLevelWithPrefix(contents, `${prefix}${dir}/`);
        nodes.push({ name: dir, zipPath: "", children: innerNodes });
      }
    }

    // Order each level folders-first, then leaf pages, each group by name.
    // (A node with children is a folder here; children were already sorted by
    // their own recursive call.)
    nodes.sort((a, b) => {
      const aFolder = a.children.length > 0;
      const bFolder = b.children.length > 0;
      if (aFolder !== bFolder) return aFolder ? -1 : 1;
      return compareByName(a.name, b.name);
    });
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

/**
 * Case-insensitive, numeric-aware name order, so imported pages land sorted by
 * name (e.g. `note2` before `note10`) rather than in ZIP / drop order.
 */
function compareByName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Turn a "cased" file name into a natural title. File names imported from other
 * tools are often slugs — `kebab-case`, `snake_case`, `camelCase`, `PascalCase`
 * — which read poorly as titles. Split those on their separators / case
 * boundaries and title-case the words:
 *   `my-note-title` → `My Note Title`, `meetingNotes` → `Meeting Notes`.
 *
 * Names that already contain whitespace are assumed to be natural titles (e.g.
 * this app's own exports keep the original casing and spacing) and returned
 * unchanged, so real casing like `NASA report` is preserved.
 */
function humanizeFileName(name: string): string {
  if (/\s/.test(name)) return name;
  const words = name
    .replace(/[_-]+/g, " ") // snake_case / kebab-case → spaces
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase / PascalCase → spaces
    .replace(/\s+/g, " ")
    .trim();
  if (!words) return name;
  return words
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Parse an imported document's body into blocks and resolve its title columns.
 *
 * A page's title is a projection of its blocks — the engine re-derives it on
 * every open (Engine.refreshDerivedTitlesFromBlocks) — so passing a title to
 * createPage does not make it stick. To use the file name as the title we seed
 * it as a heading block:
 *   - non-markdown files (`.txt`) always take the file name as their title;
 *   - markdown files keep their own heading, but fall back to the file name
 *     (seeded as a heading) when they have no heading of their own.
 *
 * `body` is the markdown with frontmatter already stripped. Parsing the seeded
 * heading and the body together (rather than concatenating two parsed trees)
 * keeps block ids and order keys internally consistent.
 */
function buildImportedPage(
  body: string,
  fileName: string,
  isMarkdown: boolean,
): { blocks: Block[]; title: string; titleMd: string } {
  if (isMarkdown) {
    const blocks = parsePage(
      tokenizePage(body, appDataSchema),
      appDataSchema,
    ).blocks;
    if (hasHeadingTitle(blocks)) {
      const { title, titleMd } = deriveTitles(blocks);
      return { blocks, title, titleMd };
    }
  }

  // No usable heading: title by the file name, seeded as a heading so it sticks
  // (the engine re-derives the title from the blocks). Cased slugs like
  // `my-note` are humanized to `My Note` first.
  const displayName = humanizeFileName(fileName);
  const blocks = parsePage(
    tokenizePage(`# ${displayName}\n\n${body}`, appDataSchema),
    appDataSchema,
  ).blocks;
  const { title, titleMd } = deriveTitles(blocks);
  return { blocks, title: title || displayName, titleMd };
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
        if (!node.zipPath) {
          // Folder with no backing markdown file: seed the parent page with a
          // heading holding the folder name, so it opens to a titled (not
          // blank) page instead of appearing blank.
          const { blocks, title, titleMd } = buildImportedPage(
            "",
            node.name,
            false,
          );
          const folderPage = await createPage({
            title,
            titleMd,
            parentId,
            spaceId,
          });
          await platform.ops.writeBlocks(folderPage.id, blocks);
          result.pagesCreated++;
          if (!result.firstPageId) result.firstPageId = folderPage.id;
          done++;
          opts.onProgress?.({ done, total });
          if (node.children.length > 0) {
            await createPages(node.children, folderPage.id);
          }
          continue;
        }

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
        // ZIP entries are always markdown (the tree only collects `.md`).
        const { blocks, title, titleMd } = buildImportedPage(
          body,
          node.name,
          true,
        );

        const createdPage = await createPage({
          title,
          titleMd,
          parentId,
          spaceId,
          ...(metadata?.task && { task: true }),
          ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
          ...(metadata?.duration != null && { duration: metadata.duration }),
          ...(metadata?.allDay != null && { allDay: metadata.allDay }),
        });
        await platform.ops.writeBlocks(createdPage.id, blocks);
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

  await createPages(roots, opts.parentId ?? null);
}

async function importMarkdownFiles(
  mdFiles: File[],
  spaceId: string,
  result: ImportToSpaceResult,
  opts: ImportToSpaceOptions,
): Promise<void> {
  const aborted = () => opts.isAborted?.() ?? false;
  const platform = getPlatform();

  // Create pages in name order rather than the order the OS handed us the drop.
  const files = [...mdFiles].sort((a, b) => compareByName(a.name, b.name));

  const total = files.length;
  let done = 0;
  opts.onProgress?.({ done, total });

  for (const file of files) {
    if (aborted()) return;
    try {
      const rawContent = await file.text();
      const { content: body, metadata } = parseFrontmatter(rawContent);
      const nameWithoutExt = file.name.replace(/\.(md|txt)$/i, "");
      // Only real markdown keeps a heading-derived title; `.txt` (and any
      // markdown without a heading) is titled by its file name.
      const isMarkdown = /\.md$/i.test(file.name);
      const { blocks, title, titleMd } = buildImportedPage(
        body,
        nameWithoutExt,
        isMarkdown,
      );

      const createdPage = await createPage({
        title,
        titleMd,
        parentId: opts.parentId ?? null,
        spaceId,
        ...(metadata?.task && { task: true }),
        ...(metadata?.scheduledAt && { scheduledAt: metadata.scheduledAt }),
        ...(metadata?.duration != null && { duration: metadata.duration }),
        ...(metadata?.allDay != null && { allDay: metadata.allDay }),
      });
      await platform.ops.writeBlocks(createdPage.id, blocks);
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
