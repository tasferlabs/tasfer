import { useState } from "react";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileText, FileCode, FileType, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePageSettings } from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";
import { serializeToMarkdown } from "@cypherkit/editor/serlization/serializer";
import { serializeToHTML } from "@cypherkit/editor/serlization/htmlSerializer";
import {
  getVisibleTextFromRuns,
  extractTitleFromBlocks,
} from "@cypherkit/editor/sync/char-runs";
import { type Block, type Image } from "@cypherkit/editor/serlization/loadPage";
import { imageCache } from "@cypherkit/editor/rendering/renderer";
import { getPlatform } from "@/platform";
import { getPage } from "../api/pages.api";
import type { PageMetadata } from "@cypherkit/editor/serlization/serializer";
import { downloadFile } from "@/downloadFile";
import { getBridge } from "@/platform/bridge";
import { isTextualBlock } from "@cypherkit/editor/sync/block-registry";
import { isListBlock } from "@cypherkit/editor/serlization/loadPage";

interface ElectronWindow {
  cypher?: { invoke(channel: string, ...args: unknown[]): Promise<unknown> };
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function serializeToText(blocks: Block[]): string {
  return blocks
    .filter((block) => !block.deleted)
    .map((block) => {
      if (block.type === "line") return "---";
      if (block.type === "image") return block.alt || "";
      if (isTextualBlock(block) || isListBlock(block)) {
        const text = getVisibleTextFromRuns(block.charRuns);
        if (block.type === "todo_list") {
          const checkbox = block.checked ? "[x]" : "[ ]";
          return `${checkbox} ${text}`;
        }
        return text;
      }
      return "";
    })
    .join("\n");
}

/** Guess file extension from mime type */
function extFromMime(mime: string): string {
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

/** Convert a cached HTMLImageElement to a Blob by drawing to an offscreen canvas */
function imageElementToBlob(img: HTMLImageElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      resolve(null);
      return;
    }
    ctx.drawImage(img, 0, 0);
    canvas.toBlob((blob) => resolve(blob), "image/png");
  });
}

/** Fetch an image blob, resolving asset hashes via the platform and falling back to imageCache. */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  const isAlreadyUrl =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://");

  // Resolve asset hashes (e.g. "assets/<hash>.png") to a real URL the same way the renderer does
  let resolvedUrl = url;
  if (!isAlreadyUrl) {
    try {
      resolvedUrl = await getPlatform().assets.getUrl(url);
    } catch {
      // ignore — fall through to fetch attempt / cache fallback
    }
  }

  try {
    const response = await fetch(resolvedUrl);
    if (response.ok) {
      const blob = await response.blob();
      if (blob.size > 0) return blob;
    }
  } catch {
    // fetch failed — fall through to imageCache
  }

  // Fallback: extract from the renderer's in-memory image cache (handles revoked blob URLs)
  const cached = imageCache.get(url);
  if (cached && cached.complete && cached.naturalWidth > 0) {
    return imageElementToBlob(cached);
  }

  return null;
}

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const { t } = useTranslation();
  const { currentBlocks, pageId } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");
  const [isExporting, setIsExporting] = useState(false);

  const getBaseName = () => {
    const title = extractTitleFromBlocks(currentBlocks) || "document";
    const sanitized = title
      .replace(/[<>:"/\\|?*]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100);
    return sanitized || "document";
  };

  const downloadTextFile = async (
    content: string,
    extension: string,
    mimeType: string,
  ) => {
    const blob = new Blob([content], { type: mimeType });
    await downloadFile(blob, `${getBaseName()}.${extension}`, mimeType);
    onOpenChange(false);
  };

  const handleExportTxt = () => {
    const content = serializeToText(currentBlocks);
    downloadTextFile(content, "txt", "text/plain");
  };

  const fetchMetadata = async (): Promise<PageMetadata | undefined> => {
    if (!pageId) return undefined;
    try {
      const pageData = await getPage(pageId);
      const meta: PageMetadata = {};
      if (pageData.task) meta.task = true;
      if (pageData.scheduledAt) meta.scheduledAt = pageData.scheduledAt;
      if (pageData.duration != null) meta.duration = pageData.duration;
      if (pageData.allDay != null) meta.allDay = pageData.allDay;
      if (pageData.color) meta.color = pageData.color;
      return Object.keys(meta).length > 0 ? meta : undefined;
    } catch {
      return undefined;
    }
  };

  const blobToDataUrl = (blob: Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(reader.result as string);
      reader.readAsDataURL(blob);
    });

  const buildExportHtml = async (): Promise<string> => {
    // Resolve image URLs to data URLs so they survive across windows / native renderers
    const imageUrlMap = new Map<string, string>();
    const seen = new Set<string>();
    for (const block of currentBlocks) {
      if (block.type === "image" && (block as Image).url) {
        const url = (block as Image).url;
        if (seen.has(url)) continue;
        seen.add(url);
        const blob = await fetchImageBlob(url);
        if (blob) {
          try {
            imageUrlMap.set(url, await blobToDataUrl(blob));
          } catch {
            // ignore — the image just won't render
          }
        }
      }
    }
    return serializeToHTML(currentBlocks, {
      title: getBaseName(),
      imageUrlMap,
    });
  };

  const printViaWindow = async (html: string) => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();

    const triggerPrint = async () => {
      const imgs = Array.from(win.document.images);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise<void>((resolve) => {
                img.onload = () => resolve();
                img.onerror = () => resolve();
              }),
        ),
      );
      win.focus();
      win.print();
    };

    if (win.document.readyState === "complete") await triggerPrint();
    else win.addEventListener("load", () => void triggerPrint());
  };

  const handleExportPdf = async () => {
    setIsExporting(true);
    try {
      const html = await buildExportHtml();
      const baseName = getBaseName();

      // Native (iOS/Android): render PDF in the WebView, then share via system sheet
      const bridge = getBridge();
      if (bridge?.files.htmlToPdf) {
        const pdfBase64 = await bridge.files.htmlToPdf(html);
        if (pdfBase64) {
          const blob = base64ToBlob(pdfBase64, "application/pdf");
          await downloadFile(blob, `${baseName}.pdf`, "application/pdf");
          onOpenChange(false);
          return;
        }
        // fall through to print-window fallback if native returned null
      }

      // Electron: silent printToPDF in main process, then download via existing flow
      const electron = (window as unknown as ElectronWindow).cypher;
      if (electron?.invoke) {
        const buf = (await electron.invoke(
          "pdf:generate",
          html,
        )) as ArrayBuffer;
        const blob = new Blob([buf], { type: "application/pdf" });
        await downloadFile(blob, `${baseName}.pdf`, "application/pdf");
        onOpenChange(false);
        return;
      }

      // Web fallback: open new window and trigger system print dialog
      await printViaWindow(html);
      onOpenChange(false);
    } finally {
      setIsExporting(false);
    }
  };

  const handleExportMarkdown = async () => {
    const metadata = await fetchMetadata();
    const markdown = serializeToMarkdown(currentBlocks, metadata);

    // Collect all image URLs from image blocks (handles blob:, /api/images/, etc.)
    const imageUrls = new Set<string>();
    for (const block of currentBlocks) {
      if (block.type === "image" && (block as Image).url) {
        imageUrls.add((block as Image).url);
      }
    }

    // No images → plain .md download
    if (imageUrls.size === 0) {
      downloadTextFile(markdown, "md", "text/markdown");
      return;
    }

    // Has images → create ZIP
    setIsExporting(true);
    try {
      const zip = new JSZip();
      const baseName = getBaseName();
      // Map: original URL → ZIP filename (e.g. "image_0.png")
      const urlToFileName = new Map<string, string>();
      let imgIndex = 0;

      for (const url of imageUrls) {
        const blob = await fetchImageBlob(url);
        if (blob) {
          const ext = extFromMime(blob.type);
          const fileName = `image_${imgIndex}.${ext}`;
          urlToFileName.set(url, fileName);
          zip.file(`images/${fileName}`, blob);
          imgIndex++;
        }
      }

      // Rewrite image URLs in markdown — replace each original URL with relative path
      let rewritten = markdown;
      for (const [originalUrl, fileName] of urlToFileName) {
        // Escape special regex chars in the URL
        const escaped = originalUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        rewritten = rewritten.replace(
          new RegExp(escaped, "g"),
          `./images/${fileName}`,
        );
      }

      zip.file(`${baseName}.md`, rewritten);

      const blob = await zip.generateAsync({ type: "blob" });
      await downloadFile(blob, `${baseName}.zip`, "application/zip");
      onOpenChange(false);
    } finally {
      setIsExporting(false);
    }
  };

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>
                {t("export.document", "Export document")}
              </DrawerTitle>
            </DrawerHeader>
            <div className="px-4 space-y-2">
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={handleExportTxt}
              >
                <FileText className="h-5 w-5 text-muted-foreground" />
                <div className="flex flex-col items-start">
                  <span className="font-medium">
                    {t("export.plainText", "Plain Text")}
                  </span>
                  <span className="text-xs text-muted-foreground">.txt</span>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={handleExportPdf}
                disabled={isExporting}
              >
                {isExporting ? (
                  <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                ) : (
                  <FileType className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="flex flex-col items-start">
                  <span className="font-medium">{t("export.pdf", "PDF")}</span>
                  <span className="text-xs text-muted-foreground">.pdf</span>
                </div>
              </Button>
              <Button
                variant="outline"
                className="w-full justify-start gap-3 h-auto py-3"
                onClick={handleExportMarkdown}
                disabled={isExporting}
              >
                {isExporting ? (
                  <Loader2 className="h-5 w-5 text-muted-foreground animate-spin" />
                ) : (
                  <FileCode className="h-5 w-5 text-muted-foreground" />
                )}
                <div className="flex flex-col items-start">
                  <span className="font-medium">
                    {isExporting
                      ? t("export.exporting", "Exporting...")
                      : t("common.markdown", "Markdown")}
                  </span>
                  <span className="text-xs text-muted-foreground">.md</span>
                </div>
              </Button>
            </div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("export.document", "Export document")}</DialogTitle>
          <DialogDescription>
            {t(
              "export.chooseFormat",
              "Choose a format to export your document",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <button
            onClick={handleExportTxt}
            className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer"
          >
            <FileText className="h-8 w-8 mb-2 text-muted-foreground" />
            <span className="font-medium">
              {t("export.plainText", "Plain Text")}
            </span>
            <span className="text-xs text-muted-foreground">.txt</span>
          </button>
          <button
            onClick={handleExportPdf}
            disabled={isExporting}
            className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? (
              <Loader2 className="h-8 w-8 mb-2 text-muted-foreground animate-spin" />
            ) : (
              <FileType className="h-8 w-8 mb-2 text-muted-foreground" />
            )}
            <span className="font-medium">{t("export.pdf", "PDF")}</span>
            <span className="text-xs text-muted-foreground">.pdf</span>
          </button>
          <button
            onClick={handleExportMarkdown}
            disabled={isExporting}
            className="flex flex-col items-center justify-center p-4 rounded-lg border-2 border-border hover:border-primary hover:bg-accent transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExporting ? (
              <Loader2 className="h-8 w-8 mb-2 text-muted-foreground animate-spin" />
            ) : (
              <FileCode className="h-8 w-8 mb-2 text-muted-foreground" />
            )}
            <span className="font-medium">
              {isExporting
                ? t("export.exporting", "Exporting...")
                : t("common.markdown", "Markdown")}
            </span>
            <span className="text-xs text-muted-foreground">.md</span>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
