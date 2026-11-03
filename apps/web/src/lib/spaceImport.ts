/**
 * Import markdown / text / ZIP files, or whole folders, into a space as pages.
 *
 * The shared import engine behind both the "Import all" dialog and the editor
 * drag-and-drop drop target. Keeping the page-tree reconstruction and the
 * markdown→blocks pipeline here (instead of inline in a dialog) means the two
 * entry points stay byte-for-byte consistent and there is one place to fix.
 *
 * A folder imports exactly like the ZIP you would get by compressing it: both
 * are read as a list of paths ({@link BundleEntry}) and share one tree builder.
 *
 * Pure (no React): callers drive progress through {@link ImportToSpaceOptions}
 * and translate {@link NoImportablePagesError} for display.
 */

import type { Block } from "@tasfer/editor/serlization/loadPage";
import { getPlatform } from "@/platform";
import { tokenizePage, parsePage, parseFrontmatter } from "@tasfer/editor";
import { deriveTitles, hasHeadingTitle } from "@/lib/pageTitle";
import { createPage, updatePage } from "@/app/api/pages.api";
import { uploadImage } from "@/app/api/images.api";
import { appDataSchema } from "@/appDataSchema";

/**
 * One file inside an imported bundle (a ZIP or a folder), addressed by its
 * slash-separated path inside the bundle. Content is read only when needed.
 */
interface BundleEntry {
  path: string;
  text: () => Promise<string>;
  blob: () => Promise<Blob>;
}

/** A file picked or dropped as part of a folder, with its path inside it. */
export interface FolderFile {
  /** Slash-separated, starting with the picked/dropped folder's own name. */
  path: string;
  file: File;
}

/** What the user chose to import: loose files, or the contents of folders. */
export type ImportSelection =
  { kind: "files"; files: File[] } | { kind: "folder"; files: FolderFile[] };

/** A page reconstructed from the bundle's folder layout. */
interface PageNode {
  name: string;
  /**
   * The entry backing this page's content, or null for a folder that has no
   * self-named markdown file (a plain directory of notes) — such a node
   * becomes an empty parent page.
   */
  entry: BundleEntry | null;
  /** Markdown keeps its own heading as the title; `.txt` is titled by name. */
  isMarkdown: boolean;
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

/** Thrown when a ZIP or folder contains no markdown/text files to import. */
export class NoImportablePagesError extends Error {
  constructor() {
    super("No importable pages found");
    this.name = "NoImportablePagesError";
  }
}

const DOC_EXTENSIONS = [".md", ".txt"];

function isDocPath(path: string): boolean {
  const lower = path.toLowerCase();
  return DOC_EXTENSIONS.some((e) => lower.endsWith(e));
}

/** Whether a file is one this importer accepts (markdown, text, or ZIP). */
export function isImportableSpaceFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith(".zip") || DOC_EXTENSIONS.some((e) => name.endsWith(e));
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isImagePath(path: string): boolean {
  return extensionOf(path) in IMAGE_MIME_TYPES;
}

/** Guess MIME type from file extension. */
function guessMimeType(fileName: string): string {
  return IMAGE_MIME_TYPES[extensionOf(fileName)] || "application/octet-stream";
}

/** The directory part of a bundle path ("A/B.md" → "A"), "" at the root. */
function dirnameOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Collapse `.` and `..` segments. A `..` past the root stays at the root. */
function normalizeBundlePath(path: string): string {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

/**
 * Finds the bundle image a page's link points at.
 *
 * Tried in order: the link resolved from the page's own folder (what an
 * export writes, and what most note tools write), then from the bundle's root
 * (`images/x.png` written from a nested page), then any image with the same
 * file name. When several share the name, the one closest to the page wins —
 * the most leading folders in common — and then the first by path, so the
 * choice never depends on drop order.
 */
function createImageResolver(imageEntries: BundleEntry[]) {
  const byPath = new Map<string, BundleEntry>();
  const byName = new Map<string, BundleEntry[]>();
  for (const entry of [...imageEntries].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    byPath.set(entry.path, entry);
    const name = entry.path.split("/").pop()!;
    const list = byName.get(name);
    if (list) list.push(entry);
    else byName.set(name, [entry]);
  }

  return (pagePath: string, url: string): BundleEntry | null => {
    // Only links into the bundle: no scheme (`https:`, `data:`), no
    // protocol-relative or absolute path, no in-page anchor.
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^[/#]/.test(url)) return null;
    let path = url.replace(/[?#].*$/, "");
    try {
      path = decodeURI(path);
    } catch {
      // A stray `%` — use the link as written.
    }
    if (!isImagePath(path)) return null;

    const pageDir = dirnameOf(pagePath);
    const fromPage = normalizeBundlePath(`${pageDir}/${path}`);
    const fromRoot = normalizeBundlePath(path);
    const exact = byPath.get(fromPage) ?? byPath.get(fromRoot);
    if (exact) return exact;

    const candidates = byName.get(path.split("/").pop()!);
    if (!candidates) return null;
    const pageParts = pageDir.split("/");
    let best = candidates[0];
    let bestShared = -1;
    for (const candidate of candidates) {
      const parts = candidate.path.split("/");
      let shared = 0;
      while (
        shared < pageParts.length &&
        shared < parts.length - 1 &&
        parts[shared] === pageParts[shared]
      ) {
        shared++;
      }
      if (shared > bestShared) {
        best = candidate;
        bestShared = shared;
      }
    }
    return best;
  };
}

type ImageResolver = ReturnType<typeof createImageResolver>;

/**
 * Every link target in markdown that can point at an image: `![alt](url)`
 * (with or without `<…>`), a reference definition `[id]: url`, and an HTML
 * `<img src="url">`. The first group is kept, the second is the target.
 */
const IMAGE_LINK_PATTERNS = [
  /(!\[[^\]\n]*\]\(\s*)(<[^>\n]+>|[^\s)]+)/g,
  /^(\s{0,3}\[[^\]\n]+\]:\s*)(<[^>\n]+>|\S+)/gm,
  /(<img\b[^>]*?\bsrc\s*=\s*["'])([^"']+)/gi,
];

function unwrapAngle(target: string): string {
  return target.startsWith("<") && target.endsWith(">")
    ? target.slice(1, -1)
    : target;
}

/** The bundle images a page links to. */
function linkedImages(
  markdown: string,
  pagePath: string,
  resolve: ImageResolver,
): BundleEntry[] {
  const found: BundleEntry[] = [];
  for (const pattern of IMAGE_LINK_PATTERNS) {
    for (const match of markdown.matchAll(pattern)) {
      const entry = resolve(pagePath, unwrapAngle(match[2]));
      if (entry) found.push(entry);
    }
  }
  return found;
}

/**
 * Replace each link to a bundle image with that image's uploaded asset id.
 * A link that resolves to nothing, or to an image that failed to upload, is
 * left as written.
 */
function rewriteImageUrls(
  markdown: string,
  pagePath: string,
  resolve: ImageResolver,
  assetIds: Map<string, string>,
): string {
  let out = markdown;
  for (const pattern of IMAGE_LINK_PATTERNS) {
    out = out.replace(pattern, (match, lead: string, target: string) => {
      const entry = resolve(pagePath, unwrapAngle(target));
      const id = entry && assetIds.get(entry.path);
      return id ? `${lead}${id}` : match;
    });
  }
  return out;
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
 * Build a page tree from bundle entries.
 * The export format uses space-level folders as the first segment.
 * We strip those and merge everything into the target space. (A compressed or
 * picked folder has its own name as the first segment, stripped the same way.)
 */
function buildPageTree(entries: BundleEntry[]): {
  imageEntries: BundleEntry[];
  roots: PageNode[];
} {
  const imageEntries: BundleEntry[] = [];
  const docFiles: Array<{ stripped: string; entry: BundleEntry }> = [];

  for (const entry of entries) {
    const relativePath = entry.path;
    if (isArchiveArtifact(relativePath)) continue;

    const parts = relativePath.split("/");
    const isDoc = isDocPath(relativePath);

    // Images can sit anywhere: an export keeps them in `images/` at its root,
    // note tools beside the note or in a folder of their own. Only the ones a
    // page links to are uploaded (see `importBundle`).
    if (!isDoc && isImagePath(relativePath)) {
      imageEntries.push(entry);
      continue;
    }

    if (!isDoc) continue;

    // Strip the first directory segment (space folder)
    if (parts.length >= 2) {
      docFiles.push({ stripped: parts.slice(1).join("/"), entry });
    } else {
      // No space folder — treat as root-level
      docFiles.push({ stripped: relativePath, entry });
    }
  }

  // Build a map from stripped path to its entry
  const entryMap = new Map<string, BundleEntry>();
  for (const f of docFiles) {
    entryMap.set(f.stripped, f.entry);
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
      nodes.push({
        name: file.replace(/\.(md|txt)$/i, ""),
        entry: entryMap.get(`${prefix}${file}`) ?? null,
        isMarkdown: /\.md$/i.test(file),
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
        nodes.push({
          name: dir,
          entry: entryMap.get(`${prefix}${dir}/${selfFile}`) ?? null,
          isMarkdown: true,
          children: fullChildren,
        });
      } else {
        // No self-named file (e.g. a plain directory of notes). Keep the
        // folder as an empty parent page so its structure is preserved,
        // rather than flattening its children up to this level.
        const innerNodes = buildLevelWithPrefix(contents, `${prefix}${dir}/`);
        nodes.push({
          name: dir,
          entry: null,
          isMarkdown: false,
          children: innerNodes,
        });
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

  const strippedPaths = docFiles.map((f) => f.stripped);
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

/** List a ZIP's files as bundle entries. */
async function zipEntries(file: File): Promise<BundleEntry[]> {
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries: BundleEntry[] = [];
  zip.forEach((path, entry) => {
    if (entry.dir) return;
    entries.push({
      path,
      text: () => entry.async("string"),
      blob: () => entry.async("blob"),
    });
  });
  return entries;
}

/**
 * List a picked or dropped folder's files as bundle entries, so the folder
 * imports exactly like the ZIP of it: that ZIP holds `Notes/…`, and the tree
 * strips the leading `Notes/` like a space folder.
 *
 * One exception: an extracted export. Unzipping an export that holds several
 * top-level entries (space folders plus `images/`) wraps them in one more
 * folder, which is not part of the export. A root folder with `images/` and no
 * pages of its own directly inside is that wrapper, and is dropped so the
 * export imports as its ZIP would.
 *
 * Hidden files and folders (`.git`, `.obsidian`, …) are tool data, not notes.
 */
function folderEntries(files: FolderFile[]): BundleEntry[] {
  const visible = files.filter(
    ({ path }) => !path.split("/").some((segment) => segment.startsWith(".")),
  );

  const rootsWithImages = new Set<string>();
  const rootsWithPages = new Set<string>();
  for (const { path } of visible) {
    const parts = path.split("/");
    if (parts.length >= 3 && parts[1] === "images") {
      rootsWithImages.add(parts[0]);
    }
    if (parts.length === 2 && isDocPath(path)) rootsWithPages.add(parts[0]);
  }

  return visible.map(({ path, file }) => {
    const [root, ...rest] = path.split("/");
    const isWrapper =
      rest.length > 0 && rootsWithImages.has(root) && !rootsWithPages.has(root);
    return {
      path: isWrapper ? rest.join("/") : path,
      text: () => file.text(),
      blob: async () => file,
    };
  });
}

/** Import a ZIP's or folder's files, rebuilding their page tree. */
async function importBundle(
  entries: BundleEntry[],
  spaceId: string,
  result: ImportToSpaceResult,
  opts: ImportToSpaceOptions,
): Promise<void> {
  const aborted = () => opts.isAborted?.() ?? false;

  const { imageEntries, roots } = buildPageTree(entries);

  if (roots.length === 0) {
    throw new NoImportablePagesError();
  }

  // Step 1: Read every page and find the images they link to, so an image
  // nothing links to (a folder of photos beside the notes) is not uploaded.
  const resolveImage = createImageResolver(imageEntries);
  const texts = new Map<BundleEntry, string>();
  const linked = new Set<BundleEntry>();
  async function readPages(nodes: PageNode[]): Promise<void> {
    for (const node of nodes) {
      if (aborted()) return;
      if (node.entry) {
        try {
          const text = await node.entry.text();
          texts.set(node.entry, text);
          for (const image of linkedImages(text, node.entry.path, resolveImage)) {
            linked.add(image);
          }
        } catch {
          // Step 3 reads it again and reports the failure against the page.
        }
      }
      await readPages(node.children);
    }
  }
  await readPages(roots);
  if (aborted()) return;

  const images = [...linked].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const total = countNodes(roots) + images.length;
  let done = 0;
  opts.onProgress?.({ done, total });

  // Step 2: Upload the linked images, keyed by their path in the bundle so two
  // images with one file name in different folders stay apart.
  const assetIds = new Map<string, string>();
  for (const entry of images) {
    if (aborted()) return;
    const fileName = entry.path.split("/").pop()!;
    try {
      const blob = await entry.blob();
      const imageFile = new File([blob], fileName, {
        type: guessMimeType(fileName),
      });
      const uploaded = await uploadImage(imageFile);
      assetIds.set(entry.path, uploaded.id);
      result.imagesUploaded++;
    } catch {
      result.errors.push(`Failed to upload image: ${fileName}`);
    }
    done++;
    opts.onProgress?.({ done, total });
  }

  // Step 3: Create pages top-down.
  const platform = getPlatform();
  async function createPages(
    nodes: PageNode[],
    parentId: string | null,
  ): Promise<void> {
    for (const node of nodes) {
      if (aborted()) return;
      try {
        if (!node.entry) {
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

        const content = texts.get(node.entry) ?? (await node.entry.text());
        const rewritten = rewriteImageUrls(
          content,
          node.entry.path,
          resolveImage,
          assetIds,
        );
        const { content: body, metadata } = parseFrontmatter(rewritten);
        const { blocks, title, titleMd } = buildImportedPage(
          body,
          node.name,
          node.isMarkdown,
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
 * Import a selection into `spaceId` as pages. A folder, or a single ZIP, is
 * expanded into its page tree (rebuilding parent/child structure and uploading
 * bundled images); loose markdown/text files each become a top-level page.
 * Throws {@link NoImportablePagesError} when a ZIP or folder has no
 * markdown/text inside.
 */
export async function importToSpace(
  selection: ImportSelection,
  spaceId: string,
  opts: ImportToSpaceOptions = {},
): Promise<ImportToSpaceResult> {
  const result: ImportToSpaceResult = {
    pagesCreated: 0,
    imagesUploaded: 0,
    firstPageId: null,
    errors: [],
  };

  if (selection.kind === "folder") {
    await importBundle(folderEntries(selection.files), spaceId, result, opts);
  } else if (
    selection.files.length === 1 &&
    selection.files[0].name.toLowerCase().endsWith(".zip")
  ) {
    const entries = await zipEntries(selection.files[0]);
    await importBundle(entries, spaceId, result, opts);
  } else {
    const docFiles = selection.files.filter((f) => isDocPath(f.name));
    await importMarkdownFiles(docFiles, spaceId, result, opts);
  }

  return result;
}
